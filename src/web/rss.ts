import type { Game, Item, Entry, EntryType } from '../core/types.js';
import { ENTRY_TYPE_LABEL } from '../core/types.js';

/**
 * RSS 2.0 生成：两类订阅源。
 * - 原始动态（buildGameRss / buildAggregatedRss）：官号动态原文，v1 产物；
 * - 结构化条目（buildEntriesRss）：LLM 拆分出的活动/卡池/公告排期，v1.5 产物。
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

/** 生成单个游戏的 RSS 文档。条目按发布时间倒序。 */
export function buildGameRss(game: Game, items: Item[]): string {
  const sorted = [...items]
    .filter((i) => i.gameId === game.id)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const latest = sorted[0]?.publishedAt ?? Math.floor(Date.now() / 1000);

  const itemXml = sorted
    .map(
      (it) => `    <item>
      <title>${escapeXml(it.title)}</title>
      <link>${escapeXml(it.url)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${toRfc822(it.publishedAt)}</pubDate>
      ${it.author ? `<author>${escapeXml(it.author)}</author>` : ''}
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(game.name)}</title>
    <link>https://space.bilibili.com/${game.bilibiliUid}</link>
    <description>${escapeXml(game.name)} 官号动态聚合</description>
    <language>zh-cn</language>
    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>
${itemXml}
  </channel>
</rss>
`;
}

/** 生成全游戏聚合的原始动态 RSS（极简合并，channel 标题为聚合名）。条目按发布时间倒序。 */
export function buildAggregatedRss(items: Item[], channelTitle: string, channelLink: string): string {
  const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
  const itemXml = sorted
    .map(
      (it) => `    <item>
      <title>${escapeXml(it.title)}</title>
      <link>${escapeXml(it.url)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${toRfc822(it.publishedAt)}</pubDate>
      <category>${escapeXml(it.gameId)}</category>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>多游戏官号动态聚合</description>
    <language>zh-cn</language>
${itemXml}
  </channel>
</rss>
`;
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

/** 生成结构化条目的 RSS 文档（排期订阅源）。entries 由调用方排序/过滤。 */
export function buildEntriesRss(entries: Entry[], channelTitle: string, channelLink: string): string {
  const sorted = [...entries].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const latest = sorted[0]?.publishedAt ?? Math.floor(Date.now() / 1000);
  const itemXml = sorted
    .map((e) => {
      const label = ENTRY_TYPE_LABEL[e.type as EntryType] ?? e.type;
      return `    <item>
      <title>[${label}] ${escapeXml(e.title)}${e.payload.estimated ? '（预估）' : ''}</title>
      <link>${escapeXml(e.url ?? '')}</link>
      <guid isPermaLink="false">${escapeXml(e.id)}</guid>
      <pubDate>${toRfc822(e.publishedAt ?? latest)}</pubDate>
      <description>${escapeXml(entryDescription(e))}</description>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>LLM 从官号动态拆分的活动/卡池/公告排期（时间为游戏服务器时间=北京时间）</description>
    <language>zh-cn</language>
    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>
${itemXml}
  </channel>
</rss>
`;
}
