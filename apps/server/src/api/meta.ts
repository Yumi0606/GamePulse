import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MetaDto } from '@gamepulse/shared';
import { loadMeta } from '../storage/store.js';

/** GET /api/v1/meta — 最近一次拉取批次统计；从未拉取时返回 null */
export const metaRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/meta',
    { schema: { response: { 200: MetaDto.nullable() } } },
    async () => loadMeta(),
  );
};
