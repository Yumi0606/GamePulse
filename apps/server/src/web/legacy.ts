import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { GAMES } from '../core/games.js';
import {
  loadPosts,
  loadEntries,
  loadMeta,
  loadOcrRecords,
  listEvents,
  countUnresolvedEvents,
  countPendingExtract,
  countUnrecognizedImages,
  latestUnresolvedEvent,
} from '../storage/store.js';
import { buildGameRss, buildAggregatedRss, buildEntriesRss, buildSinglePostRss, buildSingleEntryRss } from './rss.js';
import { renderPage, renderCalendar, renderHealth, parseMonth } from './page.js';
import { renderWeek } from './week.js';

/**
 * 旧版展示层请求处理（重构过渡期保留）。
 *
 * 页面：
 * - GET /                列表视图（概览 + 异常报告 + 筛选 + 结构化条目 + 原始动态）
 * - GET /calendar        日历视图（?month=YYYY-MM 翻月）
 * - GET /week?from=...   周视图
 * - GET /health          源健康视图（旧版 HTML）
 *
 * RSS（对外契约，永久保留）：
 * - GET /rss/posts、/rss/posts/<gameId>
 * - GET /rss/entries、/rss/entries/<gameId>
 * - GET /rss/post?id=、/rss/entry?id=（entry id 含 / 与 :，无法作路径段）
 *
 * 静态资源：/assets/{calendar.css,calendar.js,week.css,week.js}
 *
 * 新前端迁完、线上观察期满后，本文件随 page.ts / week.ts / assets 一起删除；
 * 在此之前禁止在此新增页面功能，只修 bug。
 */

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;

// 静态资源从源码目录读取：tsc 不拷贝 .js/.css，故运行时不依赖 dist。
// dist/web/legacy.js 与 src/web/legacy.ts（tsx）两种运行方式均解析到 <项目根>/apps/server/src/web/assets/。
// 每次请求按需读取磁盘，不缓存，便于本地开发时修改 CSS/JS 后刷新即生效。
const ASSET_DIR = new URL('../../src/web/assets/', import.meta.url);
const ASSET_TYPES: Record<string, string> = {
  '/assets/calendar.css': 'text/css; charset=utf-8',
  '/assets/calendar.js': 'text/javascript; charset=utf-8',
  '/assets/week.css': 'text/css; charset=utf-8',
  '/assets/week.js': 'text/javascript; charset=utf-8',
};

function readAsset(path: string): { body: string; type: string } | null {
  const type = ASSET_TYPES[path];
  if (!type) return null;
  const file = path.slice('/assets/'.length);
  return { body: readFileSync(new URL(file, ASSET_DIR), 'utf8'), type };
}

/** 处理一个旧版请求；响应直接写入 res（调用方应先 hijack Fastify 的 reply） */
export async function handleLegacyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 解析路径与查询（month 等参数）；只读本地存储
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;
  try {
    // 静态资源优先于数据库读取（/assets/* 无需访问 store）
    const asset = readAsset(path);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
      res.end(asset.body);
      return;
    }

    const posts = await loadPosts();

    // ---- 页面 ----
    if (path === '/') {
      const [meta, entries, unresolved, pendingExtract, unrecognizedImages, latestEvent, ocr] = await Promise.all([
        loadMeta(), loadEntries(), countUnresolvedEvents(), countPendingExtract(), countUnrecognizedImages(), latestUnresolvedEvent(), loadOcrRecords(),
      ]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage({ posts, meta, entries, unresolved, pendingExtract, unrecognizedImages, latestEvent, ocr }));
      return;
    }

    if (path === '/calendar') {
      const entries = await loadEntries();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderCalendar(entries, parseMonth(url.searchParams.get('month'))));
      return;
    }

    if (path === '/week') {
      const [entries, weekPosts] = await Promise.all([loadEntries(), loadPosts()]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderWeek(entries, weekPosts, url.searchParams.get('from')));
      return;
    }

    if (path === '/health') {
      const events = await listEvents();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderHealth(events));
      return;
    }

    // ---- RSS：原始动态 ----
    if (path === '/rss/posts') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildAggregatedRss(posts, '游戏动态聚合', `${BASE}/`));
      return;
    }

    const m = path.match(/^\/rss\/posts\/([\w-]+)$/);
    if (m) {
      const game = GAMES.find((g) => g.id === m[1]);
      if (!game) return notFound(res, '未知游戏');
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildGameRss(game, posts));
      return;
    }

    // ---- RSS：结构化条目（解析后） ----
    if (path === '/rss/entries') {
      const entries = await loadEntries();
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildEntriesRss(entries, '游戏活动排期（结构化）', `${BASE}/`, new Map(posts.map((p) => [p.id, p]))));
      return;
    }

    const me = path.match(/^\/rss\/entries\/([\w-]+)$/);
    if (me) {
      const game = GAMES.find((g) => g.id === me[1]);
      if (!game) return notFound(res, '未知游戏');
      const entries = (await loadEntries()).filter((e) => e.gameId === game.id);
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildEntriesRss(entries, `${game.name} 活动排期`, `${BASE}/`, new Map(posts.map((p) => [p.id, p]))));
      return;
    }

    // ---- RSS：单条（?id= 查询参数） ----
    if (path === '/rss/post') {
      const id = url.searchParams.get('id');
      const post = id ? posts.find((p) => p.id === id) : undefined;
      if (!post) return notFound(res, '未找到该动态');
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildSinglePostRss(post, `${BASE}${path}?id=${encodeURIComponent(post.id)}`));
      return;
    }

    if (path === '/rss/entry') {
      const id = url.searchParams.get('id');
      const entry = id ? (await loadEntries()).find((e) => e.id === id) : undefined;
      if (!entry) return notFound(res, '未找到该条目');
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      const sourcePost = entry.postId ? posts.find((p) => p.id === entry.postId) : undefined;
      res.end(buildSingleEntryRss(entry, `${BASE}${path}?id=${encodeURIComponent(entry.id)}`, sourcePost));
      return;
    }

    notFound(res, 'Not Found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`服务器错误：${(e as Error).message}`);
  }
}

function notFound(res: ServerResponse, text: string): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
