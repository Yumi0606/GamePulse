// 必须最先 import：加载 .env，保证后续 logger/ocr/llm 等模块读到配置
import '../core/env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GAMES } from '../core/games.js';
import { startScheduler } from '../scheduler.js';
import { installFatalHandlers, moduleLogger } from '../core/logger.js';
import { loadPosts, loadEntries, loadMeta, listEvents, countUnresolvedEvents, countPendingExtract, countUnrecognizedImages, latestUnresolvedEvent, loadOcrRecords } from '../storage/store.js';
import { buildGameRss, buildAggregatedRss, buildEntriesRss, buildSinglePostRss, buildSingleEntryRss } from './rss.js';
import { renderPage, renderCalendar, renderHealth, parseMonth } from './page.js';

const log = moduleLogger('web');

/**
 * v1.5 Web 服务：展示层路由。
 *
 * 页面（列表/日历/源健康三种视图）：
 * - GET /                列表视图（概览 + 异常报告 + 筛选 + 结构化条目 + 原始动态；筛选由内联脚本就地过滤）
 * - GET /calendar        日历视图（按北京时间铺当月排期，?month=YYYY-MM 翻月）
 * - GET /health          源健康视图（拉取异常记录 + 自动恢复状态）
 *
 * RSS 订阅（原始动态与解析后条目分路径）：
 * - GET /rss/posts           原始动态聚合 RSS（全部游戏）
 * - GET /rss/posts/<gameId>  原始动态 RSS（单游戏）
 * - GET /rss/entries         结构化条目 RSS（全部游戏）
 * - GET /rss/entries/<gameId> 结构化条目 RSS（单游戏）
 * - GET /rss/post?id=<postId>   单条原始动态 RSS
 * - GET /rss/entry?id=<entryId> 单条结构化条目 RSS（entry id 含 / 与 :，故用查询参数）
 *
 * 数据只读本地存储（data/feed.db），新鲜度由定时任务保证；请求不实时拉取。
 */
const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // 解析路径与查询（month 等参数）；只读本地存储
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;
  try {
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
      res.end(buildEntriesRss(entries, '游戏活动排期（结构化）', `${BASE}/`));
      return;
    }

    const me = path.match(/^\/rss\/entries\/([\w-]+)$/);
    if (me) {
      const game = GAMES.find((g) => g.id === me[1]);
      if (!game) return notFound(res, '未知游戏');
      const entries = (await loadEntries()).filter((e) => e.gameId === game.id);
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(buildEntriesRss(entries, `${game.name} 活动排期`, `${BASE}/`));
      return;
    }

    // ---- RSS：单条（?id= 查询参数；entry id 含 / 与 : 无法作路径段） ----
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
      res.end(buildSingleEntryRss(entry, `${BASE}${path}?id=${encodeURIComponent(entry.id)}`));
      return;
    }

    notFound(res, 'Not Found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`服务器错误：${(e as Error).message}`);
  }
});

function notFound(res: ServerResponse, text: string): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

server.listen(PORT, () => {
  installFatalHandlers(); // 常驻服务进程级兜底：漏 catch 的 Promise 拒绝不再静默杀进程
  log.info('Web 服务已启动 port=%d', PORT);
  log.info('页面: GET / 列表视图 | GET /calendar?month=YYYY-MM 日历视图 | GET /health 源健康');
  log.info('RSS: /rss/posts 原始动态 | /rss/entries 结构化条目（均可追加 /<gameId>）| /rss/post?id= 与 /rss/entry?id= 单条');
  // 启动定时拉取：立即执行一次，之后按间隔刷新本地存储
  startScheduler();
});
