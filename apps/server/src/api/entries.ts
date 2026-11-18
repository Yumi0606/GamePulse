import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ENTRY_LIFECYCLE_FILTERS, ENTRY_STATUSES, ENTRY_TYPES, EntryPageDto, EntrySortSchema } from '@gamepulse/shared';
import { queryEntries } from '../storage/store.js';
import { toEntryDto } from './mappers.js';
import { csvParam, enumListParam, intParam, limitParam, offsetParam } from './query.js';

/**
 * GET /api/v1/entries — 结构化条目分页查询。
 *
 * 过滤：
 * - gameId / type / status 支持重复参数或逗号分隔
 * - q 关键词匹配标题、摘要、规范名
 * - from / to 为活动区间重叠条件（条目 [startAt, endAt]，endAt 为空视为常驻）
 * - rewardFrom / rewardTo 按奖励截止过滤，日历视图取数用
 * 排序：sort ∈ end|start|published|duration，每项以 id 兜底，翻页不抖动。
 */
const EntriesQuery = z.object({
  gameId: csvParam,
  type: enumListParam(ENTRY_TYPES),
  status: enumListParam(ENTRY_STATUSES),
  /** 生命周期筛选；unjudged 表示未判定（排除公告） */
  lifecycle: enumListParam(ENTRY_LIFECYCLE_FILTERS),
  /** 按条目 id 取单条：日历/周视图深链跳回列表用 */
  id: csvParam,
  q: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).optional()),
  from: intParam(),
  to: intParam(),
  rewardFrom: intParam(),
  rewardTo: intParam(),
  sort: EntrySortSchema.default('end'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: limitParam,
  offset: offsetParam,
});

export const entriesRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/entries',
    { schema: { querystring: EntriesQuery, response: { 200: EntryPageDto } } },
    async (request) => {
      const q = request.query;
      const now = Math.floor(Date.now() / 1000);
      const { items, total } = await queryEntries(
        {
          gameIds: q.gameId,
          types: q.type,
          statuses: q.status,
          lifecycles: q.lifecycle,
          ids: q.id,
          q: q.q,
          from: q.from,
          to: q.to,
          rewardFrom: q.rewardFrom,
          rewardTo: q.rewardTo,
          sort: q.sort,
          order: q.order,
          limit: q.limit,
          offset: q.offset,
        },
        now,
      );
      return {
        items: items.map((e) => toEntryDto(e, now)),
        total,
        limit: q.limit,
        offset: q.offset,
        sort: q.sort,
        order: q.order,
      };
    },
  );
};
