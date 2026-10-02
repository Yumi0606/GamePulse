import type { Item } from '../core/types.js';
import { enabledGames } from '../core/games.js';
import { rsshubBilibiliAdapter } from './adapters/rsshubBilibili.js';
import { dedup } from './dedup.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('pipeline');

/**
 * 数据层编排：逐游戏经适配器拉取 → 汇总 → 全局去重。
 * 单游戏拉取失败不阻断其他游戏（记错误并跳过）。
 * 每款游戏单独打进入/完成/失败日志（含耗时），便于定位卡点。
 */
export async function runPipeline(): Promise<{ items: Item[]; errors: Error[] }> {
  const games = enabledGames();
  const collected: Item[] = [];
  const errors: Error[] = [];

  log.info('开始拉取 gameCount=%d', games.length);
  const results = await Promise.allSettled(
    games.map(async (game) => {
      const t0 = Date.now();
      try {
        const items = await rsshubBilibiliAdapter.fetch(game);
        log.info('拉取完成 game=%s items=%d costMs=%d', game.id, items.length, Date.now() - t0);
        return items;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        log.error('拉取失败 game=%s costMs=%d err=%s', game.id, Date.now() - t0, err.message);
        throw err;
      }
    }),
  );

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
    } else {
      const reason = result.reason;
      errors.push(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });

  const items = dedup(collected);
  log.info('拉取汇总 dedupedItems=%d errors=%d', items.length, errors.length);
  return { items, errors };
}
