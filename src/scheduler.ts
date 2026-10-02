import { runPipeline } from './pipeline.js';
import { saveMeta, upsertPosts, type FetchMeta } from './store.js';
import { enrichOcr } from './enrich.js';
import { extractEntries } from './extract.js';
import { GAMES } from './games.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('scheduler');

/**
 * 定时拉取调度。
 * 默认每天本地时间 00:00 执行一次；
 * 设置环境变量 FETCH_INTERVAL_MINUTES（分钟，最小 1）后改为固定间隔模式。
 * 无论哪种模式，启动时都立即执行一次，保证库存非空；
 * Web 服务只读本地存储，不实时拉取。
 */

/** 距下一个本地 00:00 的毫秒数（setHours(24) 溢出到次日 0 点） */
function msUntilMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/** 固定间隔（毫秒）；未配置 FETCH_INTERVAL_MINUTES 时返回 null（走每天 0 点模式） */
function fixedIntervalMs(): number | null {
  const raw = process.env.FETCH_INTERVAL_MINUTES;
  if (raw === undefined || raw === '') return null;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return minutes * 60_000;
}

/** 跑一次完整拉取并落盘，返回批次统计 */
export async function runFetchOnce(): Promise<FetchMeta> {
  const startedAt = Date.now();
  log.info('同步开始');

  const { items, errors } = await runPipeline();
  const { added, updated } = await upsertPosts(items);
  log.info('库存合并 fetched=%d added=%d updated=%d errors=%d', items.length, added, updated, errors.length);

  // 结构化处理链第一步：对新图片补 OCR（侧车未启动时内部跳过并告警，不阻断）
  const ocr = await enrichOcr();

  // 结构化处理链第二步：LLM 拆分为活动/卡池/公告（未配置 LLM 时内部跳过，不阻断）
  const gameNames = Object.fromEntries(GAMES.map((g) => [g.id, g.name]));
  const extract = await extractEntries(gameNames);

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

/** 启动定时循环（不阻塞调用方）：先立即执行一次，再按模式排程 */
export function startScheduler(): void {
  const ms = fixedIntervalMs();
  if (ms === null) {
    log.info('定时拉取已启动 mode=daily-at-00:00');
  } else {
    log.info('定时拉取已启动 mode=interval minutes=%d', Math.round(ms / 60_000));
  }
  const tick = (): void => {
    runFetchOnce().catch((e) => log.error('拉取异常 err=%s', (e as Error).message));
  };
  tick();

  if (ms === null) {
    // 每天 0 点模式：触发后重新计算到下一个 0 点，避免漂移
    const loop = (): void => {
      setTimeout(() => {
        tick();
        loop();
      }, msUntilMidnight());
    };
    loop();
  } else {
    setInterval(tick, ms);
  }
}
