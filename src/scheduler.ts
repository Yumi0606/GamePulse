import { runPipeline } from './sources/pipeline.js';
import { saveMeta, upsertPosts, type FetchMeta } from './storage/store.js';
import { enrichOcr } from './processing/enrich.js';
import { extractEntries } from './processing/extract.js';
import { GAMES } from './core/games.js';
import { envNum } from './core/env.js';
import { moduleLogger } from './core/logger.js';

const log = moduleLogger('scheduler');

/**
 * 定时调度（两条独立循环，共享重入互斥）：
 * - 拉取循环：RSS 拉取 → 入库 → 顺带跑一轮处理链。默认每天北京时间 00:00 一次；
 *   设置 FETCH_INTERVAL_MINUTES（分钟，最小 1）后改为固定间隔模式。
 * - 处理循环：OCR + LLM 结构化，独立于拉取高频跑清积压（PROCESS_INTERVAL_MINUTES，
 *   默认 30，最小 5），避免"每日一批限 20 张/10 条"导致数据滞后数天。
 *
 * 启动时立即执行一次拉取循环，保证库存非空；上一轮未完成时新 tick 直接跳过，
 * 防止 OCR/LLM 慢批次期间两轮并发重复处理同一批数据。
 * Web 服务只读本地存储，不实时拉取。
 */

/** 北京时间相对 UTC 的偏移毫秒（固定 +8，无夏令时） */
const CST_OFFSET_MS = 8 * 3600_000;

/** 距下一个北京时间 00:00 的毫秒数（不依赖进程本地时区，部署在任意时区机器上语义一致） */
function msUntilMidnight(): number {
  const now = Date.now();
  // 把"当前北京时间墙钟"伪装成 UTC 日期取整点，再还原回真实 UTC 时刻
  const cstWall = new Date(now + CST_OFFSET_MS);
  const cstMidnightPseudoUtc = Date.UTC(cstWall.getUTCFullYear(), cstWall.getUTCMonth(), cstWall.getUTCDate());
  const nextMidnightUtc = cstMidnightPseudoUtc - CST_OFFSET_MS + 86_400_000;
  return nextMidnightUtc - now;
}

/** 固定间隔（毫秒）；未配置 FETCH_INTERVAL_MINUTES 时返回 null（走每天 0 点模式） */
function fixedIntervalMs(): number | null {
  const raw = process.env.FETCH_INTERVAL_MINUTES;
  if (raw === undefined || raw === '') return null;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return minutes * 60_000;
}

/** 处理链循环间隔（毫秒）；PROCESS_INTERVAL_MINUTES 默认 30，最小 5 */
function processIntervalMs(): number {
  return Math.max(5, envNum('PROCESS_INTERVAL_MINUTES', 30)) * 60_000;
}

/** 跑一轮处理链（OCR 富化 + LLM 结构化），供拉取循环与独立处理循环复用 */
export async function runProcessOnce(): Promise<void> {
  // 处理链第一步：对新图片补 OCR（侧车未启动时熔断并告警，不阻断）
  await enrichOcr();

  // 处理链第二步：LLM 拆分为活动/卡池/公告（未配置 LLM 时内部跳过，不阻断）
  const gameNames = Object.fromEntries(GAMES.map((g) => [g.id, g.name]));
  await extractEntries(gameNames);
}

/** 跑一次完整拉取并落盘，返回批次统计 */
export async function runFetchOnce(): Promise<FetchMeta> {
  const startedAt = Date.now();
  log.info('同步开始');

  const { items, errors } = await runPipeline();
  const { added, updated } = await upsertPosts(items);
  log.info('库存合并 fetched=%d added=%d updated=%d errors=%d', items.length, added, updated, errors.length);

  // 拉取完立即清一轮处理链积压
  await runProcessOnce();

  const meta: FetchMeta = {
    lastRunAt: Math.floor(startedAt / 1000),
    durationMs: Date.now() - startedAt,
    fetched: items.length,
    added,
    updated,
    errors: errors.map((e) => e.message),
  };
  await saveMeta(meta);
  log.info('同步完成 totalCostMs=%d', meta.durationMs);
  return meta;
}

// ---- 重入互斥：拉取/处理共用一个忙碌标志，防 OCR/LLM 慢批次期间两轮并发重复处理 ----
let busy = false;

/** 忙碌时跳过并告警，否则执行 fn（异常记日志，不中断定时器） */
function guarded(label: string, fn: () => Promise<void>): void {
  if (busy) {
    log.warn('跳过%s：上一轮尚未完成', label);
    return;
  }
  busy = true;
  fn()
    .catch((e) => log.error({ err: e }, '%s异常', label))
    .finally(() => {
      busy = false;
    });
}

/** 启动定时循环（不阻塞调用方）：拉取先立即执行一次，再按模式排程；处理链独立高频循环 */
export function startScheduler(): void {
  const ms = fixedIntervalMs();
  if (ms === null) {
    log.info('定时拉取已启动 mode=daily-at-00:00 cst');
  } else {
    log.info('定时拉取已启动 mode=interval minutes=%d', Math.round(ms / 60_000));
  }
  log.info('处理链循环已启动 intervalMinutes=%d', Math.round(processIntervalMs() / 60_000));

  const fetchTick = (): void =>
    guarded('拉取批次', async () => {
      await runFetchOnce();
    });
  const processTick = (): void =>
    guarded('处理批次', async () => {
      await runProcessOnce();
    });

  fetchTick();

  if (ms === null) {
    // 每天 0 点模式：触发后重新计算到下一个 0 点，避免漂移
    const loop = (): void => {
      setTimeout(() => {
        fetchTick();
        loop();
      }, msUntilMidnight());
    };
    loop();
  } else {
    setInterval(fetchTick, ms);
  }
  // 处理链循环：启动即跑一次（与拉取首轮互斥，谁先抢到谁跑），之后固定间隔清积压
  processTick();
  setInterval(processTick, processIntervalMs());
}
