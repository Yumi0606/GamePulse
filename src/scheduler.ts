import { runPipeline } from './pipeline.js';
import { saveMeta, upsertItems, type FetchMeta } from './store.js';

/**
 * 定时拉取调度。
 * 启动立即执行一次，之后按 FETCH_INTERVAL_MINUTES（默认 15，最小 1）循环；
 * Web 服务只读本地存储，不再实时拉取。
 */

/** 拉取间隔（毫秒），由环境变量 FETCH_INTERVAL_MINUTES 配置 */
function intervalMs(): number {
  const raw = Number(process.env.FETCH_INTERVAL_MINUTES ?? 15);
  const minutes = Number.isFinite(raw) && raw >= 1 ? raw : 15;
  return minutes * 60_000;
}

/** 跑一次完整拉取并落盘，返回批次统计 */
export async function runFetchOnce(): Promise<FetchMeta> {
  const startedAt = Date.now();
  const { items, errors } = await runPipeline();
  const { added, updated } = await upsertItems(items);
  const meta: FetchMeta = {
    lastRunAt: Math.floor(startedAt / 1000),
    durationMs: Date.now() - startedAt,
    fetched: items.length,
    added,
    updated,
    errors: errors.map((e) => e.message),
  };
  await saveMeta(meta);
  return meta;
}

/** 启动定时循环（不阻塞调用方） */
export function startScheduler(): void {
  const ms = intervalMs();
  console.log('定时拉取已启动：立即执行一次，之后每 %d 分钟一次', Math.round(ms / 60_000));
  const tick = (): void => {
    runFetchOnce()
      .then((m) => console.log(
        '拉取完成：%d 条（新增 %d / 更新 %d，%dms）%s',
        m.fetched, m.added, m.updated, m.durationMs,
        m.errors.length > 0 ? `；失败：${m.errors.join('；')}` : '',
      ))
      .catch((e) => console.error('拉取失败：', (e as Error).message));
  };
  tick();
  setInterval(tick, ms);
}
