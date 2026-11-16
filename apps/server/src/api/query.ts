import { z } from 'zod';

/**
 * 查询参数归一化工具。
 *
 * 多值参数同时支持两种写法：重复参数（`?gameId=a&gameId=b`）与逗号分隔（`?gameId=a,b`），
 * 前端与手工调试都能用；空值归一为 undefined，避免把空串送进 SQL。
 */

/** 分页上限：日历/周视图按时间范围一次拉取用，超过此值应改窗口而不是加大 limit */
export const MAX_LIMIT = 1000;

/** 多值字符串参数 → 去空数组 */
export const csvParam = z.preprocess((v) => {
  if (v === undefined || v === '') return undefined;
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(',');
  const out = raw.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}, z.array(z.string()).optional());

/** 多值枚举参数：校验每个元素，非法值直接 400 */
export function enumListParam<T extends string>(values: readonly T[]) {
  const item = z.enum(values as unknown as [T, ...T[]]);
  return z.preprocess((v) => {
    if (v === undefined || v === '') return undefined;
    const raw = Array.isArray(v) ? v.map(String) : String(v).split(',');
    const out = raw.map((s) => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }, z.array(item).optional());
}

/** 整数参数（Unix 秒或分页量）；空串视为未提供 */
export function intParam(defaultValue?: number) {
  const base = z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().int().optional(),
  );
  return defaultValue === undefined ? base : base.default(defaultValue);
}

/** 非负整数参数（数量类筛选）：空串视为未提供，负数直接 400 */
export const nonNegativeInt = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().int().min(0).optional(),
);

/** 分页参数：limit 1..MAX_LIMIT，offset ≥ 0 */
export const limitParam = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().int().min(1).max(MAX_LIMIT).default(50),
);

export const offsetParam = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().int().min(0).default(0),
);
