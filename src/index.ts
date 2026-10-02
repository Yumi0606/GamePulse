import { runFetchOnce } from './scheduler.js';
import { loadItems } from './store.js';
import { GAMES } from './games.js';

/**
 * 命令行入口：手动跑一次拉取并落盘（与定时任务同一逻辑），然后打印库存摘要。
 * 定时刷新由 Web 服务内置的调度器负责，本入口用于验证与补拉。
 */
async function main(): Promise<void> {
  console.log('手动拉取 %d 款游戏官号动态…', GAMES.length);
  const meta = await runFetchOnce();

  if (meta.errors.length > 0) {
    console.log('\n部分游戏拉取失败：');
    for (const e of meta.errors) console.log('  ! %s', e);
  }

  console.log(
    '\n本批次：%d 条（新增 %d / 更新 %d，用时 %dms），已写入 data/items.json',
    meta.fetched, meta.added, meta.updated, meta.durationMs,
  );

  // 打印库存摘要（读本地存储）
  const items = await loadItems();
  const byGame = new Map<string, number>();
  for (const item of items) {
    byGame.set(item.gameId, (byGame.get(item.gameId) ?? 0) + 1);
  }
  console.log('\n库存共 %d 条：', items.length);
  for (const game of GAMES) {
    console.log('  %s %d 条', game.name.padEnd(16), byGame.get(game.id) ?? 0);
  }

  // 打印每游戏最新 2 条，人工核对
  console.log('\n各游戏最新动态：');
  for (const game of GAMES) {
    const gameItems = items
      .filter((i) => i.gameId === game.id)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 2);
    console.log('\n【%s】', game.name);
    for (const it of gameItems) {
      const date = new Date(it.publishedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log('  %s  %s', date, it.title.slice(0, 50));
    }
  }
}

main().catch((e) => {
  console.error('运行失败：', e);
  process.exit(1);
});
