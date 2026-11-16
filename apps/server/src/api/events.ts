import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { EventListDto } from '@gamepulse/shared';
import { listEvents } from '../storage/store.js';

/**
 * GET /api/v1/events — 源健康事件列表（只读）。
 *
 * 健康页需要完整事件明细，/health 只给聚合计数与最新一条。
 * 存储层自身限制最多返回最近 200 条，这里不再叠加分页参数。
 */
export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/events',
    { schema: { response: { 200: EventListDto } } },
    async () => ({ items: await listEvents() }),
  );
};
