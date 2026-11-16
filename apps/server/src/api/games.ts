import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { GamesDto } from '@gamepulse/shared';
import { GAMES } from '../core/games.js';

/**
 * GET /api/v1/games — 游戏清单（含启用状态，停用游戏也返回，供筛选器标注）。
 *
 * 前端不得静态 import 游戏清单：id 与展示名的唯一来源是服务端 core/games.ts，
 * 将来改为配置化时前端无需改动。
 */
export const gamesRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/games',
    { schema: { response: { 200: GamesDto } } },
    async () => ({ items: GAMES }),
  );
};
