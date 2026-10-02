import type { Item } from './types.js';
import { enabledGames } from './games.js';
import { rsshubBilibiliAdapter } from './adapters/rsshubBilibili.js';
import { dedup } from './dedup.js';

/**
 * 数据层编排：逐游戏经适配器拉取 → 汇总 → 全局去重。
 * 单游戏拉取失败不阻断其他游戏（记错误并跳过）。
 */
export async function runPipeline(): Promise<{ items: Item[]; errors: Error[] }> {
  const games = enabledGames();
  const collected: Item[] = [];
  const errors: Error[] = [];

  const results = await Promise.allSettled(
    games.map((game) => rsshubBilibiliAdapter.fetch(game)),
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
  return { items, errors };
}
