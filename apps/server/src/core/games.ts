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
  // 蓝色星原与碧蓝航线同属蛮啾网络，紧随其后；米哈游三款统一置于末尾
  { id: 'azur-promilia', name: '蓝色星原：旅谣', bilibiliUid: 3546569016085336, enabled: true },
  { id: 'genshin', name: '原神', bilibiliUid: 401742377, enabled: true },
  { id: 'honkai-star-rail', name: '崩坏：星穹铁道', bilibiliUid: 1340190821, enabled: true },
  { id: 'zenless-zone-zero', name: '绝区零', bilibiliUid: 1636034895, enabled: true },
];

/** 取启用的游戏 */
export function enabledGames(): Game[] {
  return GAMES.filter((g) => g.enabled);
}
