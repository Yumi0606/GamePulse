/**
 * 维护窗口锚定：把「下次维护后」「X月X日维护后」「X月X日维护」等引用型时间
 * 回填为绝对时间戳。
 *
 * 数据流：
 *   posts（停机维护/版本更新公告） --抽取--> maintenance_windows
 *   entries.payload.startRef/endRef（unanchored） --匹配窗口--> startAt/endAt
 *
 * 设计约束：
 * - 全部已登记游戏启用：公告给出明确维护时段即产生窗口，没有时段自然抽不到。
 * - 只处理固定模式，匹配失败保持 unanchored，交给 LLM 语义锚定。
 * - 年份推断限定为条目发布年或次年；锚点与发布时间的距离不超过 45 天，
 *   防止缺失的旧公告让引用吸附到多年后的窗口，产生错误的超长持续时间。
 * - 只写时间字段与 payload 中的 TimeRef，不改标题、来源与 canonicalName。
 * - 全部判断确定性，不消耗 LLM；重复执行幂等。
 */
import type { EntryPayload, MaintenanceWindow, TimeRef } from '../core/types.js';
import { GAMES } from '../core/games.js';
import { moduleLogger } from '../core/logger.js';
import {
  listEntriesByGame,
  listMaintenanceWindows,
  loadPosts,
  updateEntrySchedule,
  upsertMaintenanceWindows,
} from '../storage/store.js';
import type { StoredPost } from '../storage/store.js';

const log = moduleLogger('maintenance');

/** 维护窗口对全部已登记游戏启用；后续新增游戏自动纳入 */
export function maintenanceGameIds(): string[] {
  return GAMES.map((g) => g.id);
}

/** 锚点与条目发布时间的最大允许距离：跨年推断与旧公告缺失的兜底约束 */
export const MAX_ANCHOR_DISTANCE_SEC = 45 * 86400;

/** 锚点是否落在允许范围内（绝对差），语义锚定复用同一约束 */
export function isAnchorWithinConstraints(at: number, referenceAt: number): boolean {
  return Math.abs(at - referenceAt) <= MAX_ANCHOR_DISTANCE_SEC;
}

/** 公告正文里出现这些词才尝试抽取维护窗口 */
const MAINTENANCE_HINT =
  /停机维护|港区改建|停机更新|维护公告|维护时间|维护将于|维护后|版本更新|闪断更新|更新维护|停服维护/;

/**
 * 维护时段的常见写法：
 *   10月22日10:00~16:00
 *   10月22日 10:00 - 10月22日 16:00
 *   2026年10月22日10:00至16:00
 *   2026/10/15 06:00 - 2026/10/15 12:00（先经 normalizeDateTokens 归一）
 * 冒号兼容全角，分隔符兼容 ~ ～ 至 - — 到。
 */
const WINDOW_RE =
  /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})\s*(?:~|～|至|-|—|到)\s*(?:(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*)?(\d{1,2})[:：](\d{2})/g;

/** 把斜杠/点分日期归一为「年月日」，让 WINDOW_RE 只维护一套日期写法 */
function normalizeDateTokens(text: string): string {
  return text.replace(/(\d{4})[/.](\d{1,2})[/.](\d{1,2})/g, '$1年$2月$3日');
}

/** 引用型时间的固定模式分类结果 */
interface FixedRef {
  kind: 'date' | 'next';
  /** 后 = 窗口结束时刻；前 / 无后缀 = 窗口开始时刻 */
  at: 'start' | 'end';
  year?: number;
  month?: number;
  day?: number;
}

/**
 * 固定维护引用词表：
 * - 日期 + 维护（后/前/无后缀），兼容「版本更新维护」「更新维护」「闪断更新」「停服」前缀；
 * - 日期 + 版本更新（后/前/无后缀），不带「维护」二字；
 * - 「下次维护/下次版本更新」与单独的「维护后/版本更新后」。
 */
const DATE_MAINT_RE =
  /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:版本更新|更新维护|闪断更新|停服)?维护(?:结束)?(后|前)?/;
const DATE_UPDATE_RE = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:版本更新|闪断更新)(?:结束)?(后|前)?/;
const NEXT_MAINT_RE = /下次\s*(?:版本更新|更新维护|闪断更新|停服)?维护(?:结束)?(后|前)?/;
const NEXT_UPDATE_RE = /下次\s*(?:版本更新|闪断更新)(?:结束)?(后|前)?/;
const BARE_MAINT_RE = /^(?:版本更新|更新维护|闪断更新|停服)?维护(?:结束)?(后|前)?$/;
const BARE_UPDATE_RE = /^版本更新(?:结束)?(后|前)?$/;

/** 后缀决定锚定窗口的哪一端 */
function edgeOf(suffix: string | undefined): 'start' | 'end' {
  return suffix === '后' ? 'end' : 'start';
}

/** 解析引用中的固定模式；返回 undefined 表示需交给语义锚定 */
function classifyFixedRef(refText: string): FixedRef | undefined {
  const text = refText.trim();
  if (!text) return undefined;

  const dateMatch = DATE_MAINT_RE.exec(text) ?? DATE_UPDATE_RE.exec(text);
  if (dateMatch) {
    return {
      kind: 'date',
      year: dateMatch[1] ? Number(dateMatch[1]) : undefined,
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
      at: edgeOf(dateMatch[4]),
    };
  }

  const nextMatch = NEXT_MAINT_RE.exec(text) ?? NEXT_UPDATE_RE.exec(text);
  if (nextMatch) return { kind: 'next', at: edgeOf(nextMatch[1]) };

  const bareMatch = BARE_MAINT_RE.exec(text) ?? BARE_UPDATE_RE.exec(text);
  if (bareMatch) return { kind: 'next', at: edgeOf(bareMatch[1]) };

  return undefined;
}

/** 是否为确定性可处理的维护引用；语义锚定只处理返回 false 的引用 */
export function isFixedMaintenanceRef(refText: string): boolean {
  return classifyFixedRef(refText) !== undefined;
}

/** 引用是否含维护语义；纯日期（10.22、10月15日）不送语义锚定 */
export function hasMaintenanceSemantics(refText: string): boolean {
  return /维护|更新|版本|停服|闪断|开服/.test(refText);
}

const CST_DAY = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const CST_YEAR_MONTH = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
});

function cstParts(unix: number): { year: number; month: number; day: number } {
  const [y, m, d] = CST_DAY.format(unix * 1000).split('-').map(Number);
  return { year: y, month: m, day: d };
}

function cstYearMonth(unix: number): { year: number; month: number } {
  const [y, m] = CST_YEAR_MONTH.format(unix * 1000).split('-').map(Number);
  return { year: y, month: m };
}

/** 按北京时间构造 Unix 秒；返回 undefined 表示日期非法 */
function cstUnix(year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const ms = Date.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * 年份缺失时按公告发布时间推断：月份比公告月份早 6 个月以上，视为跨年。
 * 例：12 月公告写「1月8日」，实际是次年。
 */
function inferYear(announcedAt: number, month: number): number {
  const { year, month: announcedMonth } = cstYearMonth(announcedAt);
  return month < announcedMonth - 6 ? year + 1 : year;
}

/** 从单条动态抽取维护窗口；没有日期时段则返回空 */
export function parseMaintenanceWindows(post: StoredPost): MaintenanceWindow[] {
  const raw = `${post.title}\n${post.description ?? ''}`;
  if (!MAINTENANCE_HINT.test(raw)) return [];
  const text = normalizeDateTokens(raw);
  const announcedAt = post.publishedAt ?? post.firstSeenAt;
  const found = new Map<string, MaintenanceWindow>();
  WINDOW_RE.lastIndex = 0;
  for (const m of text.matchAll(WINDOW_RE)) {
    const [, y1, mo1, d1, h1, mi1, y2, mo2, d2, h2, mi2] = m;
    const startYear = y1 ? Number(y1) : inferYear(announcedAt, Number(mo1));
    const endYear = y2 ? Number(y2) : y1 ? startYear : inferYear(announcedAt, Number(mo2 ?? mo1));
    const startAt = cstUnix(startYear, Number(mo1), Number(d1), Number(h1), Number(mi1));
    const endAt = cstUnix(endYear, Number(mo2 ?? mo1), Number(d2 ?? d1), Number(h2), Number(mi2));
    if (!startAt || !endAt || endAt <= startAt) continue;
    // 维护窗口通常不超过 12 小时；超过说明匹配到了跨活动的两段时间，丢弃
    if (endAt - startAt > 12 * 3600) continue;
    const id = `${post.gameId}:${startAt}`;
    found.set(id, {
      id,
      gameId: post.gameId,
      startAt,
      endAt,
      announcedAt,
      sourcePostId: post.id,
    });
  }
  return [...found.values()];
}

/** 扫描全部动态，抽取并写入维护窗口；返回本次识别到的窗口数 */
export async function syncMaintenanceWindows(): Promise<number> {
  const startedAt = Date.now();
  const posts = await loadPosts();
  const windows: MaintenanceWindow[] = [];
  // 不按游戏过滤：公告有明确时段就入库，没有就自然抽不到
  for (const post of posts) windows.push(...parseMaintenanceWindows(post));
  const n = await upsertMaintenanceWindows(windows);
  log.info('维护窗口同步完成 识别=%d 耗时=%dms', n, Date.now() - startedAt);
  return n;
}

/**
 * 为一条引用的固定模式查找维护窗口：
 * - X月X日维护后 / 版本更新后：当天窗口的结束时刻；
 * - X月X日维护 / 维护前：当天窗口的开始时刻；
 * - 下次维护后 / 下次维护：发布日之后最近窗口（含当天）的对应端点。
 * 无年份时只在发布年与次年两个候选年内查找；锚点距离发布时间超过 45 天视为误配。
 */
function matchWindow(refText: string, referenceAt: number, windows: MaintenanceWindow[]): { window: MaintenanceWindow; at: number } | undefined {
  const fixed = classifyFixedRef(refText);
  if (!fixed) return undefined;

  if (fixed.kind === 'date') {
    const publishYear = cstParts(referenceAt).year;
    const candidates = fixed.year != null ? [fixed.year] : [publishYear, publishYear + 1];
    let best: { window: MaintenanceWindow; at: number; distance: number } | undefined;
    for (const year of candidates) {
      const window = windows.find((w) => {
        const p = cstParts(w.startAt);
        return p.year === year && p.month === fixed.month && p.day === fixed.day;
      });
      if (!window) continue;
      const at = fixed.at === 'end' ? window.endAt : window.startAt;
      if (!isAnchorWithinConstraints(at, referenceAt)) continue;
      const distance = Math.abs(at - referenceAt);
      if (!best || distance < best.distance) best = { window, at, distance };
    }
    return best ? { window: best.window, at: best.at } : undefined;
  }

  // 下次维护：窗口不能早于发布前一天（允许维护当天发布公告），且锚点距离受限
  const window = windows.find((w) => {
    if (w.startAt < referenceAt - 86400) return false;
    const at = fixed.at === 'end' ? w.endAt : w.startAt;
    return isAnchorWithinConstraints(at, referenceAt);
  });
  if (!window) return undefined;
  return { window, at: fixed.at === 'end' ? window.endAt : window.startAt };
}

function anchorRef(
  ref: TimeRef | undefined,
  referenceAt: number,
  windows: MaintenanceWindow[],
): { ref: TimeRef; at: number } | undefined {
  if (!ref || ref.state === 'anchored') return undefined;
  const hit = matchWindow(ref.refText, referenceAt, windows);
  if (!hit) return undefined;
  return {
    ref: { ...ref, refId: hit.window.id, state: 'anchored' },
    at: hit.at,
  };
}

export interface AnchorResult {
  /** 扫描的条目数 */
  scanned: number;
  /** 发生字段更新的条目数 */
  changed: number;
  /** 仍无法锚定的引用数 */
  unanchored: number;
}

/** 对某游戏的全部条目做一次确定性回填，幂等 */
export async function anchorMaintenanceRefs(gameId: string): Promise<AnchorResult> {
  const startedAt = Date.now();
  const windows = await listMaintenanceWindows(gameId);
  const entries = await listEntriesByGame(gameId);
  let changed = 0;
  let unanchored = 0;
  let rejected = 0;

  for (const entry of entries) {
    const payload: EntryPayload = { ...entry.payload };
    const referenceAt = entry.publishedAt ?? entry.firstSeenAt;
    let startAt = entry.startAt;
    let endAt = entry.endAt;

    const started = anchorRef(payload.startRef, referenceAt, windows);
    let appliedStart = false;
    if (started) {
      startAt = started.at;
      payload.startRef = started.ref;
      appliedStart = true;
    }
    const ended = anchorRef(payload.endRef, referenceAt, windows);
    let appliedEnd = false;
    if (ended) {
      endAt = ended.at;
      payload.endRef = ended.ref;
      appliedEnd = true;
    }

    // 区间自洽校验：结束早于开始说明至少一端锚错（多因引用指向了另一个维护窗口），
    // 撤销本次新增的锚定，保留原引用等待后续公告。
    if (startAt != null && endAt != null && endAt <= startAt) {
      if (appliedStart) {
        payload.startRef = entry.payload.startRef;
        startAt = entry.startAt;
        appliedStart = false;
      }
      if (appliedEnd) {
        payload.endRef = entry.payload.endRef;
        endAt = entry.endAt;
        appliedEnd = false;
      }
      rejected++;
      log.debug('回填区间不自洽，撤销本次锚定 entryId=%s', entry.id);
    }

    const touched: string[] = [];
    const evidence: string[] = [];
    if (appliedStart && started) {
      touched.push('startAt');
      evidence.push(`startRef="${started.ref.refText}" → ${started.ref.refId}`);
    }
    if (appliedEnd && ended) {
      touched.push('endAt');
      evidence.push(`endRef="${ended.ref.refText}" → ${ended.ref.refId}`);
    }

    if (payload.startRef && payload.startRef.state !== 'anchored') unanchored++;
    if (payload.endRef && payload.endRef.state !== 'anchored') unanchored++;

    // 预估标记校正：仍有一端是未锚定的日期推断值（有绝对时间但无公告锚点）时保留"预估"；
    // 全部锚定后才撤销。纯引用（无绝对时间）不标记预估。
    const pendingStart = payload.startRef && payload.startRef.state !== 'anchored' && startAt != null;
    const pendingEnd = payload.endRef && payload.endRef.state !== 'anchored' && endAt != null;
    const shouldEstimate = Boolean(pendingStart || pendingEnd);
    const estimatedWrong = shouldEstimate ? payload.estimated !== true : payload.estimated === true;

    if (touched.length === 0) {
      if (!estimatedWrong) continue;
      // 只修正标记，不动时间字段
      payload.estimated = shouldEstimate;
      await updateEntrySchedule(entry.id, startAt, endAt, payload);
      changed++;
      continue;
    }
    payload.provenance = [
      ...(payload.provenance ?? []),
      { fields: touched, method: 'maintenance-anchor', evidence: evidence.join('; ') },
    ];
    payload.estimated = shouldEstimate;
    await updateEntrySchedule(entry.id, startAt, endAt, payload);
    changed++;
  }

  log.info(
    '维护引用回填完成 gameId=%s 窗口=%d 扫描=%d 更新=%d 未锚定=%d 撤销=%d 耗时=%dms',
    gameId,
    windows.length,
    entries.length,
    changed,
    unanchored,
    rejected,
    Date.now() - startedAt,
  );
  return { scanned: entries.length, changed, unanchored };
}

/** 同步窗口后对所有已登记游戏执行回填 */
export async function anchorAllMaintenanceRefs(): Promise<AnchorResult[]> {
  const results: AnchorResult[] = [];
  for (const gameId of maintenanceGameIds()) {
    results.push(await anchorMaintenanceRefs(gameId));
  }
  return results;
}
