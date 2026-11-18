// 必须最先 import：加载 .env，保证后续 logger/ocr/llm 等模块读到配置
import '../core/env.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { apiPlugin } from '../api/index.js';
import { installFatalHandlers, logger, moduleLogger } from '../core/logger.js';
import { startScheduler } from '../scheduler.js';
import { handleRssRequest } from './rss.js';

const log = moduleLogger('web');

/**
 * HTTP 服务入口：单端口同时提供前端、JSON API 与 RSS。
 *
 * - /api/v1/*  Fastify + Zod（前端唯一数据入口）
 * - /rss/*     RSS 产物（对外契约，长期保留）
 * - 其余 GET   开发形态交给 Vite 中间件；生产由 nginx 托管 apps/web/dist
 *
 * 单端口是硬约束：开发时前端用 Vite middlewareMode 挂到同一 Fastify 实例，
 * 生产由 nginx 托管前端构建产物并反代 /api 与 /rss。不要为验证另起端口。
 * 数据只读本地存储（data/feed.db），新鲜度由定时任务保证；请求不实时拉取。
 */
const PORT = Number(process.env.PORT ?? 3000);
/** 只读模式：命令行传入 --view-only，或环境变量 WEB_ONLY=1；不启动定时拉取与处理链 */
const VIEW_ONLY = process.argv.includes('--view-only') || process.env.WEB_ONLY === '1';
/** 开发模式：把 Vite 以 middlewareMode 挂进本实例，前端与 /api 共用 3000 端口 */
const WEB_DEV = process.argv.includes('--web-dev');

const app = Fastify({
  loggerInstance: logger,
});

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(apiPlugin, { prefix: '/api/v1' });

// RSS 是长期对外契约：始终由本进程提供，且优先于开发形态的前端兜底
async function rss(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.hijack();
  await handleRssRequest(request.raw, reply.raw);
}

app.get('/rss/*', rss);

// 开发形态：除 /api/v1 与 /rss/* 之外的 GET 交给 Vite（必须注册在兜底路由之前）
if (WEB_DEV) {
  const { attachViteDev } = await import('./dev.js');
  await attachViteDev(app as unknown as import('./dev.js').DevHost);
}

await app.listen({ port: PORT, host: process.env.HOST ?? '0.0.0.0' });

installFatalHandlers(); // 常驻服务进程级兜底：漏 catch 的 Promise 拒绝不再静默杀进程
log.info('Web 服务已启动 port=%d', PORT);
log.info('API: GET /api/v1/health | /meta | /games | /entries | /posts | /posts/:id/ocr | /events');
if (WEB_DEV) log.info('前端（开发）: GET /（Vite middlewareMode，修改前端代码热更新）');
else log.info('前端（生产）: 由 nginx 在根路径托管 apps/web/dist');
log.info('RSS: /rss/posts 原始动态 | /rss/entries 结构化条目（均可追加 /<gameId>）| /rss/post?id= 与 /rss/entry?id= 单条');

// 启动定时拉取：立即执行一次，之后按间隔刷新本地存储。
// 只读模式（pnpm viewonly 或 WEB_ONLY=1）：只展示本地存储，不拉取、不跑 OCR/LLM。
if (VIEW_ONLY) {
  log.info('只读模式：跳过定时拉取与处理链，仅展示本地数据');
} else {
  startScheduler();
}
