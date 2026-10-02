import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GAMES } from '../games.js';
import { startScheduler } from '../scheduler.js';
import { loadPosts, loadEntries, loadMeta, type FetchMeta, type StoredPost, type StoredEntry } from '../store.js';
import { buildGameRss } from '../rss.js';
import type { Item } from '../types.js';

/**
 * v1.5 Web 服务。
 * - GET /                      极简展示页（动态按游戏分组 + 结构化条目区块）
 * - GET /rss/<gameId>          单个游戏 RSS
 * - GET /rss                   全游戏聚合 RSS
 * 数据读本地存储（data/feed.db），由定时任务刷新，请求不再实时拉取。
 */
const PORT = Number(process.env.PORT ?? 3000);

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 格式化 Unix 秒为北京时间 "YYYY-MM-DD HH:mm"（游戏服务器时间=北京时间，固定时区不受部署环境影响） */
function fmtCst(unix: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unix * 1000)).replace(/\//g, '-');
}

/** 结构化条目区块（LLM 拆分产物：活动/卡池/公告，按结束时间升序） */
function renderEntries(entries: StoredEntry[]): string {
  if (entries.length === 0) {
    return `  <h2>结构化条目 <small>（暂无，等待 LLM 处理）</small></h2>`;
  }
  const TYPE_LABEL: Record<string, string> = {
    ACTIVITY: '活动', GACHA: '卡池', SHOP: '商店', COLLAB: '联动', ANNOUNCEMENT: '公告', NEWS: '动态',
  };
  const fmt = (unix?: number): string => (unix ? fmtCst(unix) : '—');
  const rows = entries
    .map((e) => {
      const game = GAMES.find((g) => g.id === e.gameId);
      const ref = e.payload.endRef ? `（${escapeHtml(e.payload.endRef.refText)}）` : '';
      const conf = e.payload.confidence < 0.7 ? ` <span class="low-conf">置信 ${e.payload.confidence.toFixed(1)}</span>` : '';
      return `      <li><span class="date">${fmt(e.startAt)} → ${fmt(e.endAt)}${ref}</span><span class="tag">${TYPE_LABEL[e.type] ?? e.type}</span>${escapeHtml(game?.name ?? e.gameId)}：<a href="${escapeHtml(e.url ?? '')}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>${conf}</li>`;
    })
    .join('\n');
  return `  <h2>结构化条目 <small>（${entries.length}）</small></h2>
  <ul class="entries">
${rows}
  </ul>`;
}

/** 极简展示页 */
function renderPage(items: Item[], meta: FetchMeta | null, entries: StoredEntry[]): string {
  // 头部状态行：条目数、最近拉取时间与结果
  let metaLine = '';
  if (meta) {
    const time = fmtCst(meta.lastRunAt);
    metaLine = ` · 最近拉取 ${time}（新增 ${meta.added} / 更新 ${meta.updated}，用时 ${(meta.durationMs / 1000).toFixed(1)}s）`;
  } else {
    metaLine = ' · 尚未拉取，等待定时任务';
  }
  const errorLine = meta && meta.errors.length > 0
    ? `\n  <p class="err">上次拉取失败：${meta.errors.map(escapeHtml).join('；')}</p>`
    : '';
  const sections = GAMES.map((game) => {
    const list = items
      .filter((i) => i.gameId === game.id)
      .sort((a, b) => b.publishedAt - a.publishedAt);
    const rows = list
      .map((it) => {
        const date = fmtCst(it.publishedAt);
        // 悬停显示正文前 200 字；有图时标注数量
        const tip = it.description ? escapeHtml(it.description.slice(0, 200)) : '';
        const imgs = it.images ? ` <span class="imgs">[图 x${it.images.length}]</span>` : '';
        return `      <li><span class="date">${date}</span><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" title="${tip}">${escapeHtml(it.title)}</a>${imgs}</li>`;
      })
      .join('\n');
    return `    <section>
      <h2>${escapeHtml(game.name)} <small>（${list.length}）</small></h2>
      <ul>
${rows}
      </ul>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>游戏动态聚合</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; border-left: 4px solid #f5712c; padding-left: 8px; margin-top: 28px; }
  h2 small { color: #888; font-weight: normal; }
  ul { list-style: none; padding: 0; }
  li { padding: 6px 0; border-bottom: 1px solid #f0f0f0; line-height: 1.5; }
  .date { display: inline-block; width: 130px; color: #888; font-size: 13px; font-variant-numeric: tabular-nums; }
  a { color: #1a5fb4; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .err { color: #c01c28; font-size: 13px; }
  .imgs { color: #888; font-size: 12px; }
  .tag { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 3px; background: #eef3fa; color: #1a5fb4; font-size: 12px; }
  .low-conf { color: #c01c28; font-size: 12px; }
</style>
</head>
<body>
  <h1>游戏官号动态聚合</h1>
  <p>共 ${items.length} 条${metaLine} · <a href="/rss">聚合 RSS</a></p>${errorLine}
${renderEntries(entries)}
${sections}
</body>
</html>
`;
}

/** 全游戏聚合 RSS（极简合并，channel 标题为聚合名） */
function buildAggregatedRss(items: Item[]): string {
  const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
  const itemXml = sorted
    .map(
      (it) => `    <item>
      <title>${escapeHtml4Rss(it.title)}</title>
      <link>${it.url}</link>
      <guid isPermaLink="false">${it.id}</guid>
      <pubDate>${new Date(it.publishedAt * 1000).toUTCString()}</pubDate>
      <category>${it.gameId}</category>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>游戏动态聚合</title>
    <link>http://localhost:${PORT}</link>
    <description>多游戏官号动态聚合</description>
    <language>zh-cn</language>
${itemXml}
  </channel>
</rss>
`;
}

function escapeHtml4Rss(t: string): string {
  return escapeHtml(t).replace(/'/g, '&#39;');
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = req.url?.split('?')[0] ?? '/';
  try {
    // 只读本地存储；数据新鲜度由定时任务保证
    const items: StoredPost[] = await loadPosts();
    const meta = await loadMeta();

    if (path === '/') {
      const entries: StoredEntry[] = await loadEntries();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage(items, meta, entries));
      return;
    }

    if (path === '/rss') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildAggregatedRss(items));
      return;
    }

    const m = path.match(/^\/rss\/([\w-]+)$/);
    if (m) {
      const game = GAMES.find((g) => g.id === m[1]);
      if (!game) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('未知游戏');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildGameRss(game, items));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`服务器错误：${(e as Error).message}`);
  }
});

server.listen(PORT, () => {
  console.log('v1 Web 服务已启动：http://localhost:%d', PORT);
  console.log('  展示页  http://localhost:%d/', PORT);
  console.log('  聚合RSS http://localhost:%d/rss', PORT);
  for (const g of GAMES) console.log('  %s RSS http://localhost:%d/rss/%s', g.name, PORT, g.id);
  // 启动定时拉取：立即执行一次，之后按间隔刷新本地存储
  startScheduler();
});
