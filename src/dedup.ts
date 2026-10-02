import type { Item } from './types.js';

/**
 * 信息去重。对应 PRD §5.2：
 * 首选键用系统 id（`游戏:类型:源内id`，同源稳定唯一）；
 * 兜底指纹用 `游戏 + 规范标题 + 发布时间`，覆盖无可靠源 id 或跨源情形。
 */

/** 规范化标题：去除所有空白，便于指纹比对 */
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, '');
}

/** 兜底指纹 */
function fingerprint(item: Item): string {
  return `${item.gameId}|${normalizeTitle(item.title)}|${item.publishedAt}`;
}

/**
 * 对条目去重。命中重复时保留信息更完整的一条
 * （当前仅比较可空字段数量；多源字段互补合并在后续版本增强）。
 */
export function dedup(items: Item[]): Item[] {
  const byId = new Map<string, Item>();
  const fpToId = new Map<string, string>();

  for (const item of items) {
    const fp = fingerprint(item);
    // 先用系统 id，再用兜底指纹找已有条目
    const existingId = byId.has(item.id) ? item.id : fpToId.get(fp);
    const existing = existingId ? byId.get(existingId) : undefined;

    if (!existing) {
      byId.set(item.id, item);
      fpToId.set(fp, item.id);
      continue;
    }

    // 命中重复：保留可空字段更完整者，并存其 id（跨 id 重复时以更完整 id 为准）
    const winner = completeness(item) > completeness(existing) ? item : existing;
    if (winner === item) {
      byId.delete(existing.id);
      byId.set(item.id, item);
      fpToId.set(fp, item.id);
    }
  }

  return [...byId.values()];
}

/** 粗略完整度：可空字段有值的数量 */
function completeness(item: Item): number {
  return [item.author].filter((v) => v !== undefined && v !== '').length;
}
