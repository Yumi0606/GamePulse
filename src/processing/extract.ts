import type { Entry, EntryPayload, EntryType } from '../core/types.js';
import { eventKey, normalizeCanonicalName } from '../core/types.js';
import { loadOcrTexts, loadPosts, listPostsToExtract, markExtractFailure, markExtracted, replaceEntriesForPost, type StoredPost } from '../storage/store.js';
import { chatJSON, llmConfig, llmEnabled, LlmInfraError } from './llm.js';
import { gameRuleFor, normalizeCategory } from './gameRules.js';
import { recallCandidates, type RecallCandidate } from './recall.js';
import { GAMES } from '../core/games.js';
import { envNum, envStr } from '../core/env.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('extract');

/**
 * LLM 结构化（结构化处理链第二步，见 PRD §5.3）：
 * 动态（正文 + 图片 OCR 文本）→ 拆分为活动/卡池/公告条目（entries 表）。
 *
 * 链路：选待处理动态 → 组装上下文（正文 + OCR + 发布日期 + 当前日期）→ LLM 拆分 →
 *       校验与规整（时间字符串转 Unix 秒、id 合成、置信度/溯源）→ 整体替换入库。
 * 不做关键词预过滤：是否与排期有关由 Prompt 规则判断，避免因词表覆盖不全永久漏掉活动。
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

/** 系统提示：任务定义 + 数据模型 + 时间解析规则 + 输出格式（字段与《调研报告-活动数据结构》§4 对齐） */
function systemPrompt(
  gameId: string,
  gameName: string,
  publishedAt: string,
  today: string,
  candidates: RecallCandidate[],
): string {
  const rule = gameRuleFor(gameId);
  const categoryBlock = rule
    ? Object.entries(rule.categories)
      .map(([type, cats]) => `  - ${type}：${(cats ?? []).join(' / ')}`)
      .join('\n')
    : '';
  const gameRule = rule
    ? `${rule.prompt}\n\n### 本游戏 category 词表（只能选其中值，无合适值选"其他"）\n${categoryBlock}`
    : '';
  return `你是游戏运营信息结构化助手。任务：把游戏官方社媒动态解析为结构化的排期条目。

目标游戏：${gameName}
动态发布时间：${publishedAt}（作为"今天/X天后/本周五"等相对表述的参照）
当前日期：${today}
动态中的时间均为游戏服务器时间（国服=北京时间 UTC+8），无需时区换算。

## 条目大类（type 只能取以下值）
- ACTIVITY：游戏内限时活动（副本活动、签到、赛季、危机合约等）；版本更新/核心章节上线本身也算
- GACHA：卡池/祈愿/寻访（标准池、限定池、联动池、新手池）。**必须原文明确出现寻访/祈愿/卡池开启、概率 UP、某角色进池等招募信息**；仅"新角色登场/上线/依次登场"而无开启时间或概率说明，不算 GACHA（此时至多作为 ACTIVITY 版本预告）
- SHOP：限时商品（礼包、组合包、限时皮肤、月卡上架）
- COLLAB：现实世界联动活动（线下联动、IP 合作、主题店、联动展，非游戏内玩法）
- ANNOUNCEMENT：官方公告（维护预告、问题修复、补偿说明等纯文字通告）
注意：
- 抽奖转发、周边/表情包/贴纸/头像上架、视频投稿、玩家问卷等与游戏内排期无关的内容 → 输出空数组。
- **固定引流尾注不是活动信息**：正文末尾以分隔线（如「————————」「----」）隔开、以「▼」等符号引导、含版本上线预告 / 下载地址 / 图文地址的段落，是账号在多条动态中逐字重复的模板。这类段落不得作为任何条目的证据，也不得据此产出条目；只有出现在动态主体（正文有效段落或图片 OCR）中的信息才算数。
- 若动态主体本身与排期无关（如仅发布表情包、壁纸、视频），即使尾注提到版本或活动名，也输出空数组；只有主体中确实介绍了某个活动的具体排期（时间、玩法或奖励）时才为它建条目。
- 时间视角：以动态发布时间为基准，只收录对读者仍有行动价值（可参与、可领取、可提前安排）的排期。
  展会/活动的返图、留影、回顾、圆满结束、战报、"感谢参与"等报道类内容，即使活动尚未完全结束，也不产出条目；
  不要用报道中的历史时间反推条目。只有面向未来的预告、进行中仍可参与的活动、"即将结束/最后 X 天"提醒才产出。
不确定的信息宁可不产出（宁缺毋滥），不要编造。

## 提取规则
1. 一条动态可以拆出多条条目（如同时预告活动和卡池），也可以产出 0 条。
2. 时间解析：
   - 同时给出日期与时刻（"2026/10/01 12:00"、"10月1日 12:00"）→ 输出 "YYYY-MM-DDTHH:mm"，代码侧转 Unix 秒。
   - 只给日期、没有时刻（"10月8日"、"10月8日维护后"、"10月15日维护"）→ 输出纯日期 "YYYY-MM-DD"（省略时间部分），代码会按该游戏的缺省更新时刻补全；**同时把原文表述原样填入对应一端的 "startRef"/"endRef"**（如 startRef="10月8日维护后"），用于页面标注该时刻为缺省预估，代码会自动置 estimated=true。
   - 原文没写年份/日期、由你按上下文补全推断的 → 输出你推断的日期/时刻，同时置 "estimated": true。
   - 相对活动起止可推算的偏移表述（"开启后第8天"、"一周后"、"第2周"）→ 不要留 ref，按活动起止推算为具体日期或时刻，并置 "estimated": true。
   - 只有完全无法定位到任何日期的表述（如"版本结束"、"维护后"且上下文无具体日期）→ 才只填 "startRef"/"endRef" 保留原文，不填 startAt/endAt。
   - 活动分段（尽可能拆）：活动期内分批开放/新增/解锁的内容都是分段信号——"第X天"、"一周后"、"X月X日起新增"、"上半/下半"、"第一阶段/第二阶段"等，即使原文没有"阶段"字样也要拆成 "phases"。每段 {"title": 段名（原文有就用原文，没有就按内容概括，如"兑换处新增物资"）, "startAt"/"endAt" 或 "startRef"/"endRef", "estimated"}；段时间规则同上；各段按时间顺序排列，段与段可重叠或相邻。
   - 分段宁多勿漏：漏掉分批开放节点会让排期提醒缺失；把握不足的段照样拆出，置 "estimated": true 并降低 confidence。
   - 奖励领取期（活动结束后仍可兑换奖励，不属于分段）→ "rewardEndAt"。
   - 只有起止中一端明确时，只填那一端，另一端不填。
3. 配图：动态图片按顺序编号（1 开始）。若某张图是该条目的主视觉海报 → 填 "bannerImageIndex"（该图的编号）；图中无对应主图则省略。
4. 标签：动态正文里的 #话题# 提取到 "tags" 数组（去掉 #，保留原文）。
5. 每条条目给出 confidence（0~1，表示你对字段正确性的把握）与 evidence（你判断依据的原文关键句）。
   - evidence 必须引用动态主体（正文有效段落或图片 OCR）中的原句，不得引用固定引流尾注。
   - ACTIVITY / COLLAB / GACHA 条目至少要满足其一：给出时间区间（startAt 或 endAt 至少一端），或给出可执行的玩法/奖励说明。两者皆无 → 不产出该条目。
6. canonicalName（活动规范名，必填）：同一现实活动/卡池/商品/事件在多条动态报道中必须给出**完全一致**的规范名，供跨动态合并。
   - **只保留活动专名本身**。禁止拼接版本名、系列名、大类前缀与宣传措辞，例如错误写法：「丹青渡」全新活动「烟火生缘」、「丹青渡」核心章节版本开启 - 新活动「烟火生缘」、趣味活动·烟火生缘、新区域开放·祀的画；正确写法：烟火生缘、祀的画。
     若官方专名本身包含「版本」等字样（如「丹青渡」版本活动），按官方名称整体保留，不要额外叠加其他前缀。
   - 必须包含区分不同实例的要素：有官方期数/阶段的含期数（如"第一期""第二段"）；周期性同名条目（常驻寻访、周更商店）含当期核心对象（UP 角色/商品名）；都没有时才追加日期区分。
   - 例：多条"特许寻访「烟火邀星河」（明河）"报道 → 统一 "特许寻访·烟火邀星河（明河）"；汉堡王联动的 PV 与详情帖 → 统一 "汉堡王联动·美味通行堡已就位"。
7. matchedEntryId（跨动态去重，仅当本游戏已有条目时可填）：下面候选表列出了本游戏历史条目的专名（已去掉模板词）、规范名与时间。
   - **新建条目前必须先逐行比对「专名」列**：把你得到的活动专名去模板词后，与候选表每一行做完全相等比对；命中就必须复用该行的 id 与 canonicalName，不得新建。
   - 同一活动被另一条动态报道过，或本条动态是对同一活动的补充说明 → 必须填 "matchedEntryId": 候选表「同组全部 id」中的任意一个（通常取第一个），并原样复制该行 canonicalName。
   - **同组全部 id 是同一活动的历史残留，不是多个活动**：不要为它们分别建条目，也不要因为组内 id 多就视为不同活动。
   - 前缀/后缀/措辞差异不影响判断：专名相同即 same-event，例如"烟火生缘"与"「丹青渡」全新活动「烟火生缘」"是同一个活动。
   - 只是名称相似但实际是不同活动（不同赛季、不同批次、不同期数）→ 不要填。
   - 只能匹配 type 相同的候选。
   - 同时填 "matchReason"，取值 reused-name（命名一致）| same-event（同一场活动）| same-reward（同一奖励/同一商品）。
   - 确定是新活动时不填这两个字段。

${candidateBlock(candidates)}

${gameRule}

## 输出格式（严格 JSON，不要输出任何其他文字；除 type/slot/title/canonicalName/confidence/evidence 外均可省略）
{
  "items": [
    {
      "type": "ACTIVITY | GACHA | SHOP | COLLAB | ANNOUNCEMENT",
      "slot": "activity | gacha | shop | collab | announcement",
      "title": "条目标题（简短，含版本/活动名）",
      "canonicalName": "跨动态稳定的活动规范名（见规则 6，必填）",
      "summary": "一句话简述",
      "description": "条目详细说明（从正文/图中文本提炼的活动详情）",
      "category": "子类型（必须取游戏专属规则词表中的值）",
      "url": "动态中给出的活动页/公告链接",
      "startAt": "YYYY-MM-DDTHH:mm 或 YYYY-MM-DD",
      "endAt": "YYYY-MM-DDTHH:mm 或 YYYY-MM-DD",
      "startRef": "纯日期时的原文表述；或无法锚定时的开始时间原文",
      "endRef": "纯日期时的原文表述；或无法锚定时的结束时间原文",
      "rewardEndAt": "YYYY-MM-DDTHH:mm 或 YYYY-MM-DD",
      "phases": [{"title": "段名（原文有就用原文）", "startAt": "YYYY-MM-DDTHH:mm", "endAt": "YYYY-MM-DDTHH:mm", "estimated": false}],
      "bannerImageIndex": 1,
      "tags": ["话题标签"],
      "estimated": false,
      "confidence": 0.9,
      "evidence": "原文关键句",
      "matchedEntryId": "候选 id（见候选表；无匹配则省略）",
      "matchReason": "reused-name | same-event | same-reward"
    }
  ]
}`;
}

/**
 * 候选表文本：把召回结果渲染为紧凑的 Markdown 表格。
 * 无候选时返回说明行，明确告知 LLM 本次没有可复用条目。
 */
function candidateBlock(candidates: RecallCandidate[]): string {
  if (candidates.length === 0) {
    return '## 本游戏历史条目候选\n（暂无候选，本次全部作为新活动产出，省略 matchedEntryId）';
  }
  const fmt = (unix: number | undefined): string =>
    unix === undefined ? '—' : fmtCst(unix).slice(0, 10);
  const rows = candidates.map((c) =>
    `| ${c.entryId} | ${c.type} | ${c.eventKey || c.canonicalName} | ${c.canonicalName} | ${c.entryIds.join(',')} | ${c.title} | ${fmt(c.startAt)} | ${fmt(c.endAt)} |`,
  );
  return [
    '## 本游戏历史条目候选（判定为同一活动时必须复用其 id 与 canonicalName）',
    '| id | type | 专名（去模板词） | canonicalName | 同组全部 id | 标题 | 开始 | 结束 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/** 单条 LLM 输出条目的原始形态（宽松） */
interface RawEntry {
  type?: string;
  slot?: string;
  title?: string;
  canonicalName?: string;
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
  /** 命中的候选条目 id（跨动态去重）；非法值时降级为新建 */
  matchedEntryId?: string;
  /** 匹配依据，写入 provenance 供人工抽查 */
  matchReason?: string;
}

/** LLM 大类/slot 白名单（与 Prompt 枚举一致） */
const VALID_TYPES = ['ACTIVITY', 'GACHA', 'SHOP', 'COLLAB', 'ANNOUNCEMENT'] as const;
const VALID_SLOTS = ['activity', 'gacha', 'shop', 'collab', 'announcement'] as const;

/**
 * 纯日期（YYYY-MM-DD）补全用的游戏缺省活动更新时刻（北京时间）。
 * 原文只给日期（如"10月8日维护后"）时按此补时刻，同时 LLM 保留原文到 startRef/endRef 并标记 estimated。
 */
const DATE_DEFAULT_TIME: Record<string, { hour: number; minute: number }> = {
  arknights: { hour: 4, minute: 0 },       // 明日方舟日常刷新 04:00
  endfield: { hour: 12, minute: 0 },       // 终末地活动多在 12:00
  'delta-force': { hour: 0, minute: 0 },   // 三角洲
  'wuthering-waves': { hour: 4, minute: 0 }, // 鸣潮
  'azur-lane': { hour: 0, minute: 0 },     // 碧蓝航线
};

function dateDefaultTime(gameId: string): { hour: number; minute: number } {
  return DATE_DEFAULT_TIME[gameId] ?? { hour: 0, minute: 0 };
}

/**
 * 解析 LLM 输出的时间：
 * - 纯日期 "YYYY-MM-DD"：原文只给日期（如"10月8日维护后"），按游戏缺省时刻补全，
 *   dateOnly=true 由调用方标记 estimated；LLM 同时把原文留在 startRef/endRef 供展示；
 * - "YYYY-MM-DDTHH:mm"：无时区按北京时间；
 * - 其余（带时区/秒）交给 Date.parse。
 * 解析失败返回 undefined。
 */
function parseTime(iso: string | undefined, gameId: string): { unix: number; dateOnly: boolean } | undefined {
  if (!iso) return undefined;
  const s = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = dateDefaultTime(gameId);
    const hh = String(d.hour).padStart(2, '0');
    const mm = String(d.minute).padStart(2, '0');
    const ms = Date.parse(`${s}T${hh}:${mm}:00+08:00`);
    return Number.isFinite(ms) ? { unix: Math.floor(ms / 1000), dateOnly: true } : undefined;
  }
  const ms = Date.parse(s.length === 16 ? `${s}:00+08:00` : s);
  return Number.isFinite(ms) ? { unix: Math.floor(ms / 1000), dateOnly: false } : undefined;
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
function normalizeEntry(
  post: StoredPost,
  raw: RawEntry,
  candidates: Map<string, RecallCandidate>,
  keyIndex: Map<string, RecallCandidate>,
): Entry | null {
  const type = raw.type;
  const slot = raw.slot ?? raw.type?.toLowerCase();
  const title = raw.title?.trim();
  if (!title || !type) return null;
  if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) return null;
  if (!VALID_SLOTS.includes(slot as (typeof VALID_SLOTS)[number])) return null;

  // 跨动态去重：命中候选时采纳候选组最早条目的 id 与规范名，命名不一致不再导致合并失败；
  // 候选不存在、跨 type、id 不属于候选表 → 先按 eventKey 精确兜底，仍未命中才新建。
  let matched: RecallCandidate | undefined;
  let matchVia: 'llm' | 'exact-key' | undefined;
  if (raw.matchedEntryId) {
    const c = candidates.get(raw.matchedEntryId);
    if (!c) {
      log.warn('matchedEntryId 不在候选表 postId=%s id=%s', post.id, raw.matchedEntryId);
    } else if (c.type !== type) {
      log.warn('matchedEntryId 跨 type postId=%s id=%s %s≠%s', post.id, raw.matchedEntryId, c.type, type);
    } else {
      matched = c;
      matchVia = 'llm';
    }
  }
  // LLM 未填或填错时，按「type + 去模板词专名」完全相等强制复用。
  // 这是确定性兜底，不做子串/模糊匹配；宁可重复也不漏活动的约束只约束合并键，不放宽匹配范围。
  if (!matched) {
    const key = eventKey(raw.canonicalName?.trim() || title, type);
    const c = key ? keyIndex.get(`${type}\u0000${key}`) : undefined;
    if (c) {
      matched = c;
      matchVia = 'exact-key';
    }
  }

  // canonicalName 必填用于第二阶段跨动态合并；命中候选时复用组内最早条目的规范名，
  // 确保历史重复条目不会被 LLM 的临时命名继续扩散
  const canonicalName = matched ? matched.oldestCanonicalName : raw.canonicalName?.trim() || title;
  // category 受游戏词表约束，词表外值归一为"其他"
  const category = normalizeCategory(post.gameId, type as EntryType, raw.category);

  const start = parseTime(raw.startAt, post.gameId);
  const end = parseTime(raw.endAt, post.gameId);
  const reward = parseTime(raw.rewardEndAt, post.gameId);
  const startAt = start?.unix;
  const endAt = end?.unix;
  const rewardEndAt = reward?.unix;
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
  // 合并审计：记录本次为何把条目归到既有活动，便于回溯误合并
  if (matched) {
    provenance.push({
      fields: ['canonicalName'],
      method: 'merge-id',
      evidence: `via=${matchVia}; matchedEntryId=${raw.matchedEntryId ?? '—'}; resolved=${matched.oldestEntryId}; reason=${raw.matchReason ?? '未说明'}`,
    });
  }

  // 任一端只有日期没有时刻（按 00:00 补全）时，与 LLM 自标预估合并为预估时间
  const dateOnlyEstimated = (start?.dateOnly || end?.dateOnly || reward?.dateOnly) === true;

  const payload: EntryPayload = {
    summary: raw.summary?.trim() || undefined,
    description: raw.description?.trim() || undefined,
    category,
    banner,
    tags: raw.tags?.map((t) => t.trim()).filter(Boolean),
    canonicalName,
    startRef: toRef(raw.startRef),
    endRef: toRef(raw.endRef),
    rewardEndAt,
    phases: raw.phases
      ?.map((p, i) => {
        const ps = parseTime(p.startAt, post.gameId);
        const pe = parseTime(p.endAt, post.gameId);
        return {
          index: i + 1,
          title: p.title,
          startAt: ps?.unix,
          endAt: pe?.unix,
          startRef: toRef(p.startRef),
          endRef: toRef(p.endRef),
          estimated: p.estimated === true || ps?.dateOnly === true || pe?.dateOnly === true ? true : undefined,
        };
      }),
    estimated: raw.estimated === true || dateOnlyEstimated ? true : undefined,
    confidence: typeof raw.confidence === 'number' ? Math.min(Math.max(raw.confidence, 0), 1) : 0.5,
    provenance,
    extra: { postIds: [post.id] },
  };

  // id：命中候选时沿用候选 id（store 按 id 命中后合并），否则由 canonicalName 派生；
  // 两条路径都保持「同一现实活动跨 post 同 id」，重跑不会换 id
  const slug = hash36(normalizeCanonicalName(canonicalName));
  return {
    id: matched ? matched.oldestEntryId : `${post.gameId}:${type}:${slug}`,
    postId: post.id,
    gameId: post.gameId,
    type: type as EntryType,
    source: SOURCE,
    sourceId: `${slug}`,
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
 * 组装上下文 → LLM 拆分 → 规整 → （save=true 时）替换入库并标记。
 * save=false 为 dry-run：只算不写，不消耗幂等状态，可反复测试。
 * failed 时带 infra 标记（基础设施失败，供熔断判定）。
 */
async function processPost(
  post: StoredPost,
  gameNames: Record<string, string>,
  save: boolean,
): Promise<{
  status: 'processed' | 'skipped' | 'failed';
  entries: Entry[];
  user: string | null;
  infra?: boolean;
  /** 送入 LLM 的 system prompt（含候选表），仅用于探针审计 */
  system?: string;
  /** LLM 原始 JSON 输出，仅用于探针审计 */
  raw?: unknown;
}> {
  const user = await buildUserContent(post, gameNames[post.gameId] ?? post.gameId);
  if (!user) {
    // 正文与 OCR 均为空，无从结构化：标记跳过避免反复进入队列
    if (save) await markExtracted(post.id, 0);
    return { status: 'skipped', entries: [], user };
  }
  // 与排期无关的动态由 Prompt 规则判定为 0 条，不在代码侧按关键词拦截：
  // 词表无法覆盖所有游戏的用词，硬过滤会让含活动的动态被永久标记为已处理。
  try {
    // 召回本游戏历史条目作为候选：LLM 若判定为同一活动，复用候选 id 完成跨动态合并
    // 召回查询文本仍取标题 + 正文 + OCR，名称命中兜底依赖它
    const recallText = `${post.title}\n${user}`;
    const candidates = await recallCandidates(post.gameId, recallText);
    const candidateIndex = new Map(candidates.flatMap((c) => c.entryIds.map((id) => [id, c] as const)));
    // eventKey 索引：LLM 未填 matchedEntryId 时的确定性兜底，只做完全相等匹配
    const keyIndex = new Map(candidates.map((c) => [`${c.type}\u0000${c.eventKey}`, c] as const));
    // 发布时间与当前日期均给北京时间，避免"X天后/本周五"相对推算被 UTC 口径带偏
    const system = systemPrompt(
      post.gameId,
      gameNames[post.gameId] ?? post.gameId,
      fmtCst(post.publishedAt),
      CST_D.format(Date.now()),
      candidates,
    );
    const out = (await chatJSON({ system, user })) as { items?: RawEntry[] };

    const entries = (Array.isArray(out.items) ? out.items : [])
      .map((raw) => normalizeEntry(post, raw, candidateIndex, keyIndex))
      .filter((e): e is Entry => e !== null);
    if (save) {
      await replaceEntriesForPost(post.id, entries);
      await markExtracted(post.id, entries.length);
    }
    log.debug(
      '结构化完成 postId=%s entries=%d types=%s',
      post.id, entries.length, entries.map((e) => e.type).join(',') || '-',
    );
    return { status: 'processed', entries, user, system, raw: out };
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
  /** 送入 LLM 的 system prompt（含候选表），仅用于探针审计 */
  system?: string;
  /** LLM 原始 JSON 输出，仅用于探针审计 */
  raw?: unknown;
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
  return { status: r.status, user: r.user, entries: r.entries, system: r.system, raw: r.raw };
}

/** 按条件查一条动态：优先 postId；否则 gameId+titleLike 取发布时间最新 */
async function findPost(opts: { postId?: string; gameId?: string; titleLike?: string }): Promise<StoredPost | undefined> {
  const posts = await loadPosts();
  if (opts.postId) return posts.find((p) => p.id === opts.postId);
  return posts
    .filter((p) => (!opts.gameId || p.gameId === opts.gameId) && (!opts.titleLike || p.title.includes(opts.titleLike)))
    .sort((a, b) => b.publishedAt - a.publishedAt)[0];
}
