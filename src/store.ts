import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Item } from './types.js';

/**
 * 本地持久化存储。
 * - data/items.json：全量条目，键为系统 id，按拉取批次增量合并（upsert）；
 * - data/meta.json：最近一次拉取统计，供展示层显示；
 * 写入统一走"临时文件 + 原子重命名"，避免写一半损坏。
 */

const DATA_DIR = path.resolve('data');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

/** 带入库元数据的条目 */
export interface StoredItem extends Item {
  /** 首次入库时间，Unix 秒 */
  firstSeenAt: number;
  /** 内容最近一次变化时间，Unix 秒 */
  updatedAt: number;
}

/** 拉取批次统计 */
export interface FetchMeta {
  /** 本批次开始时间，Unix 秒 */
  lastRunAt: number;
  /** 本批次耗时（毫秒） */
  durationMs: number;
  /** 本次拉取条数（去重后） */
  fetched: number;
  /** 新增条数 */
  added: number;
  /** 内容有更新的条数 */
  updated: number;
  /** 拉取失败的错误信息 */
  errors: string[];
}

type ItemMap = Record<string, StoredItem>;

/** 读 JSON 文件；不存在或损坏时回退默认值 */
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写临时文件，再重命名覆盖 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

/** 读取全量条目（按发布时间倒序） */
export async function loadItems(): Promise<StoredItem[]> {
  const map = await readJson<ItemMap>(ITEMS_FILE, {});
  return Object.values(map).sort((a, b) => b.publishedAt - a.publishedAt);
}

/** 读取最近拉取统计；从未拉取过返回 null */
export async function loadMeta(): Promise<FetchMeta | null> {
  return readJson<FetchMeta | null>(META_FILE, null);
}

/**
 * 增量合并一批条目并落盘：
 * 新 id 插入（firstSeenAt=now）；已有 id 用新数据覆盖拉取层字段并保留 firstSeenAt；
 * ocrTexts 属富化产物，不随拉取覆盖——仅保留仍存在于新图片列表中的部分（图片列表变化时自动裁剪）；
 * 内容无变化的不刷新 updatedAt，保证后续处理链可按"内容是否变过"做幂等。
 */
export async function upsertItems(items: Item[]): Promise<{ added: number; updated: number }> {
  const map = await readJson<ItemMap>(ITEMS_FILE, {});
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  let updated = 0;

  for (const item of items) {
    const existing = map[item.id];
    if (!existing) {
      map[item.id] = { ...item, firstSeenAt: now, updatedAt: now };
      added++;
      continue;
    }
    // 富化字段保留：旧 OCR 结果裁剪到新图片列表（undefined 时 JSON 比较自然忽略该键）
    const kept = (existing.ocrTexts ?? []).filter((t) => (item.images ?? []).includes(t.imageUrl));
    const merged: Item = { ...item, ocrTexts: kept.length > 0 ? kept : undefined };
    // 内容变化只看拉取层字段（existing 剔除富化与元数据后与 item 比较），
    // 避免已富化的 ocrTexts 让每轮都误判"有更新"并刷新 updatedAt
    const { firstSeenAt, updatedAt: _u, ocrTexts: _old, ...core } = existing;
    const contentChanged = JSON.stringify(core) !== JSON.stringify(item);
    map[item.id] = { ...merged, firstSeenAt, updatedAt: contentChanged ? now : existing.updatedAt };
    if (contentChanged) updated++;
  }

  await writeJsonAtomic(ITEMS_FILE, map);
  return { added, updated };
}

/** 写入本次拉取统计 */
export async function saveMeta(meta: FetchMeta): Promise<void> {
  await writeJsonAtomic(META_FILE, meta);
}

/** 按 id 更新条目的部分字段落盘（保留 firstSeenAt、刷新 updatedAt）；条目不存在返回 false */
export async function updateItem(id: string, patch: Partial<Item>): Promise<boolean> {
  const map = await readJson<ItemMap>(ITEMS_FILE, {});
  const existing = map[id];
  if (!existing) return false;
  map[id] = { ...existing, ...patch, firstSeenAt: existing.firstSeenAt, updatedAt: Math.floor(Date.now() / 1000) };
  await writeJsonAtomic(ITEMS_FILE, map);
  return true;
}
