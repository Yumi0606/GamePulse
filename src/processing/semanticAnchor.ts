/**
 * 语义时间锚定：处理确定性模式覆盖不了的引用型时间（如「即将上线」「版本结束后」）。
 *
 * 与 maintenance.ts 的分工：
 * - 固定模式（X月X日维护后 / 下次维护后）由代码直接回填，不消耗 LLM；
 * - 其余引用交给 LLM 判断指向哪个维护窗口的哪一端，或明确回答"无法确定"。
 *
 * 触发条件：仅当引用从未检查过，或最新维护公告晚于上次检查时执行一次。
 * LLM 只能从候选窗口中选择，不得自行编造日期；输出经代码校验后写库并记录 provenance。
 */
import type { EntryPayload, TimeRef } from '../core/types.js';
import { moduleLogger } from '../core/logger.js';
import { chatJSON, llmEnabled } from './llm.js';
import {
  hasMaintenanceSemantics,
  isAnchorWithinConstraints,
  isFixedMaintenanceRef,
} from './maintenance.js';
import {
  listEntriesByGame,
  listMaintenanceWindows,
  loadPosts,
  updateEntrySchedule,
} from '../storage/store.js';

const log = moduleLogger('semantic-anchor');

/** 单次调用最多处理的引用数，超出部分留到下一轮 */
const MAX_REFS_PER_CALL = 20;

const CST = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const fmt = (unix: number): string => CST.format(unix * 1000);

interface RefTask {
  entryId: string;
  field: 'startRef' | 'endRef';
  refText: string;
  canonicalName: string;
  /** 条目来源动态正文，帮助判断「即将上线」是否依附于某次维护 */
  sourceText: string;
  publishedAt: number;
}

interface Resolution {
  entryId?: string;
  field?: string;
  windowId?: string | null;
  anchor?: string | null;
  reason?: string;
}

/** 构造 system prompt：明确约束"只能选窗口、不得猜日期" */
function systemPrompt(): string {
  return `你是活动时间锚定器。给你若干活动条目的引用型时间、来源动态原文、以及本游戏的维护窗口列表。
判断每个引用指向哪个维护窗口的哪一端；无法确定时必须返回 null，不得猜测或编造。

## 规则
1. windowId 必须来自给定窗口列表，不得新建。
2. anchor 取值 "start"（维护开始时刻）或 "end"（维护结束时刻）：
   - "维护后/开放/上线/开启"等开始语义 → end；
   - "维护/关闭/结束/下架"等结束语义 → start。
3. "即将上线/即将常驻"这类没有日期、来源动态也没有提到维护的引用 → windowId 与 anchor 均为 null。
4. 同一活动有多条动态时，以来源动态的表述为准，不要被其他条目带偏。
5. reason 用一句中文说明依据；选 null 时说明缺少什么信息。

## 输出
严格输出 JSON：
{"resolutions":[{"entryId":"...","field":"startRef","windowId":"azur-lane:1792634400" | null,"anchor":"start" | "end" | null,"reason":"..."}]}`;
}

/**
 * 对某游戏的未锚定语义引用做一次 LLM 判定。
 * 返回本次检查的引用数与成功锚定数。
 */
export async function resolveSemanticRefs(gameId: string): Promise<{
  checked: number;
  anchored: number;
  /** 审计用：送入 LLM 的 system/user 与原始输出 */
  system?: string;
  user?: string;
  raw?: unknown;
}> {
  if (!llmEnabled()) return { checked: 0, anchored: 0 };
  const startedAt = Date.now();
  const windows = await listMaintenanceWindows(gameId);
  if (windows.length === 0) return { checked: 0, anchored: 0 };
  const newestAnnouncedAt = Math.max(...windows.map((w) => w.announcedAt));

  const posts = new Map((await loadPosts()).map((p) => [p.id, p]));
  const entries = await listEntriesByGame(gameId);
  const tasks: RefTask[] = [];
  for (const entry of entries) {
    for (const field of ['startRef', 'endRef'] as const) {
      const ref = entry.payload[field];
      if (!ref || ref.state === 'anchored') continue;
      if (isFixedMaintenanceRef(ref.refText)) continue;
      // 纯日期（10.22、10月15日）没有指代维护的含义，送进去只会诱发硬选窗口
      if (!hasMaintenanceSemantics(ref.refText)) continue;
      // 上次检查晚于最新公告 → 没有新事实，跳过，避免重复消耗 LLM
      if (ref.semanticCheckedAt && ref.semanticCheckedAt >= newestAnnouncedAt) continue;
      const post = entry.postId ? posts.get(entry.postId) : undefined;
      tasks.push({
        entryId: entry.id,
        field,
        refText: ref.refText,
        canonicalName: entry.payload.canonicalName ?? entry.title,
        sourceText: post ? `${post.title}\n${(post.description ?? '').slice(0, 600)}` : '',
        publishedAt: entry.publishedAt ?? entry.firstSeenAt,
      });
    }
  }
  if (tasks.length === 0) return { checked: 0, anchored: 0 };
  const batch = tasks.slice(0, MAX_REFS_PER_CALL);
  if (tasks.length > batch.length) log.warn('语义锚定引用超过批次上限，本次处理 %d/%d', batch.length, tasks.length);

  const user = JSON.stringify({
    today: fmt(Math.floor(Date.now() / 1000)),
    windows: windows.map((w) => ({ id: w.id, start: fmt(w.startAt), end: fmt(w.endAt) })),
    refs: batch.map((t) => ({
      entryId: t.entryId,
      field: t.field,
      refText: t.refText,
      canonicalName: t.canonicalName,
      publishedAt: fmt(t.publishedAt),
      sourceText: t.sourceText,
    })),
  }, null, 2);

  let raw: { resolutions?: Resolution[] };
  const system = systemPrompt();
  try {
    raw = (await chatJSON({ system, user })) as { resolutions?: Resolution[] };
  } catch (e) {
    log.warn('语义锚定 LLM 调用失败：%s', (e as Error).message);
    return { checked: batch.length, anchored: 0, system, user };
  }
  const resolutions = Array.isArray(raw.resolutions) ? raw.resolutions : [];
  const byWindow = new Map(windows.map((w) => [w.id, w]));
  const taskIndex = new Map(batch.map((t) => [`${t.entryId}|${t.field}`, t]));

  // 按条目聚合修改，避免同一 payload 被多次覆盖
  const changes = new Map<string, { startAt?: number; endAt?: number; payload: EntryPayload; evidence: string[] }>();
  let anchored = 0;

  for (const r of resolutions) {
    const task = r.entryId && r.field ? taskIndex.get(`${r.entryId}|${r.field}`) : undefined;
    if (!task) {
      log.warn('语义锚定返回未知引用 entryId=%s field=%s', r.entryId, r.field);
      continue;
    }
    const entry = entries.find((e) => e.id === task.entryId);
    if (!entry) continue;
    const change = changes.get(entry.id) ?? { payload: { ...entry.payload }, evidence: [] };
    const ref: TimeRef = { ...(change.payload[task.field] as TimeRef), semanticCheckedAt: Math.floor(Date.now() / 1000) };

    let at: number | undefined;
    if (r.windowId && (r.anchor === 'start' || r.anchor === 'end')) {
      const window = byWindow.get(r.windowId);
      if (!window) {
        log.warn('语义锚定返回未知窗口 entryId=%s windowId=%s', task.entryId, r.windowId);
      } else {
        const candidate = r.anchor === 'end' ? window.endAt : window.startAt;
        // 与固定模式同一约束：模型选的窗口必须落在发布时间附近，否则视为无法确定
        const withinDistance = isAnchorWithinConstraints(candidate, task.publishedAt);
        // 区间自洽：锚定后结束早于开始，说明选错了窗口
        const effStart = task.field === 'startRef' ? candidate : change.startAt ?? entry.startAt;
        const effEnd = task.field === 'endRef' ? candidate : change.endAt ?? entry.endAt;
        const coherent = effStart == null || effEnd == null || effEnd > effStart;
        if (!withinDistance) {
          log.warn('语义锚定窗口超出距离约束 entryId=%s windowId=%s', task.entryId, r.windowId);
        } else if (!coherent) {
          log.warn('语义锚定区间不自洽 entryId=%s windowId=%s', task.entryId, r.windowId);
        } else {
          at = candidate;
          ref.refId = window.id;
          ref.state = 'anchored';
          ref.semanticNote = r.reason;
          anchored++;
        }
      }
    }
    if (at == null) {
      ref.state = 'unanchored';
      ref.semanticNote = r.reason ?? 'LLM 未给出可锚定的窗口';
    }
    change.payload[task.field] = ref;
    if (at != null) {
      // 窗口给出精确时刻，覆盖纯日期条目的"时分不可信"标记
      if (task.field === 'startRef') {
        change.startAt = at;
        change.payload.startTimeKnown = true;
      } else {
        change.endAt = at;
        change.payload.endTimeKnown = true;
      }
    }
    change.evidence.push(`${task.field}="${task.refText}" → ${r.windowId ?? 'null'}${at != null ? '@' + fmt(at) : ''}（${r.reason ?? '无说明'}）`);
    changes.set(entry.id, change);
  }

  let written = 0;
  for (const [id, change] of changes) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) continue;
    const stillUnanchored =
      (change.payload.startRef && change.payload.startRef.state !== 'anchored') ||
      (change.payload.endRef && change.payload.endRef.state !== 'anchored');
    if (!stillUnanchored) change.payload.estimated = false;
    change.payload.provenance = [
      ...(change.payload.provenance ?? []),
      { fields: ['startRef', 'endRef'], method: 'semantic-anchor', evidence: change.evidence.join('; ') },
    ];
    await updateEntrySchedule(id, change.startAt ?? entry.startAt, change.endAt ?? entry.endAt, change.payload);
    written++;
  }

  log.info(
    '语义锚定完成 gameId=%s 检查=%d 锚定=%d 写回=%d 耗时=%dms',
    gameId, batch.length, anchored, written, Date.now() - startedAt,
  );
  return { checked: batch.length, anchored, system, user, raw };
}

/** 对启用维护窗口的游戏执行语义锚定 */
export async function resolveAllSemanticRefs(gameIds: readonly string[]): Promise<void> {
  for (const gameId of gameIds) {
    await resolveSemanticRefs(gameId);
  }
}
