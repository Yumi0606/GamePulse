import type {
  EntryPageDto,
  EventListDto,
  GamesDto,
  HealthDto,
  PostOcrDto,
  PostPageDto,
} from '@gamepulse/shared';

/**
 * /api/v1 只读客户端。
 *
 * 约束：前端不得直连 data/feed.db，也不得静态复制游戏清单或状态判定——
 * 游戏走 /games，条目状态用响应里的 status。
 */

const BASE = '/api/v1';

type ParamValue = string | number | undefined | null;

async function get<T>(path: string, params?: Record<string, ParamValue>): Promise<T> {
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // 非 JSON 错误响应，保留状态码信息
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface EntryQuery {
  gameId?: string;
  type?: string;
  status?: string;
  /** 按条目 id 取单条（深链定位） */
  id?: string;
  q?: string;
  from?: number;
  to?: number;
  rewardFrom?: number;
  rewardTo?: number;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export interface PostQuery {
  gameId?: string;
  /** 逗号分隔的动态 id；列表页据此解析来源标题 */
  id?: string;
  q?: string;
  from?: number;
  to?: number;
  /** 图片数量闭区间（OCR 图片数筛选） */
  imagesMin?: number;
  imagesMax?: number;
  /** never=从未成功提取，empty=提取过但没有排期，some=提取到至少一条 */
  extracted?: 'never' | 'empty' | 'some';
  sort?: 'published' | 'images' | 'entries';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const api = {
  health: () => get<HealthDto>('/health'),
  events: () => get<EventListDto>('/events'),
  games: () => get<GamesDto>('/games'),
  entries: (q: EntryQuery) => get<EntryPageDto>('/entries', q as Record<string, ParamValue>),
  posts: (q: PostQuery) => get<PostPageDto>('/posts', q as Record<string, ParamValue>),
  postOcr: (postId: string) => get<PostOcrDto>(`/posts/${encodeURIComponent(postId)}/ocr`),
};
