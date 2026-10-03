import type { Entry, EntryPayload, EntryType } from '../core/types.js';
import { loadOcrTexts, loadPosts, listPostsToExtract, markExtractFailure, markExtracted, replaceEntriesForPost, type StoredPost } from '../storage/store.js';
import { chatJSON, llmConfig, llmEnabled, LlmInfraError } from './llm.js';
import { GAMES } from '../core/games.js';
import { envNum, envStr } from '../core/env.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('extract');

/**
 * LLM 结构化（结构化处理链第二步，见 PRD §5.3）：
 * 动态（正文 + 图片 OCR 文本）→ 拆分为活动/卡池/公告条目（entries 表）。
 *
 * 链路：选待处理动态 → 关键词预过滤（无关动态直接标记跳过，省 token）→
 *       组装上下文（正文 + OCR + 发布日期 + 当前日期）→ LLM 拆分 →
 *       校验与规整（时间字符串转 Unix 秒、id 合成、置信度/溯源）→ 整体替换入库。
 *
 * 幂等：post 内容未变（updated_at 未刷新）不重跑；重跑时按 post 整体替换 entries。
 * 兜底：单条失败记 attempts，达上限放弃；LLM 未配置时整个步骤跳过。
 */

/** 单批最多送 LLM 的动态条数 */
const BATCH_LIMIT = () => envNum('LLM_BATCH_LIMIT', 10);
/** 单条动态最大尝试次数 */
const MAX_ATTEMPTS = () => envNum('EXTRACT_MAX_ATTEMPTS', 3);
/** 失败重试冷却（秒）：刚失败过的动态在冷却期内不再尝试（默认 300s，0=不冷却） */
const RETRY_COOLDOWN = () => envNum('LLM_RETRY_COOLDOWN', 300);
/** 连续基础设施失败达该次数即熔断本批剩余（服务大概率不可用） */
const INFRA_BREAK_STREAK = 3;
/** 产出源标识（写入 entries.source） */
const SOURCE = 'llm-bilibili';

/** 关键词预过滤：标题/正文/OCR 文本均不含这些词的动态大概率与活动无关 */
const KEYWORDS = [
  '活动', '卡池', '祈愿', '寻访', '补给', '限定', '复刻', '联动', '版本', '更新',
  '公告', '维护', '上线', '开启', '开始', '结束', '截止', '签到', '赛季', '任务',
  '礼包', '商城', '兑换', '奖励', 'PV', '预告', '招募', '肝', '倒计时', '上架',
];

/** 系统提示：任务定义 + 数据模型 + 时间解析规则 + 输出格式（字段与《调研报告-活动数据结构》§4 对齐） */
function systemPrompt(gameName: string, publishedAt: string, today: string): string {
  return `你是游戏运营信息结构化助手。任务：把游戏官方社媒动态解析为结构化的排期条目。

目标游戏：${gameName}
动态发布时间：${publishedAt}（作为"今天/X天后/本周五"等相对表述的参照）
当前日期：${today}
动态中的时间均为游戏服务器时间（国服=北京时间 UTC+8），无需时区换算。

## 条目大类（type 只能取以下值）
- ACTIVITY：游戏内限时活动（副本活动、签到、赛季、危机合约等）
- GACHA：卡池/祈愿/寻访（标准池、限定池、联动池、新手池）
- SHOP：限时商品（礼包、组合包、限时皮肤、月卡上架）
- COLLAB：现实世界联动活动（线下联动、IP 合作、主题店、联动展，非游戏内玩法）
- ANNOUNCEMENT：官方公告（维护预告、问题修复、补偿说明等纯文字通告）
注意：抽奖转发、周边发售、视频投稿、玩家问卷等与游戏内排期无关的内容 → 输出空数组。
不确定的信息宁可不产出（宁缺毋滥），不要编造。

## 提取规则
1. 一条动态可以拆出多条条目（如同时预告活动和卡池），也可以产出 0 条。
2. 时间解析：
   - "2026/10/01 12:00"、"10月1日 12:00"等明确时间 → 输出 ISO 格式 "startAt"/"endAt"（YYYY-MM-DDTHH:mm），代码侧会转 Unix 秒。
   - 原文没写年份/日期、由你按上下文补全推断的 → 同时置 "estimated": true。
   - 相对活动起止可推算的偏移表述（"开启后第8天"、"一周后"、"第2周"）→ 不要留 ref，按活动起止推算为具体 "startAt"/"endAt"，并置 "estimated": true。
   - "版本结束"、"维护后"等完全无法定位的表述 → 填 "startRef"/"endRef" 保留原文，不要猜绝对时间。
   - 活动分段（尽可能拆）：活动期内分批开放/新增/解锁的内容都是分段信号——"第X天"、"一周后"、"X月X日起新增"、"上半/下半"、"第一阶段/第二阶段"等，即使原文没有"阶段"字样也要拆成 "phases"。每段 {"title": 段名（原文有就用原文，没有就按内容概括，如"兑换处新增物资"）, "startAt"/"endAt" 或 "startRef"/"endRef", "estimated"}；段时间规则同上；各段按时间顺序排列，段与段可重叠或相邻。
   - 分段宁多勿漏：漏掉分批开放节点会让排期提醒缺失；把握不足的段照样拆出，置 "estimated": true 并降低 confidence。
   - 奖励领取期（活动结束后仍可兑换奖励，不属于分段）→ "rewardEndAt"。
   - 只有起止中一端明确时，只填那一端，另一端不填。
3. 配图：动态图片按顺序编号（1 开始）。若某张图是该条目的主视觉海报 → 填 "bannerImageIndex"（该图的编号）；图中无对应主图则省略。
4. 标签：动态正文里的 #话题# 提取到 "tags" 数组（去掉 #，保留原文）。
5. 每条条目给出 confidence（0~1，表示你对字段正确性的把握）与 evidence（你判断依据的原文关键句）。

## 输出格式（严格 JSON，不要输出任何其他文字；除 type/slot/title/confidence/evidence 外均可省略）
{
  "items": [
    {
      "type": "ACTIVITY | GACHA | SHOP | COLLAB | ANNOUNCEMENT",
      "slot": "activity | gacha | shop | collab | announcement",
      "title": "条目标题（简短，含版本/活动名）",
      "summary": "一句话简述",
      "description": "条目详细说明（从正文/图中文本提炼的活动详情）",
      "category": "子类型（如 SideStory/限定寻访/维护公告/限时礼包）",
      "url": "动态中给出的活动页/公告链接",
      "startAt": "YYYY-MM-DDTHH:mm",
      "endAt": "YYYY-MM-DDTHH:mm",
      "startRef": "无法锚定时的开始时间原文",
      "endRef": "无法锚定时的结束时间原文",
      "rewardEndAt": "YYYY-MM-DDTHH:mm",
      "phases": [{"title": "段名（原文有就用原文）", "startAt": "YYYY-MM-DDTHH:mm", "endAt": "YYYY-MM-DDTHH:mm", "estimated": false}],
      "bannerImageIndex": 1,
      "tags": ["话题标签"],
      "estimated": false,
      "confidence": 0.9,
      "evidence": "原文关键句"
    }
  ]
}`;
}

/** 单条 LLM 输出条目的原始形态（宽松） */
interface RawEntry {
  type?: string;
  slot?: string;
  title?: string;
  summary?: string;
  description?: string;
  category?: string;
  url?: string;
  startAt?: string;
  endAt?: string;
  startRef?: string;
  endRef?: string;
  rewardEndAt?: string;
  phases?: { title?: string; startAt?: string; endAt?: string; startRef?: string; endRef?: string; estimated?: boolean }[];
  bannerImageIndex?: number;
  tags?: string[];
  estimated?: boolean;
  confidence?: number;
  evidence?: string;
}

/** LLM 大类/slot 白名单（与 Prompt 枚举一致） */
const VALID_TYPES = ['ACTIVITY', 'GACHA', 'SHOP', 'COLLAB', 'ANNOUNCEMENT'] as const;
const VALID_SLOTS = ['activity', 'gacha', 'shop', 'collab', 'announcement'] as const;

/** "YYYY-MM-DDTHH:mm"（或带秒/时区）→ Unix 秒；解析失败返回 undefined */
function toUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso.length === 16 ? `${iso}:00+08:00` : iso); // 无时区按北京时间
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** 北京时间格式化（sv-SE locale 输出 ISO 样式，供 LLM 上下文与时间推算参照） */
const CST_DT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const CST_D = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
/** 北京时间格式化（sv-SE locale 输出 ISO 样式，供 LLM 上下文与时间推算参照；亦供展示层复用） */
export const fmtCst = (unix: number): string => CST_DT.format(unix * 1000);

/** 短哈希（djb2，base36）：同一动态拆出的多条同类条目靠标题区分 id，避免撞键 */
function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 校验并规整一条 LLM 输出 → Entry；不合法返回 null（宁缺毋滥） */
function normalizeEntry(post: StoredPost, raw: RawEntry): Entry | null {
  const type = raw.type;
  const slot = raw.slot ?? raw.type?.toLowerCase();
  const title = raw.title?.trim();
  if (!title || !type) return null;
  if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) return null;
  if (!VALID_SLOTS.includes(slot as (typeof VALID_SLOTS)[number])) return null;

  const startAt = toUnix(raw.startAt);
  const endAt = toUnix(raw.endAt);
  const rewardEndAt = toUnix(raw.rewardEndAt);
  // 无任何时间信息且无引用型时间的条目无排期价值
  if (startAt === undefined && endAt === undefined && !raw.startRef && !raw.endRef) return null;

  // banner：LLM 指定第几张动态图（1-based）为主视觉
  const bannerIdx = raw.bannerImageIndex;
  const banner =
    bannerIdx && post.images && bannerIdx >= 1 && bannerIdx <= post.images.length
      ? { url: post.images[bannerIdx - 1] }
      : undefined;

  // 引用型时间：LLM 只产原文，state 由代码初始化为 unanchored，锚定由回填扫描负责
  const toRef = (text: string | undefined) =>
    text?.trim() ? { refText: text.trim(), state: 'unanchored' as const } : undefined;

  const fields = ['type', 'title'];
  if (raw.summary?.trim()) fields.push('summary');
  if (startAt !== undefined || endAt !== undefined || raw.startRef || raw.endRef) fields.push('schedule');

  const provenance: EntryPayload['provenance'] = [{ fields, method: 'llm', evidence: raw.evidence ?? post.title }];
  if (post.description) provenance.push({ fields: ['description'], method: 'source', evidence: '动态正文' });
  if (post.images?.length) provenance.push({ fields: ['ocrTexts'], method: 'ocr', evidence: `${post.images.length} 张图片 OCR 文本` });

  const payload: EntryPayload = {
    summary: raw.summary?.trim() || undefined,
    description: raw.description?.trim() || undefined,
    category: raw.category?.trim() || undefined,
    banner,
    tags: raw.tags?.map((t) => t.trim()).filter(Boolean),
    startRef: toRef(raw.startRef),
    endRef: toRef(raw.endRef),
    rewardEndAt,
    phases: raw.phases
      ?.map((p, i) => ({
        index: i + 1,
        title: p.title,
        startAt: toUnix(p.startAt),
        endAt: toUnix(p.endAt),
        startRef: toRef(p.startRef),
        endRef: toRef(p.endRef),
        estimated: p.estimated === true ? true : undefined,
      })),
    estimated: raw.estimated === true ? true : undefined,
    confidence: typeof raw.confidence === 'number' ? Math.min(Math.max(raw.confidence, 0), 1) : 0.5,
    provenance,
  };

  // id 尾部拼标题短哈希：同 post 同 slot 的多条条目互不撞键
  const slug = hash36(title);
  return {
    id: `${post.gameId}:${type}:${post.sourceId}/${slot}:${slug}`,
    postId: post.id,
    gameId: post.gameId,
    type: type as EntryType,
    source: SOURCE,
    sourceId: `${post.sourceId}/${slot}:${slug}`,
    title,
    url: raw.url?.trim() || post.url,
    publishedAt: post.publishedAt,
    startAt,
    endAt,
    payload,
  };
}

/** 组装送 LLM 的用户消息（正文 + 各图 OCR 文本）；返回 null 表示无有效文本，跳过 */
async function buildUserContent(post: StoredPost, gameName: string): Promise<string | null> {
  const ocrTexts = await loadOcrTexts(post.id);
  const parts: string[] = [];
  if (post.description?.trim()) parts.push(`【动态正文】\n${post.description.trim()}`);
  ocrTexts.forEach((t, i) => parts.push(`【图片${i + 1} OCR 文本】\n${t.trim()}`));
  if (parts.length === 0) return null;
  return `游戏：${gameName}\n动态标题：${post.title}\n发布时间：${fmtCst(post.publishedAt)}（北京时间）\n\n${parts.join('\n\n')}`;
}

/**
 * 处理单条动态（批处理与单条测试共用的核心路径）：
 * 组装上下文 → 关键词预过滤 → LLM 拆分 → 规整 → （save=true 时）替换入库并标记。
 * save=false 为 dry-run：只算不写，不消耗幂等状态，可反复测试。
 * failed 时带 infra 标记（基础设施失败，供熔断判定）。
 */
async function processPost(
  post: StoredPost,
  gameNames: Record<string, string>,
  save: boolean,
): Promise<{ status: 'processed' | 'skipped' | 'failed'; entries: Entry[]; user: string | null; infra?: boolean }> {
  const user = await buildUserContent(post, gameNames[post.gameId] ?? post.gameId);
  if (!user) {
    // 正文与 OCR 均为空，无从结构化：标记跳过避免反复进入队列
    if (save) await markExtracted(post.id);
    return { status: 'skipped', entries: [], user };
  }
  // 关键词预过滤：完全不含任何活动相关词的动态直接跳过，省 token
  const haystack = `${post.title}\n${user}`;
  if (!KEYWORDS.some((k) => haystack.includes(k))) {
    log.debug('预过滤跳过 postId=%s', post.id);
    if (save) await markExtracted(post.id);
    return { status: 'skipped', entries: [], user };
  }

  try {
    const out = (await chatJSON({
      // 发布时间与当前日期均给北京时间，避免"X天后/本周五"相对推算被 UTC 口径带偏
      system: systemPrompt(gameNames[post.gameId] ?? post.gameId, fmtCst(post.publishedAt), CST_D.format(Date.now())),
      user,
    })) as { items?: RawEntry[] };

    const entries = (Array.isArray(out.items) ? out.items : [])
      .map((raw) => normalizeEntry(post, raw))
      .filter((e): e is Entry => e !== null);
    if (save) {
      await replaceEntriesForPost(post.id, entries);
      await markExtracted(post.id);
    }
    log.debug(
      '结构化完成 postId=%s entries=%d types=%s',
      post.id, entries.length, entries.map((e) => e.type).join(',') || '-',
    );
    return { status: 'processed', entries, user };
  } catch (e) {
    const isInfra = e instanceof LlmInfraError;
    if (save) await markExtractFailure(post.id, (e as Error).message, isInfra);
    log.error({ err: e }, isInfra ? '结构化基础设施失败(不计次数) postId=%s' : '结构化失败 postId=%s attempts将累加', post.id);
    return { status: 'failed', entries: [], user, infra: isInfra };
  }
}

/** LLM 结构化主流程：返回 { processed, skipped, entries, failed } */
export async function extractEntries(gameNames: Record<string, string>): Promise<{
  processed: number;
  skipped: number;
  entries: number;
  failed: number;
  aborted: boolean;
}> {
  if (!llmEnabled()) {
    log.warn('LLM 未配置，结构化跳过（可在 .env 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）');
    return { processed: 0, skipped: 0, entries: 0, failed: 0, aborted: false };
  }
  log.info('LLM 结构化开始 model=%s', llmConfig());

  const cooldown = RETRY_COOLDOWN();
  const candidates = await listPostsToExtract(MAX_ATTEMPTS(), cooldown);
  const pending = candidates.slice(0, BATCH_LIMIT());
  const t0 = Date.now();
  log.info('待结构化动态 pending=%d batchLimit=%d maxAttempts=%d cooldown=%ds', candidates.length, BATCH_LIMIT(), MAX_ATTEMPTS(), cooldown);

  let processed = 0;
  let skipped = 0;
  let entryCount = 0;
  let failed = 0;
  let infraStreak = 0;
  let aborted = false;

  for (const post of pending) {
    if (aborted) {
      skipped++;
      continue;
    }
    const r = await processPost(post, gameNames, true);
    if (r.status === 'processed') {
      processed++;
      infraStreak = 0;
    } else if (r.status === 'skipped') {
      skipped++;
    } else {
      failed++;
      // 基础设施连续失败（key 失效/网络不通）时熔断本批剩余，防白烧超时与 token
      if (r.infra) {
        infraStreak++;
        if (infraStreak >= INFRA_BREAK_STREAK) {
          log.warn('连续 %d 次基础设施失败，熔断本批剩余动态（下批自动重试），请检查 LLM 配置/服务', infraStreak);
          aborted = true;
        }
      } else {
        infraStreak = 0;
      }
    }
    entryCount += r.entries.length;
  }

  log.info(
    'LLM 结构化完成 processed=%d skipped=%d entries=%d failed=%d aborted=%s costMs=%d',
    processed, skipped, entryCount, failed, aborted, Date.now() - t0,
  );
  return { processed, skipped, entries: entryCount, failed, aborted };
}

/**
 * 单条动态结构化测试（dry-run，不写库、不消耗幂等状态）。
 * 用途：单条验证 LLM 解析效果，如"三角洲 9月30日更新公告"。
 * 返回喂给 LLM 的完整上下文（user）、规整后的条目（entries）与状态；
 * post 按 id 精确匹配，找不到时按 gameId+标题模糊匹配取最新一条。
 */
export async function extractOnePost(
  opts: { postId?: string; gameId?: string; titleLike?: string; save?: boolean } = {},
): Promise<{
  status: 'not_found' | 'llm_disabled' | 'processed' | 'skipped' | 'failed';
  user: string | null;
  entries: Entry[];
}> {
  if (!llmEnabled()) {
    log.warn('LLM 未配置（LLM_BASE_URL / LLM_MODEL）');
    return { status: 'llm_disabled', user: null, entries: [] };
  }
  const post = await findPost(opts);
  if (!post) {
    log.warn('未找到动态 postId=%s gameId=%s titleLike=%s', opts.postId, opts.gameId, opts.titleLike);
    return { status: 'not_found', user: null, entries: [] };
  }
  // 与 scheduler 一致，用预置清单里的中文名组装上下文
  const gameNames = Object.fromEntries(GAMES.map((g) => [g.id, g.name]));
  const r = await processPost(post, gameNames, opts.save === true);
  return { status: r.status, user: r.user, entries: r.entries };
}

/** 按条件查一条动态：优先 postId；否则 gameId+titleLike 取发布时间最新 */
async function findPost(opts: { postId?: string; gameId?: string; titleLike?: string }): Promise<StoredPost | undefined> {
  const posts = await loadPosts();
  if (opts.postId) return posts.find((p) => p.id === opts.postId);
  return posts
    .filter((p) => (!opts.gameId || p.gameId === opts.gameId) && (!opts.titleLike || p.title.includes(opts.titleLike)))
    .sort((a, b) => b.publishedAt - a.publishedAt)[0];
}
