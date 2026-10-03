import type { Item } from '../core/types.js';
import { enabledGames } from '../core/games.js';
import { rsshubBilibiliAdapter, SourceFetchError } from './adapters/rsshubBilibili.js';
import { dedup } from './dedup.js';
import { recordEvent, resolveEventsForGame, type EventKind } from '../storage/store.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('pipeline');

/**
 * 数据层编排：逐游戏经适配器拉取 → 汇总 → 全局去重。
 * 单游戏拉取失败不阻断其他游戏（记错误并跳过）。
 * 每款游戏单独打进入/完成/失败日志（含耗时），便于定位卡点。
 * 异常同时写入 events 表（kind 分类 + cookie 特征打标），供 Web 异常页展示；
 * 同一游戏后续拉取成功且有数据时，其未恢复事件自动标记恢复。
 */

/** 疑似 B站 cookie 失效特征：错误文本命中即打标（B站 API -101 未登录 / SESSDATA / cookie 相关提示） */
const COOKIE_SUSPECT_RE = /-101|账号未登录|not logged in|sessdata|cookie/i;

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

  for (const [i, result] of results.entries()) {
    const game = games[i];
    if (result.status === 'fulfilled') {
      if (result.value.length === 0) {
        // 拉取成功但 0 条：官号确实无动态或源异常（如缓存层故障），记录为可恢复事件并告警
        log.warn('拉取到 0 条动态 game=%s（官号无动态或源异常）', game.id);
        await recordEvent({ gameId: game.id, kind: 'empty', summary: `${game.name}：拉取成功但 0 条动态` });
        continue;
      }
      collected.push(...result.value);
      // 本轮成功且有数据：该游戏之前的未恢复异常（如 cookie 更新后）自动标记恢复
      const resolved = await resolveEventsForGame(game.id);
      if (resolved > 0) log.info('game=%s 之前的 %d 条拉取异常已恢复', game.id, resolved);
    } else {
      const reason = result.reason;
      const err = reason instanceof Error ? reason : new Error(String(reason));
      errors.push(err);
      // 异常入 events 表：kind 分类 + cookie 特征打标，详情（如 RSSHub Error Message）随行存储
      const kind: EventKind = err instanceof SourceFetchError ? err.kind : 'network';
      const detail = err instanceof SourceFetchError ? err.detail : undefined;
      const isCookie = COOKIE_SUSPECT_RE.test(`${err.message}\n${detail ?? ''}`);
      await recordEvent({ gameId: game.id, kind, summary: err.message, detail, isCookieSuspect: isCookie });
    }
  }

  const items = dedup(collected);
  log.info('拉取汇总 dedupedItems=%d errors=%d', items.length, errors.length);
  return { items, errors };
}
