import { runPipeline } from './sources/pipeline.js';
import { saveMeta, upsertPosts, type FetchMeta } from './storage/store.js';
import { enrichOcr } from './processing/enrich.js';
import { extractEntries } from './processing/extract.js';
import { GAMES } from './core/games.js';
import { envNum } from './core/env.js';
import { moduleLogger } from './core/logger.js';
import { CronJob } from 'cron';

const log = moduleLogger('scheduler');

/**
 * 定时调度（两条独立循环，共享重入互斥）：
 * - 拉取循环：RSS 拉取 → 入库 → 顺带执行一轮处理链。
 * - 处理循环：OCR + LLM 结构化，独立于拉取高频执行清积压。
 *
 * 触发方式（优先级从高到低）：
 * 1. cron 表达式：FETCH_CRON / PROCESS_CRON，标准 5 字段（分 时 日 月 周），固定按北京时间解释；
 * 2. 固定间隔：FETCH_INTERVAL_MINUTES / PROCESS_INTERVAL_MINUTES（分钟）；
 * 3. 拉取循环未配置任何项时：每天北京时间 00:00。
 * cron 表达式非法时打 error 日志并回落到下一级方式，不中断服务。
 *
 * 上一轮未完成时新触发的轮次直接跳过，防止慢批次期间两轮并发重复处理同一批数据。
 * Web 服务只读本地存储，不实时拉取。
 */

/** cron 固定解释时区：项目约定时间一律 Asia/Shanghai，部署到任意时区机器行为一致 */
const CRON_TZ = 'Asia/Shanghai';

/** 调度触发方式：cron=表达式 / interval=固定间隔 / daily=拉取循环专属的每天 0 点 */
type Schedule =
  | { type: 'cron'; expr: string }
  | { type: 'interval'; ms: number }
  | { type: 'daily' };

/**
 * 构造 cron 调度；表达式非法时返回 null（调用方回落默认方式）。
 * 错误信息明确打印，避免"配置了 cron 却静默未生效"。
 */
function buildCronSchedule(expr: string | undefined, label: string): Schedule | null {
  const trimmed = expr?.trim();
  if (!trimmed) return null;
  try {
    // 构造即校验表达式；此处不启动，start() 在统一位置调用
    CronJob.from({ cronTime: trimmed, onTick: () => {}, timeZone: CRON_TZ });
    return { type: 'cron', expr: trimmed };
  } catch (e) {
    log.error('%s cron 表达式非法 expr=%s err=%s，将回落默认调度方式', label, trimmed, (e as Error).message);
    return null;
  }
}

/** 拉取循环调度：FETCH_CRON → FETCH_INTERVAL_MINUTES → 每天北京时间 00:00 */
function fetchSchedule(): Schedule {
  return (
    buildCronSchedule(process.env.FETCH_CRON, '拉取循环') ??
    (fixedIntervalMs() !== null ? { type: 'interval', ms: fixedIntervalMs() as number } : { type: 'daily' })
  );
}

/** 处理循环调度：PROCESS_CRON → PROCESS_INTERVAL_MINUTES（默认 30，最小 5） */
function processSchedule(): Schedule {
  return (
    buildCronSchedule(process.env.PROCESS_CRON, '处理循环') ??
    { type: 'interval', ms: processIntervalMs() }
  );
}

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

/** 处理链单轮时间预算（秒）：单轮内反复处理小批，到预算即退出，默认 480 */
function processBudgetSeconds(): number {
  return Math.max(30, envNum('PROCESS_TIME_BUDGET_SECONDS', 480));
}

/**
 * 跑一轮处理链（清空式循环 + 时间预算，见评审报告 P2-2）：
 * 在时间预算内反复执行"OCR 一小批 → LLM 一小批"，直到两个队列均空、熔断或预算耗尽。
 * OCR/LLM 各自的 BATCH_LIMIT 语义为"每一小批上限"，不再是"每轮上限"。
 */
export async function runProcessOnce(): Promise<{
  iterations: number;
  imagesDone: number;
  imagesFailed: number;
  imagesInfra: number;
  postsProcessed: number;
  postsSkipped: number;
  entries: number;
  overBudget: boolean;
}> {
  const gameNames = Object.fromEntries(GAMES.map((g) => [g.id, g.name]));
  const deadline = Date.now() + processBudgetSeconds() * 1000;
  log.info('处理链循环开始 budgetSeconds=%d', processBudgetSeconds());

  let iterations = 0;
  let imagesDone = 0;
  let imagesFailed = 0;
  let imagesInfra = 0;
  let postsProcessed = 0;
  let postsSkipped = 0;
  let entryCount = 0;
  let overBudget = false;
  const t0 = Date.now();

  // do/while：即使预算很短，也保证至少执行一次（启动即处理的语义）
  do {
    iterations++;
    // 处理链第一步：OCR 一小批（侧车未启动时内部熔断，不阻断）
    const ocr = await enrichOcr();
    // 处理链第二步：LLM 一小批（未配置 LLM 时内部跳过，不阻断）
    const llm = await extractEntries(gameNames);

    imagesDone += ocr.imagesDone;
    imagesFailed += ocr.imagesFailed;
    imagesInfra += ocr.imagesInfra;
    postsProcessed += llm.processed;
    postsSkipped += llm.skipped;
    entryCount += llm.entries;

    // 熔断：服务大概率异常，本剩余轮次不再尝试，等待下一轮定时器
    if (ocr.aborted || llm.aborted) {
      log.warn('处理链循环遇熔断提前退出 iterations=%d', iterations);
      break;
    }
    // 两个队列均无任务（OCR 无图片处理、LLM 无动态处理）即清空，退出
    const ocrIdle = ocr.imagesDone + ocr.imagesFailed + ocr.imagesInfra === 0;
    const llmIdle = llm.processed + llm.skipped + llm.failed === 0;
    if (ocrIdle && llmIdle) break;

    if (Date.now() >= deadline) {
      overBudget = true;
      break;
    }
  } while (true);

  log.info(
    '处理链循环完成 iterations=%d imagesDone=%d imagesFailed=%d imagesInfra=%d postsProcessed=%d postsSkipped=%d entries=%d overBudget=%s costMs=%d',
    iterations, imagesDone, imagesFailed, imagesInfra, postsProcessed, postsSkipped, entryCount, overBudget, Date.now() - t0,
  );
  return {
    iterations, imagesDone, imagesFailed, imagesInfra,
    postsProcessed, postsSkipped, entries: entryCount, overBudget,
  };
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

/** 调度方式的可读描述（启动日志用，便于确认实际生效方式） */
function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'cron': return `cron expr="${s.expr}" tz=${CRON_TZ}`;
    case 'interval': return `interval minutes=${Math.round(s.ms / 60_000)}`;
    case 'daily': return 'daily-at-00:00 cst';
  }
}

/** 按调度方式安装一个定时器；daily 模式用自递归 setTimeout 锚定北京时间 0 点 */
function installTimer(s: Schedule, tick: () => void): void {
  switch (s.type) {
    case 'cron':
      CronJob.from({
        cronTime: s.expr,
        onTick: tick,
        timeZone: CRON_TZ,
        start: true,
      });
      break;
    case 'interval':
      setInterval(tick, s.ms);
      break;
    case 'daily':
      // 触发后重新计算到下一个 0 点，避免漂移
      const loop = (): void => {
        setTimeout(() => {
          tick();
          loop();
        }, msUntilMidnight());
      };
      loop();
      break;
  }
}

/** 启动定时循环（不阻塞调用方）：拉取先立即执行一次；处理链启动即尝试（与拉取首轮互斥） */
export function startScheduler(): void {
  const fs = fetchSchedule();
  const ps = processSchedule();
  log.info('定时拉取已启动 %s', describeSchedule(fs));
  log.info('处理链循环已启动 %s', describeSchedule(ps));

  const fetchTick = (): void =>
    guarded('拉取批次', async () => {
      await runFetchOnce();
    });
  const processTick = (): void =>
    guarded('处理批次', async () => {
      await runProcessOnce();
    });

  fetchTick();
  installTimer(fs, fetchTick);

  // 启动即尝试一次（与拉取首轮互斥，谁先抢到谁执行）
  processTick();
  installTimer(ps, processTick);
}
