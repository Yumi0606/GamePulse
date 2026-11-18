import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HealthDto } from '@gamepulse/shared';
import { GAMES } from '../core/games.js';
import {
  countExtractBacklog,
  countOcrImageBacklog,
  countUnjudgedLifecycle,
  countUnresolvedEvents,
  latestUnresolvedEvent,
  loadMeta,
} from '../storage/store.js';
import { schedulerStatus } from '../scheduler.js';

/**
 * GET /api/v1/health — 项目状态聚合（只读）。
 *
 * 聚合四类事实：调度循环状态（开关、调度方式、上次/下次触发）、游戏启用数、
 * 处理链积压、源健康事件，外加最近一次拉取统计。前端健康页一次请求即可渲染全貌。
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    { schema: { response: { 200: HealthDto } } },
    async () => {
      const [meta, extractBacklog, ocrBacklog, unresolved, latest, unjudgedLifecycle] = await Promise.all([
        loadMeta(),
        countExtractBacklog(),
        countOcrImageBacklog(),
        countUnresolvedEvents(),
        latestUnresolvedEvent(),
        countUnjudgedLifecycle(),
      ]);
      const scan = schedulerStatus();
      return {
        now: Math.floor(Date.now() / 1000),
        scan: {
          // 只读模式不启动定时循环，两个 started 均为 false
          enabled: scan.fetch.started,
          fetch: scan.fetch,
          process: scan.process,
        },
        games: {
          enabled: GAMES.filter((g) => g.enabled).length,
          total: GAMES.length,
        },
        backlog: {
          postsToExtract: extractBacklog.pending,
          imagesToOcr: ocrBacklog.pending,
          deadImages: ocrBacklog.dead,
          abandonedPosts: extractBacklog.abandoned,
        },
        quality: {
          // 公告生命周期不适用，已在计数中排除
          unjudgedLifecycle,
        },
        events: {
          unresolved: unresolved.total,
          cookieSuspect: unresolved.cookieSuspect,
          latest,
        },
        meta,
      };
    },
  );
};
