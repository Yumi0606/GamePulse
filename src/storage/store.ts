import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Entry, Item } from '../core/types.js';
import { normalizeImageUrl } from '../core/imageUrl.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('store');

/**
 * 本地持久化存储：SQLite（Node 内置 node:sqlite，零依赖），单文件 data/feed.db，WAL 模式。
 *
 * 三表分治（实体生命周期不同）：
 * - posts       原始社媒动态：随拉取更新，是 OCR 与拆分的输入；
 * - ocr_records 图片级 OCR 记录：按 image_url 全局幂等，独立于动态生命周期；
 * - entries     拆分后的标准条目（活动/卡池/公告…，LLM 处理链产物）：一条动态可拆多条，
 *               建表预留，API 随 v1.5 LLM 步骤补充。
 * 辅助表：meta 拉取批次统计（单行）；events 源健康事件（拉取异常记录 + 自动恢复）。
 *
 * 旧版单表 items（payload JSON 混装）首次访问自动迁移为 posts + ocr_records，表改名 items_v1 留档。
 */

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'feed.db');
const LEGACY_ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const LEGACY_META_FILE = path.join(DATA_DIR, 'meta.json');

/** posts 表行：原始动态 + 库存元数据 */
export interface StoredPost extends Item {
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

/** 待识别图片（posts 与 ocr_records 的差集） */
export interface PendingImage {
  postId: string;
  imageUrl: string;
}

/** 源健康事件类型：http=上游 HTTP 错误 / network=网络不可达或超时 / parse=响应非有效 RSS / empty=拉取成功但 0 条 */
export type EventKind = 'http' | 'network' | 'parse' | 'empty';

/** events 表行：源健康事件 */
export interface StoredEvent {
  id: number;
  /** 所属游戏标识；null=系统级事件 */
  gameId: string | null;
  kind: EventKind;
  /** 一行摘要 */
  summary: string;
  /** 原始错误文本（如 RSSHub 错误页的 Error Message） */
  detail: string | null;
  /** 疑似 B站 cookie 失效 */
  isCookieSuspect: boolean;
  /** 发生时间，Unix 秒 */
  occurredAt: number;
  /** 恢复时间，Unix 秒；null=未恢复 */
  resolvedAt: number | null;
}

/** 未恢复事件计数（主页通知区域用） */
export interface UnresolvedEventCount {
  total: number;
  /** 其中疑似 cookie 失效的数量 */
  cookieSuspect: number;
}

interface PostRow {
  id: string;
  game_id: string;
  source: string;
  source_id: string;
  type: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: number;
  description: string | null;
  images: string | null;
  first_seen_at: number;
  updated_at: number;
}

/** 打开数据库连接（模块级单例），建表并执行历史迁移 */
function openDb(): DatabaseSync {
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    -- 原始社媒动态：RSS 拉取层产物，是 OCR 与拆分的输入；内容随源更新（upsert 覆盖拉取层字段）
    CREATE TABLE IF NOT EXISTS posts (
      id            TEXT PRIMARY KEY,   -- 系统内唯一 id："{gameId}:{type}:{sourceId}"，如 arknights:NEWS:123456
      game_id       TEXT NOT NULL,      -- 所属游戏标识，如 arknights
      source        TEXT NOT NULL,      -- 信息源标识，如 rsshub-bilibili
      source_id     TEXT NOT NULL,      -- 源内原始 id（B站动态 id）
      type          TEXT NOT NULL,      -- 条目大类（ItemType）：当前恒为 NEWS
      title         TEXT NOT NULL,      -- 动态标题（RSS title，已解码实体）
      url           TEXT,               -- 原文链接（B站动态页）
      author        TEXT,               -- 作者/官号名
      published_at  INTEGER NOT NULL,   -- 动态发布时间，Unix 秒
      description   TEXT,               -- 正文纯文本（HTML 去标签），LLM 结构化的文本输入之一
      images        TEXT,               -- 图片 URL 列表（JSON 数组字符串），OCR 的输入；无图为 NULL
      first_seen_at INTEGER NOT NULL,   -- 首次入库时间，Unix 秒（拉取覆盖时保留）
      updated_at    INTEGER NOT NULL,   -- 内容最近一次变化时间，Unix 秒；内容未变不刷新（下游幂等依据）
      extracted_at  INTEGER,            -- LLM 结构化完成时间，Unix 秒；NULL=未处理（含预过滤跳过也写入）
      extract_attempts INTEGER NOT NULL DEFAULT 0, -- LLM 结构化累计尝试次数（仅内容类失败累加，见 markExtractFailure）
      extract_last_error TEXT,          -- 最近一次结构化失败原因（infra/内容失败都记录）
      extract_last_attempted_at INTEGER -- 最近一次结构化尝试时间，Unix 秒；重试冷却依据（NULL=从未尝试）
      -- 注意：拉取层覆盖走 INSERT OR REPLACE，未列出的上述状态列会被重置——
      -- 即"内容变化"时 extracted_at/extract_attempts 自动归零重新入队（隐式语义，勿给这些列加默认值）
    );
    -- 展示层按游戏分组倒序取数
    CREATE INDEX IF NOT EXISTS idx_posts_game ON posts(game_id, published_at DESC);

    -- 图片级 OCR 记录：独立于动态生命周期；同一图片被多条动态引用时只识别一次。
    -- 状态机：无记录 → failed(attempts<上限，重试) → ok（终态）；failed 且 attempts 达上限 = 放弃（死图）
    CREATE TABLE IF NOT EXISTS ocr_records (
      image_url  TEXT PRIMARY KEY,      -- 图片 URL（经 normalizeImageUrl 规范化：统一协议与 CDN 主机号），幂等键
      post_id    TEXT NOT NULL,         -- 首次发现该图片的动态 id（posts.id）
      text       TEXT NOT NULL,         -- OCR 识别文本（客户端已过滤噪声行，多行合并为一段）；失败时为空串
      created_at INTEGER NOT NULL,      -- 首次尝试时间，Unix 秒
      status     TEXT NOT NULL DEFAULT 'ok', -- 当前状态：ok=识别成功 / failed=识别失败待重试
      attempts   INTEGER NOT NULL DEFAULT 0, -- 累计尝试次数（仅内容类失败累加；基础设施失败不计数，见 saveOcrFailure）
      last_error TEXT,                       -- 最近一次失败原因；成功后清空
      last_attempted_at INTEGER             -- 最近一次尝试时间，Unix 秒；重试冷却依据（NULL=从未尝试）
    );
    CREATE INDEX IF NOT EXISTS idx_ocr_post ON ocr_records(post_id);

    -- 拆分后的标准条目（LLM 处理链产物），模型见《调研报告-活动数据结构》§4/§6；
    -- 一条动态可拆多条，sourceId 带语义槽位："{动态id}/{activity|gacha|announcement}"；
    -- 表已建、API 随 LLM 步骤补充
    CREATE TABLE IF NOT EXISTS entries (
      id            TEXT PRIMARY KEY,   -- 系统内唯一 id："{gameId}:{type}:{sourceId}"
      post_id       TEXT,               -- 来源动态 id（posts.id）；可空——未来其他信息源（GameData 等）无动态来源
      game_id       TEXT NOT NULL,      -- 所属游戏标识
      type          TEXT NOT NULL,      -- 条目大类：ACTIVITY / GACHA / ANNOUNCEMENT / NEWS…
      source        TEXT NOT NULL,      -- 信息源标识（如 llm-bilibili、gamedata）
      source_id     TEXT NOT NULL,      -- 源内原始 id（含语义槽位）
      title         TEXT NOT NULL,      -- 条目标题
      url           TEXT,               -- 官方/原文链接
      published_at  INTEGER,            -- 发布时间，Unix 秒（动态来源时继承 posts.published_at）
      start_at      INTEGER,            -- 开始时间（引用型时间锚定后的绝对值），Unix 秒；未锚定为 NULL
      end_at        INTEGER,            -- 结束时间，Unix 秒；常驻/未锚定为 NULL（分段与奖励期细节在 payload.schedule）
      payload       TEXT NOT NULL,      -- 完整条目 JSON：schedule 分段、rewardEndAt、provenance、confidence、category、extra 等
      first_seen_at INTEGER NOT NULL,   -- 首次入库时间，Unix 秒
      updated_at    INTEGER NOT NULL    -- 内容最近一次变化时间，Unix 秒
    );
    -- 判定层核心查询：按游戏+大类+结束时间筛"即将到期"的条目
    CREATE INDEX IF NOT EXISTS idx_entries_game ON entries(game_id, type, end_at);
    -- replaceEntriesForPost 按 post_id 全删，避免全表扫描
    CREATE INDEX IF NOT EXISTS idx_entries_post ON entries(post_id);

    -- 拉取批次统计（单行表：id 恒为 1）
    CREATE TABLE IF NOT EXISTS meta (
      id    INTEGER PRIMARY KEY CHECK (id = 1),  -- 恒为 1
      value TEXT NOT NULL                        -- FetchMeta JSON
    );

    -- 源健康事件：拉取层异常记录（供 Web 异常页与主页通知）。
    -- 生命周期：发生（resolved_at 为 NULL）→ 同一游戏后续某轮拉取成功且有数据时自动标记恢复
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     TEXT,                       -- 所属游戏标识；NULL=系统级事件（预留给非源类异常）
      kind        TEXT NOT NULL,              -- 异常类型：http=上游 HTTP 错误 / network=网络不可达或超时 / parse=响应非有效 RSS / empty=拉取成功但 0 条
      summary     TEXT NOT NULL,              -- 一行摘要（如 "拉取 XX 动态失败：HTTP 503"）
      detail      TEXT,                       -- 原始错误文本（如 RSSHub 错误页的 Error Message），截断存储
      is_cookie   INTEGER NOT NULL DEFAULT 0, -- 疑似 B站 cookie 失效：错误文本命中 -101/账号未登录/SESSDATA/cookie 特征
      occurred_at INTEGER NOT NULL,           -- 发生时间，Unix 秒
      resolved_at INTEGER                  -- 恢复时间，Unix 秒；NULL=未恢复
    );
    -- 未恢复集合（主页通知计数）与异常页时间倒序列表共用
    CREATE INDEX IF NOT EXISTS idx_events_open ON events(resolved_at, occurred_at DESC);
  `);
  migrateFromJsonFiles(db);
  migrateFromItemsTable(db);
  migrateOcrRecords(db);
  migratePostsExtract(db);
  return db;
}

/** 为已有旧库表补列（列已存在则跳过）；返回是否补了列 */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/**
 * 旧库 ocr_records 迁移（幂等，可反复执行）：
 * 1. 补状态列（status/attempts/last_error）；
 * 2. 幂等键规范化——存在旧格式键（含协议或主机号的完整 URL）时，
 *    重写 ocr_records.image_url 与 posts.images 为 normalizeImageUrl 形态，两侧一致。
 */
function migrateOcrRecords(db: DatabaseSync): void {
  const added =
    Number(ensureColumn(db, 'ocr_records', 'status', "status TEXT NOT NULL DEFAULT 'ok'")) +
    Number(ensureColumn(db, 'ocr_records', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0')) +
    Number(ensureColumn(db, 'ocr_records', 'last_error', 'last_error TEXT')) +
    Number(ensureColumn(db, 'ocr_records', 'last_attempted_at', 'last_attempted_at INTEGER'));
  if (added > 0) log.info('ocr_records 已补状态列 count=%d', added);

  // 旧格式键 = 带协议主机号的完整 URL；规范化后键固定为 https://i0.hdslb.com/...，检测需排除之
  const hasLegacyKey = db
    .prepare("SELECT 1 FROM ocr_records WHERE image_url LIKE '//%' OR (image_url LIKE 'http%' AND image_url NOT LIKE 'https://i0.hdslb.com/%') LIMIT 1")
    .get();
  if (!hasLegacyKey) return;

  const rows = db.prepare('SELECT image_url FROM ocr_records').all() as unknown as { image_url: string }[];
  const upd = db.prepare('UPDATE ocr_records SET image_url = ? WHERE image_url = ?');
  const hasKey = db.prepare('SELECT 1 FROM ocr_records WHERE image_url = ?');
  const del = db.prepare('DELETE FROM ocr_records WHERE image_url = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const norm = normalizeImageUrl(r.image_url);
      if (norm === r.image_url) continue;
      // 规范化后撞键（同图异主机记录）时保留先到行、删除旧行
      if (hasKey.get(norm)) del.run(r.image_url);
      else upd.run(norm, r.image_url);
      changed++;
    }
    if (changed === 0) {
      db.exec('COMMIT');
      return;
    }
    // posts.images 同步重写，保证差集查询两侧键一致
    const posts = db.prepare('SELECT id, images FROM posts WHERE images IS NOT NULL').all() as unknown as { id: string; images: string }[];
    const updPost = db.prepare('UPDATE posts SET images = ? WHERE id = ?');
    for (const p of posts) {
      const list = JSON.parse(p.images) as string[];
      updPost.run(JSON.stringify(list.map(normalizeImageUrl)), p.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  log.info('OCR 幂等键已规范化重写 ocrRows=%d', changed);
}

/** 旧库 posts 表补 LLM 结构化状态列（幂等） */
function migratePostsExtract(db: DatabaseSync): void {
  const added =
    Number(ensureColumn(db, 'posts', 'extracted_at', 'extracted_at INTEGER')) +
    Number(ensureColumn(db, 'posts', 'extract_attempts', 'extract_attempts INTEGER NOT NULL DEFAULT 0')) +
    Number(ensureColumn(db, 'posts', 'extract_last_error', 'extract_last_error TEXT')) +
    Number(ensureColumn(db, 'posts', 'extract_last_attempted_at', 'extract_last_attempted_at INTEGER'));
  if (added > 0) log.info('posts 已补 LLM 处理状态列 count=%d', added);
}

/** 旧版 JSON 文件存储一次性导入（仅最早期版本会走到），随后改名留档 */
function migrateFromJsonFiles(db: DatabaseSync): void {
  if (!existsSync(LEGACY_ITEMS_FILE)) return;
  const map = JSON.parse(readFileSync(LEGACY_ITEMS_FILE, 'utf8')) as Record<string, StoredPost & { ocrTexts?: { imageUrl: string; text: string }[] }>;
  db.exec('BEGIN');
  try {
    for (const [id, it] of Object.entries(map)) {
      insertPost(db, { ...it, id }, it.firstSeenAt, it.updatedAt);
      for (const t of it.ocrTexts ?? []) {
        saveOcrRecordOn(db, t.imageUrl, id, t.text);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  renameSync(LEGACY_ITEMS_FILE, `${LEGACY_ITEMS_FILE}.imported`);
  try {
    if (existsSync(LEGACY_META_FILE)) {
      const meta = JSON.parse(readFileSync(LEGACY_META_FILE, 'utf8')) as FetchMeta;
      db.prepare('INSERT OR REPLACE INTO meta (id, value) VALUES (1, ?)').run(JSON.stringify(meta));
      renameSync(LEGACY_META_FILE, `${LEGACY_META_FILE}.imported`);
    }
  } catch (e) {
    log.error('旧 meta.json 迁移失败 err=%s', (e as Error).message);
  }
  log.info('旧 JSON 存储已迁移到 SQLite posts=%d', Object.keys(map).length);
}

/** 单表 items（payload JSON 混装版）迁移：拆出 ocr_records，表改名 items_v1 留档 */
function migrateFromItemsTable(db: DatabaseSync): void {
  const hasItems = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get();
  if (!hasItems) return;
  const rows = db.prepare('SELECT id, payload, first_seen_at, updated_at FROM items').all() as unknown as {
    id: string; payload: string; first_seen_at: number; updated_at: number;
  }[];
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const item = JSON.parse(row.payload) as Item & { ocrTexts?: { imageUrl: string; text: string }[] };
      insertPost(db, { ...item, id: row.id }, row.first_seen_at, row.updated_at);
      for (const t of item.ocrTexts ?? []) {
        saveOcrRecordOn(db, t.imageUrl, row.id, t.text);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('ALTER TABLE items RENAME TO items_v1');
  db.exec('DROP INDEX IF EXISTS idx_items_game');
  log.info('单表 items 已迁移为 posts + ocr_records rows=%d', rows.length);
}

/** 写入一条动态（供迁移复用） */
function insertPost(db: DatabaseSync, item: Item, firstSeenAt: number, updatedAt: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO posts (id, game_id, source, source_id, type, title, url, author, published_at, description, images, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    item.id, item.gameId, item.source, item.sourceId, item.type, item.title, item.url ?? null,
    item.author ?? null, item.publishedAt, item.description ?? null,
    item.images ? JSON.stringify(item.images) : null, firstSeenAt, updatedAt,
  );
}

/** 写入 OCR 记录（供迁移复用；image_url 全局幂等） */
function saveOcrRecordOn(db: DatabaseSync, imageUrl: string, postId: string, text: string): void {
  db.prepare('INSERT OR IGNORE INTO ocr_records (image_url, post_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(imageUrl, postId, text, Math.floor(Date.now() / 1000));
}

const db = openDb();

/** 行 → StoredPost */
function rowToPost(row: PostRow): StoredPost {
  return {
    id: row.id,
    sourceId: row.source_id,
    source: row.source,
    gameId: row.game_id,
    type: row.type as Item['type'],
    title: row.title,
    url: row.url ?? '',
    publishedAt: row.published_at,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    images: row.images ? (JSON.parse(row.images) as string[]) : undefined,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/** 读取全量动态（按发布时间倒序） */
export async function loadPosts(): Promise<StoredPost[]> {
  const rows = db.prepare('SELECT * FROM posts ORDER BY published_at DESC').all() as unknown as PostRow[];
  return rows.map(rowToPost);
}

/**
 * 增量合并一批动态：
 * 新 id 插入（firstSeenAt=now）；已有 id 用新数据覆盖拉取层字段并保留 firstSeenAt；
 * 内容无变化的不刷新 updatedAt，保证下游处理链可按"内容是否变过"做幂等。
 */
export async function upsertPosts(posts: Item[]): Promise<{ added: number; updated: number }> {
  const sel = db.prepare('SELECT * FROM posts WHERE id = ?');
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const post of posts) {
      const row = sel.get(post.id) as unknown as PostRow | undefined;
      if (!row) {
        insertPost(db, post, now, now);
        added++;
        continue;
      }
      const newImages = post.images ? JSON.stringify(post.images) : null;
      // 内容变化只看拉取层字段
      const contentChanged =
        row.title !== post.title ||
        row.url !== (post.url ?? null) ||
        row.author !== (post.author ?? null) ||
        row.description !== (post.description ?? null) ||
        row.images !== newImages;
      if (contentChanged) {
        insertPost(db, post, row.first_seen_at, now);
        updated++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, updated };
}

/**
 * 列出待识别图片（按动态发布时间倒序），同一图片只出现一次（同图被多条动态引用时）：
 * - 无记录 → 待识别；
 * - failed 且 attempts < maxAttempts 且已过冷却 → 重试；attempts 达上限 → 放弃（死图）；
 * - 冷却：last_attempted_at 距今不足 cooldownSeconds 的跳过（cooldownSeconds=0 等价于不冷却）。
 */
export async function listUnrecognizedImages(maxAttempts: number, cooldownSeconds = 0): Promise<PendingImage[]> {
  const rows = db.prepare(`
    SELECT j.value AS imageUrl, MIN(p.id) AS postId
    FROM posts p, json_each(p.images) j
    LEFT JOIN ocr_records o ON o.image_url = j.value
    WHERE o.image_url IS NULL
       OR (o.status = 'failed' AND o.attempts < ?
           AND (o.last_attempted_at IS NULL OR o.last_attempted_at <= ?))
    GROUP BY j.value
    ORDER BY MAX(p.published_at) DESC
  `).all(maxAttempts, Math.floor(Date.now() / 1000) - cooldownSeconds) as unknown as PendingImage[];
  return rows;
}

/** 记录一次识别成功；同图已有失败记录时转正，attempts 保留历史 */
export async function saveOcrRecord(imageUrl: string, postId: string, text: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO ocr_records (image_url, post_id, text, created_at, status, attempts, last_error, last_attempted_at)
    VALUES (?, ?, ?, ?, 'ok', 1, NULL, ?)
    ON CONFLICT(image_url) DO UPDATE SET
      status = 'ok', text = excluded.text, last_error = NULL, last_attempted_at = excluded.last_attempted_at
  `).run(normalizeImageUrl(imageUrl), postId, text, now, now);
}

/**
 * 记录一次识别失败。
 * - 内容类失败（infra=false）：attempts 累加，达到调用方设定的上限后不再进入待识别队列；
 * - 基础设施失败（infra=true，如服务未启动/超时）：attempts 不累加，只记错误与尝试时间，
 *   防止 OCR 侧车宕机期间把全部图片的重试额度烧光。
 */
export async function saveOcrFailure(imageUrl: string, postId: string, error: string, infra = false): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const inc = infra ? 0 : 1;
  db.prepare(`
    INSERT INTO ocr_records (image_url, post_id, text, created_at, status, attempts, last_error, last_attempted_at)
    VALUES (?, ?, '', ?, 'failed', ?, ?, ?)
    ON CONFLICT(image_url) DO UPDATE SET
      status = 'failed',
      attempts = attempts + ?,
      last_error = excluded.last_error,
      last_attempted_at = excluded.last_attempted_at
  `).run(normalizeImageUrl(imageUrl), postId, now, inc, error.slice(0, 500), now, inc);
}

/** 读取某动态全部图片的 OCR 文本（按 posts.images 顺序；仅取识别成功的记录） */
export async function loadOcrTexts(postId: string): Promise<string[]> {
  const row = db.prepare('SELECT images FROM posts WHERE id = ?').get(postId) as { images: string | null } | undefined;
  if (!row?.images) return [];
  const images = JSON.parse(row.images) as string[];
  const get = db.prepare("SELECT text FROM ocr_records WHERE image_url = ? AND status = 'ok'");
  const texts: string[] = [];
  for (const imageUrl of images) {
    const r = get.get(imageUrl) as { text: string } | undefined;
    if (r) texts.push(r.text);
  }
  return texts;
}

/** OCR 记录展示视图：识别状态 + 文本（展示层按动态图片列表组装每条动态的 OCR 情况） */
export interface OcrRecordView {
  status: 'ok' | 'failed';
  text: string;
}

/**
 * 读取全部 OCR 记录（按规范化图片 URL 索引），供展示层组装每条动态的 OCR 文本与识别状态。
 * 一次读取全表：当前量级（数百条）下优于按动态逐条查询；数据增长后可按需改分页。
 */
export async function loadOcrRecords(): Promise<Map<string, OcrRecordView>> {
  const rows = db.prepare('SELECT image_url, status, text FROM ocr_records').all() as unknown as {
    image_url: string; status: string; text: string;
  }[];
  return new Map(rows.map((r) => [r.image_url, { status: r.status as 'ok' | 'failed', text: r.text }]));
}

/** 读取最近拉取统计；从未拉取过返回 null */
export async function loadMeta(): Promise<FetchMeta | null> {
  const row = db.prepare('SELECT value FROM meta WHERE id = 1').get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as FetchMeta) : null;
}

/** 写入本次拉取统计 */
export async function saveMeta(meta: FetchMeta): Promise<void> {
  db.prepare('INSERT OR REPLACE INTO meta (id, value) VALUES (1, ?)').run(JSON.stringify(meta));
}

// ==================== 源健康事件（Web 异常页 / 主页通知） ====================

/**
 * 记录一条源健康事件（拉取层异常）。摘要与详情超长自动截断（与列注释语义一致）。
 */
export async function recordEvent(e: {
  gameId?: string;
  kind: EventKind;
  summary: string;
  detail?: string;
  isCookieSuspect?: boolean;
}): Promise<void> {
  db.prepare(`
    INSERT INTO events (game_id, kind, summary, detail, is_cookie, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    e.gameId ?? null,
    e.kind,
    e.summary.slice(0, 200),
    e.detail?.slice(0, 500) ?? null,
    e.isCookieSuspect ? 1 : 0,
    Math.floor(Date.now() / 1000),
  );
}

/** 该游戏全部未恢复事件标记恢复（本轮拉取成功且有数据时调用）；返回恢复条数 */
export async function resolveEventsForGame(gameId: string): Promise<number> {
  const r = db
    .prepare('UPDATE events SET resolved_at = ? WHERE game_id = ? AND resolved_at IS NULL')
    .run(Math.floor(Date.now() / 1000), gameId);
  return Number(r.changes);
}

/** 未恢复事件计数（主页通知区域：有未恢复异常则显示警告并链接到异常页） */
export async function countUnresolvedEvents(): Promise<UnresolvedEventCount> {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(is_cookie), 0) AS cookie
    FROM events WHERE resolved_at IS NULL
  `).get() as { total: number; cookie: number };
  return { total: row.total, cookieSuspect: Number(row.cookie) };
}

/** events 表行 */
interface EventRow {
  id: number;
  game_id: string | null;
  kind: string;
  summary: string;
  detail: string | null;
  is_cookie: number;
  occurred_at: number;
  resolved_at: number | null;
}

/** 行 → StoredEvent */
function rowToEvent(r: EventRow): StoredEvent {
  return {
    id: r.id,
    gameId: r.game_id,
    kind: r.kind as EventKind,
    summary: r.summary,
    detail: r.detail,
    isCookieSuspect: r.is_cookie === 1,
    occurredAt: r.occurred_at,
    resolvedAt: r.resolved_at,
  };
}

/** 异常页列表：按发生时间倒序（含已恢复） */
export async function listEvents(limit = 200): Promise<StoredEvent[]> {
  const rows = db.prepare(`
    SELECT * FROM events ORDER BY occurred_at DESC, id DESC LIMIT ?
  `).all(limit) as unknown as EventRow[];
  return rows.map(rowToEvent);
}

/**
 * 最近一条未恢复事件（主页异常报告区取"最近异常时间"）；无未恢复事件返回 null。
 * 时间口径取 occurred_at（异常发生时间），与计数口径一致（resolved_at IS NULL）。
 */
export async function latestUnresolvedEvent(): Promise<StoredEvent | null> {
  const row = db.prepare(`
    SELECT * FROM events WHERE resolved_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT 1
  `).get() as unknown as EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * 待结构化动态数：从未处理（extracted_at 为 NULL）或处理后内容又更新（extracted_at < updated_at）。
 * 不计尝试次数上限（含已被放弃的动态），语义为"尚未产出结构化结果的动态"，供概览卡片展示。
 */
export async function countPendingExtract(): Promise<number> {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM posts WHERE extracted_at IS NULL OR extracted_at < updated_at
  `).get() as { n: number };
  return Number(row.n);
}

/**
 * 尚未成功识别的图片数：按去重图片 URL 统计，不存在 status='ok' 记录的即计入
 * （含从未尝试与尝试失败待重试的），供概览卡片展示"待 OCR 图片"。
 */
export async function countUnrecognizedImages(): Promise<number> {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT j.value AS image_url
      FROM posts p, json_each(p.images) j
      LEFT JOIN ocr_records o ON o.image_url = j.value AND o.status = 'ok'
      GROUP BY j.value
      HAVING COUNT(o.image_url) = 0
    )
  `).get() as { n: number };
  return Number(row.n);
}

// ==================== LLM 结构化（v1.5） ====================

interface EntryRow {
  id: string;
  post_id: string | null;
  game_id: string;
  type: string;
  source: string;
  source_id: string;
  title: string;
  url: string | null;
  published_at: number | null;
  start_at: number | null;
  end_at: number | null;
  payload: string;
  first_seen_at: number;
  updated_at: number;
}

/** entries 表行：结构化条目 + 库存元数据 */
export interface StoredEntry extends Entry {
  /** 首次入库时间，Unix 秒 */
  firstSeenAt: number;
  /** 内容最近一次变化时间，Unix 秒 */
  updatedAt: number;
}

function rowToEntry(row: EntryRow): StoredEntry {
  return {
    id: row.id,
    postId: row.post_id ?? undefined,
    gameId: row.game_id,
    type: row.type as Entry['type'],
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    url: row.url ?? undefined,
    publishedAt: row.published_at ?? undefined,
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    payload: JSON.parse(row.payload) as Entry['payload'],
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 列出待 LLM 结构化的动态：
 * - 从未处理（extracted_at 为 NULL）或处理后内容又更新（extracted_at < updated_at），
 *   且尝试次数未达上限（仅内容类失败累加）；
 * - OCR 就绪门槛：动态引用的每张图片都已到达终态（识别成功，或失败次数达上限放弃），
 *   防止 LLM 在图片识别未完成时只依据部分 OCR 文本产出残缺条目；无图动态不受限制；
 * - 冷却：extract_last_attempted_at 距今不足 cooldownSeconds 的跳过（0 等价于不冷却），
 *   避免 LLM 服务故障期间按调度间隔反复硬冲。
 */
export async function listPostsToExtract(maxAttempts: number, cooldownSeconds = 0): Promise<StoredPost[]> {
  // 图片放弃门槛取 OCR 侧的最大尝试次数，与 enrichOcr 的放弃判定保持一致
  const ocrMaxAttempts = Number(process.env.OCR_MAX_ATTEMPTS ?? 3);
  const ocrMax = Number.isFinite(ocrMaxAttempts) && ocrMaxAttempts >= 1 ? ocrMaxAttempts : 3;
  const rows = db.prepare(`
    SELECT * FROM posts
    WHERE (extracted_at IS NULL OR extracted_at < updated_at)
      AND extract_attempts < ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(posts.images) img
        LEFT JOIN ocr_records o ON o.image_url = img.value
        WHERE o.status IS NULL
           OR (o.status = 'failed' AND o.attempts < ?)
      )
      AND (extract_last_attempted_at IS NULL OR extract_last_attempted_at <= ?)
    ORDER BY published_at DESC
  `).all(
    maxAttempts,
    ocrMax,
    Math.floor(Date.now() / 1000) - cooldownSeconds,
  ) as unknown as PostRow[];
  return rows.map(rowToPost);
}

/** 标记动态已结构化（含"预过滤跳过：无需结构化"的情形） */
export async function markExtracted(postId: string): Promise<void> {
  db.prepare('UPDATE posts SET extracted_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), postId);
}

/**
 * 记一次结构化失败：
 * - 内容类失败（infra=false）attempts 累加，达上限后由查询条件自动放弃；
 * - 基础设施失败（infra=true，如网络/超时/限流/鉴权）attempts 不累加，防服务故障烧光重试额度。
 * 两种失败均记录原因（extract_last_error）与尝试时间（冷却用）。
 */
export async function markExtractFailure(postId: string, error: string, infra = false): Promise<void> {
  db.prepare(`
    UPDATE posts SET
      extract_attempts = extract_attempts + ?,
      extract_last_error = ?,
      extract_last_attempted_at = ?
    WHERE id = ?
  `).run(infra ? 0 : 1, error.slice(0, 500), Math.floor(Date.now() / 1000), postId);
}

/**
 * 用一批新条目整体替换某动态的 LLM 结构化产物（事务）：
 * 重建语义——动态内容变化后旧拆分可能失效（如文案删掉了卡池信息），全删全插保持一致。
 */
export async function replaceEntriesForPost(postId: string, entries: Entry[]): Promise<void> {
  const ins = db.prepare(`
    INSERT INTO entries (id, post_id, game_id, type, source, source_id, title, url, published_at, start_at, end_at, payload, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM entries WHERE post_id = ?').run(postId);
    for (const e of entries) {
      ins.run(
        e.id, e.postId ?? null, e.gameId, e.type, e.source, e.sourceId, e.title,
        e.url ?? null, e.publishedAt ?? null, e.startAt ?? null, e.endAt ?? null,
        JSON.stringify(e.payload), now, now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 读取全量结构化条目（按结束时间升序，NULL 排最后） */
export async function loadEntries(): Promise<StoredEntry[]> {
  const rows = db.prepare(`
    SELECT * FROM entries
    ORDER BY (end_at IS NULL), end_at, published_at DESC
  `).all() as unknown as EntryRow[];
  return rows.map(rowToEntry);
}
