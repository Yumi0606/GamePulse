import type { Game, Item, Entry, TimeRef, EntryPhase } from '../core/types.js';
import { ENTRY_TYPE_LABEL } from '../core/types.js';

/**
 * RSS 2.0 生成：两类订阅源。
 * - 原始动态（buildGameRss / buildAggregatedRss）：官号动态原文，v1 产物；
 * - 结构化条目（buildEntriesRss）：LLM 拆分出的活动/卡池/公告排期，v1.5 产物。
 * 单条 feed（buildSinglePostRss / buildSingleEntryRss）供展示层"查看该条数据的 RSS 格式"入口。
 * item 级 XML 由 postItemXml / entryItemXml 统一生成，聚合 feed 与单条 feed 共用。
 *
 * 机读字段承载于自定义命名空间 gp（urn:gamepulse:rss:1）：RSS 2.0 无排期/分段/引用型时间的标准词汇，
 * 故用扩展元素表达；标准阅读器忽略未知命名空间元素，仅展示 title/description/pubDate。
 * 约定：gp 内所有时间元素一律为 Unix 秒整数（与存储层一致），消费方自行决定时区展示。
 * 排除内部库存/质检元数据（firstSeenAt、updatedAt、confidence、provenance、source、sourceId、extra）。
 */

/** XML 转义（文本节点与属性通用的最小集合） */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** RFC-822 格式时间，如 RSS pubDate 要求 */
function toRfc822(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

/** 北京时间 "YYYY-MM-DD HH:mm"（条目 description 展示用） */
function fmtCst(unix: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(unix * 1000));
}

/** RSS 文档骨架：给定 channel 元信息与已生成的 item XML */
function rssDoc(channel: { title: string; link: string; description: string; lastBuildDate?: number }, itemXml: string): string {
  const lb = channel.lastBuildDate !== undefined
    ? `\n    <lastBuildDate>${toRfc822(channel.lastBuildDate)}</lastBuildDate>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:gp="urn:gamepulse:rss:1">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <description>${escapeXml(channel.description)}</description>
    <language>zh-cn</language>${lb}
${itemXml}
  </channel>
</rss>
`;
}

/** 生成一行 gp 扩展元素（含缩进）；值为空则不输出该行 */
function gpLine(indent: string, tag: string, value: string | number | undefined): string {
  if (value === undefined || value === '') return '';
  return `${indent}<${tag}>${escapeXml(String(value))}</${tag}>`;
}

/** 生成一行引用型时间元素；state 必填，refId 有值才作为属性输出 */
function refLine(indent: string, tag: string, ref?: TimeRef): string {
  if (!ref) return '';
  const attrs = [`state="${ref.state}"`];
  if (ref.refId) attrs.push(`refId="${escapeXml(ref.refId)}"`);
  return `${indent}<${tag} ${attrs.join(' ')}>${escapeXml(ref.refText)}</${tag}>`;
}

/** 生成单个活动分段的 gp:phase 元素（含段级引用型时间与预估标记） */
function phaseLines(p: EntryPhase): string[] {
  const attrs = [`index="${p.index}"`];
  if (p.estimated) attrs.push('estimated="true"');
  const lines = [`        <gp:phase ${attrs.join(' ')}>`];
  const push = (l: string): void => { if (l) lines.push(l); };
  push(gpLine('          ', 'gp:title', p.title));
  push(gpLine('          ', 'gp:startAt', p.startAt));
  push(gpLine('          ', 'gp:endAt', p.endAt));
  push(refLine('          ', 'gp:startRef', p.startRef));
  push(refLine('          ', 'gp:endRef', p.endRef));
  lines.push('        </gp:phase>');
  return lines;
}

/** 单条原始动态的 RSS item（聚合 feed 与单条 feed 共用）；机读字段经 gp 命名空间输出 */
function postItemXml(it: Item): string {
  const author = it.author ? `\n      <author>${escapeXml(it.author)}</author>` : '';
  const desc = it.description ? `\n      <description>${escapeXml(it.description)}</description>` : '';
  const gameId = `\n      <gp:gameId>${escapeXml(it.gameId)}</gp:gameId>`;
  const images = (it.images ?? []).map((url) => `\n      <gp:image>${escapeXml(url)}</gp:image>`).join('');
  return `    <item>
      <title>${escapeXml(it.title)}</title>
      <link>${escapeXml(it.url)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${toRfc822(it.publishedAt)}</pubDate>${author}${desc}${gameId}${images}
    </item>`;
}

/**
 * 单条结构化条目的 RSS item。
 * pubDateFallback：条目无发布时间时的回退值；
 * sourcePost：来源动态，用于在条目无 url 时补链接并输出 gp:sourcePost 溯源。
 */
function entryItemXml(e: Entry, pubDateFallback: number, sourcePost?: Item): string {
  const label = ENTRY_TYPE_LABEL[e.type] ?? e.type;
  const link = e.url ?? sourcePost?.url;
  const lines: string[] = [
    '    <item>',
    `      <title>[${label}] ${escapeXml(e.title)}${e.payload.estimated ? '（预估）' : ''}</title>`,
  ];
  if (link) lines.push(`      <link>${escapeXml(link)}</link>`);
  lines.push(`      <guid isPermaLink="false">${escapeXml(e.id)}</guid>`);
  lines.push(`      <pubDate>${toRfc822(e.publishedAt ?? pubDateFallback)}</pubDate>`);
  lines.push(`      <description>${escapeXml(entryDescription(e))}</description>`);

  const push = (l: string): void => { if (l) lines.push(l); };
  push(gpLine('      ', 'gp:gameId', e.gameId));
  push(gpLine('      ', 'gp:type', e.type));
  push(gpLine('      ', 'gp:category', e.payload.category));
  push(gpLine('      ', 'gp:startAt', e.startAt));
  push(gpLine('      ', 'gp:endAt', e.endAt));
  push(gpLine('      ', 'gp:rewardEndAt', e.payload.rewardEndAt));
  if (e.payload.estimated) lines.push('      <gp:estimated/>');
  push(gpLine('      ', 'gp:summary', e.payload.summary));
  push(gpLine('      ', 'gp:description', e.payload.description));
  push(gpLine('      ', 'gp:banner', e.payload.banner?.url));
  for (const tag of e.payload.tags ?? []) push(gpLine('      ', 'gp:tag', tag));
  push(refLine('      ', 'gp:startRef', e.payload.startRef));
  push(refLine('      ', 'gp:endRef', e.payload.endRef));
  if (e.payload.phases?.length) {
    lines.push('      <gp:phases>');
    for (const p of e.payload.phases) lines.push(...phaseLines(p));
    lines.push('      </gp:phases>');
  }
  if (sourcePost) {
    lines.push(`      <gp:sourcePost id="${escapeXml(sourcePost.id)}" url="${escapeXml(sourcePost.url)}">${escapeXml(sourcePost.title)}</gp:sourcePost>`);
  }
  lines.push('    </item>');
  return lines.join('\n');
}

/** 生成单个游戏的 RSS 文档。条目按发布时间倒序。 */
export function buildGameRss(game: Game, items: Item[]): string {
  const sorted = [...items]
    .filter((i) => i.gameId === game.id)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const latest = sorted[0]?.publishedAt ?? Math.floor(Date.now() / 1000);

  return rssDoc(
    {
      title: game.name,
      link: `https://space.bilibili.com/${game.bilibiliUid}`,
      description: `${game.name} 官号动态聚合`,
      lastBuildDate: latest,
    },
    sorted.map((it) => postItemXml(it)).join('\n'),
  );
}

/** 生成全游戏聚合的原始动态 RSS（极简合并，channel 标题为聚合名）。条目按发布时间倒序。 */
export function buildAggregatedRss(items: Item[], channelTitle: string, channelLink: string): string {
  const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
  return rssDoc(
    { title: channelTitle, link: channelLink, description: '多游戏官号动态聚合' },
    sorted.map((it) => postItemXml(it)).join('\n'),
  );
}

/** 单条结构化条目的 RSS item 展示文本：时间 + 分段 + 奖励截止 + 待锚定引用 */
function entryDescription(e: Entry): string {
  const fmt = (u?: number): string => (u ? fmtCst(u) : '—');
  const parts = [`时间：${fmt(e.startAt)} → ${fmt(e.endAt)}${e.payload.estimated ? '（预估）' : ''}`];
  if (e.payload.summary) parts.push(e.payload.summary);
  if (e.payload.phases?.length) {
    parts.push(`分段：${e.payload.phases.map((p) => `#${p.index} ${p.title ?? ''} ${fmt(p.startAt)}→${fmt(p.endAt)}`).join('；')}`);
  }
  if (e.payload.rewardEndAt) parts.push(`奖励截止：${fmtCst(e.payload.rewardEndAt)}`);
  const refs = [e.payload.startRef?.refText, e.payload.endRef?.refText].filter((s): s is string => Boolean(s));
  if (refs.length > 0) parts.push(`待锚定：${refs.join('；')}`);
  if (e.payload.confidence < 0.7) parts.push(`（置信 ${e.payload.confidence.toFixed(1)}）`);
  return parts.join('；');
}

/** 生成结构化条目的 RSS 文档（排期订阅源）。entries 由调用方排序/过滤；postById 用于补条目链接与来源动态溯源。 */
export function buildEntriesRss(entries: Entry[], channelTitle: string, channelLink: string, postById: Map<string, Item>): string {
  const sorted = [...entries].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const latest = sorted[0]?.publishedAt ?? Math.floor(Date.now() / 1000);
  return rssDoc(
    {
      title: channelTitle,
      link: channelLink,
      description: 'LLM 从官号动态拆分的活动/卡池/公告排期（时间为游戏服务器时间=北京时间）',
      lastBuildDate: latest,
    },
    sorted.map((e) => entryItemXml(e, latest, e.postId ? postById.get(e.postId) : undefined)).join('\n'),
  );
}

/** 单条原始动态的 RSS 文档（channel 标题取动态标题，便于在阅读器中辨认） */
export function buildSinglePostRss(post: Item, channelLink: string): string {
  return rssDoc(
    {
      title: post.title,
      link: channelLink,
      description: `原始动态（${post.gameId}）`,
      lastBuildDate: post.publishedAt,
    },
    postItemXml(post),
  );
}

/** 单条结构化条目的 RSS 文档；sourcePost 用于补条目链接与来源动态溯源 */
export function buildSingleEntryRss(entry: Entry, channelLink: string, sourcePost?: Item): string {
  const label = ENTRY_TYPE_LABEL[entry.type] ?? entry.type;
  const latest = entry.publishedAt ?? Math.floor(Date.now() / 1000);
  return rssDoc(
    {
      title: `[${label}] ${entry.title}`,
      link: channelLink,
      description: `结构化条目（${entry.gameId}）`,
      lastBuildDate: latest,
    },
    entryItemXml(entry, latest, sourcePost),
  );
}
