import type { EntryDto, PostDto } from '@gamepulse/shared';
import { entryStatus } from '@gamepulse/shared';
import type { StoredEntry, StoredPost } from '../storage/store.js';

/**
 * 存储模型 → API DTO 的映射。
 *
 * payload 是"演化面"，API 只透出前端真正需要的字段；新增字段必须同步
 * packages/shared 的 EntryDto，否则会被序列化白名单剔除。
 */

/** 条目映射；nowSec 用于计算四态 status（服务端唯一判定） */
export function toEntryDto(e: StoredEntry, nowSec: number): EntryDto {
  const p = e.payload;
  return {
    id: e.id,
    gameId: e.gameId,
    type: e.type,
    title: e.title,
    url: e.url,
    postId: e.postId,
    publishedAt: e.publishedAt,
    startAt: e.startAt,
    endAt: e.endAt,
    rewardEndAt: p.rewardEndAt,
    startTimeKnown: p.startTimeKnown,
    endTimeKnown: p.endTimeKnown,
    estimated: p.estimated,
    status: entryStatus(e.startAt, e.endAt, nowSec),
    category: p.category,
    summary: p.summary,
    description: p.description,
    canonicalName: p.canonicalName,
    bannerUrl: p.banner?.url,
    tags: p.tags,
    phases: p.phases,
    startRef: p.startRef,
    endRef: p.endRef,
    postIds: p.extra?.postIds as string[] | undefined,
    confidence: p.confidence,
  };
}

/** 动态映射：entryCount 的 undefined（从未提取）在 API 上统一为 null */
export function toPostDto(p: StoredPost): PostDto {
  return {
    id: p.id,
    gameId: p.gameId,
    source: p.source,
    sourceId: p.sourceId,
    type: p.type,
    title: p.title,
    url: p.url,
    author: p.author,
    publishedAt: p.publishedAt,
    description: p.description,
    images: p.images,
    firstSeenAt: p.firstSeenAt,
    updatedAt: p.updatedAt,
    entryCount: p.entryCount ?? null,
  };
}
