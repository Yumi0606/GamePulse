import type { FastifyPluginAsync } from 'fastify';
import { entriesRoutes } from './entries.js';
import { eventsRoutes } from './events.js';
import { gamesRoutes } from './games.js';
import { healthRoutes } from './health.js';
import { metaRoutes } from './meta.js';
import { postsRoutes } from './posts.js';

/**
 * /api/v1 只读 JSON API 挂载点。
 *
 * 约束：
 * - 所有前端（本仓库 React 应用、监控看板、未来移动端）只通过本 API 或 /rss/* 消费数据，
 *   不得直连 data/feed.db。
 * - 只读：不提供写入、任务控制、队列调整能力。
 * - 响应 JSON 一律 camelCase、时间 Unix 秒；Zod schema 同时作为序列化白名单。
 */
export const apiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(metaRoutes);
  await app.register(gamesRoutes);
  await app.register(entriesRoutes);
  await app.register(postsRoutes);
  await app.register(eventsRoutes);
};
