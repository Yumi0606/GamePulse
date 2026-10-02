import type { Game } from './types.js';

/**
 * 预置游戏清单。B站官号 uid 已在调研阶段逐一真实拉取核实，
 * 见 PRD §2.1。新增游戏只需在此登记。
 */
export const GAMES: Game[] = [
  { id: 'arknights', name: '明日方舟', bilibiliUid: 161775300, enabled: true },
  { id: 'endfield', name: '明日方舟：终末地', bilibiliUid: 1265652806, enabled: true },
  { id: 'delta-force', name: '三角洲行动', bilibiliUid: 3494376565115651, enabled: true },
  { id: 'wuthering-waves', name: '鸣潮', bilibiliUid: 1955897084, enabled: true },
  { id: 'azur-lane', name: '碧蓝航线', bilibiliUid: 233114659, enabled: true },
];

/** 取启用的游戏 */
export function enabledGames(): Game[] {
  return GAMES.filter((g) => g.enabled);
}
