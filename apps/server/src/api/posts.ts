import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PostPageDto, PostOcrDto } from '@gamepulse/shared';
import { loadOcrForPost, queryPosts } from '../storage/store.js';
import { toPostDto } from './mappers.js';
import { csvParam, intParam, limitParam, offsetParam } from './query.js';

/**
 * 原始社媒动态查询。
 *
 * - GET /api/v1/posts            分页列表，固定按发布时间倒序
 * - GET /api/v1/posts/:id/ocr    单条动态的图片 OCR 明细
 *
 * OCR 文本不放进列表：单条动态可带多张长图，文本量大，按需拉取。
 * 动态 id 形如 `arknights:NEWS:123456`（含冒号、不含斜杠），可安全作为路径参数；
 * 条目 id 含斜杠，故条目侧不使用路径参数。
 */
const PostsQuery = z.object({
  gameId: csvParam,
  /** 按 id 批量取；与其它条件同时生效（列表页解析条目来源标题） */
  id: csvParam,
  q: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).optional()),
  from: intParam(),
  to: intParam(),
  limit: limitParam,
  offset: offsetParam,
});

export const postsRoutes: FastifyPluginAsync = async (app) => {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/posts', { schema: { querystring: PostsQuery, response: { 200: PostPageDto } } }, async (request) => {
    const q = request.query;
    const { items, total } = await queryPosts({
      gameIds: q.gameId,
      ids: q.id,
      q: q.q,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    });
    return { items: items.map(toPostDto), total, limit: q.limit, offset: q.offset };
  });

  server.get(
    '/posts/:id/ocr',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: PostOcrDto, 404: z.object({ message: z.string() }) },
      },
    },
    async (request, reply) => {
      const images = await loadOcrForPost(request.params.id);
      if (!images) {
        return reply.code(404).send({ message: '未找到该动态' });
      }
      return { postId: request.params.id, images };
    },
  );
};
