/**
 * 游戏配色。
 *
 * gameId 与展示名的唯一来源是 /api/v1/games；这里只映射颜色，
 * 未登记的游戏退到默认灰蓝色，不影响功能。
 */
export interface GameTheme {
  /** 淡色底 */
  bg: string;
  /** 深色文字 */
  fg: string;
  /** 强调色（左侧色条） */
  accent: string;
}

const DEFAULT_THEME: GameTheme = { bg: '#f0f2f5', fg: '#3d4653', accent: '#8b98a8' };

export const GAME_THEME: Record<string, GameTheme> = {
  arknights: { bg: '#eaf1fa', fg: '#26456f', accent: '#3f6fb5' },
  endfield: { bg: '#f3f1fd', fg: '#4b3f9e', accent: '#6a5acd' },
  'delta-force': { bg: '#fdf7e6', fg: '#7a5a00', accent: '#c9a227' },
  'wuthering-waves': { bg: '#e9f8f4', fg: '#1f6b5f', accent: '#2f9e8f' },
  'azur-lane': { bg: '#eaf4fb', fg: '#1f5c85', accent: '#2f7fa8' },
  'azur-promilia': { bg: '#e6f8f8', fg: '#14566b', accent: '#14a3a3' },
  genshin: { bg: '#eef2fd', fg: '#2a4a70', accent: '#4f6fd8' },
  'honkai-star-rail': { bg: '#f2effc', fg: '#4a3670', accent: '#8a6fd1' },
  'zenless-zone-zero': { bg: '#f8f8e8', fg: '#3f4420', accent: '#a8b32a' },
};

export function gameTheme(gameId: string): GameTheme {
  return GAME_THEME[gameId] ?? DEFAULT_THEME;
}

/** 条目大类 → 甘特色条颜色（与分组底色区分：条按类型着色） */
export const TYPE_COLOR: Record<string, string> = {
  ACTIVITY: '#4a90c2',
  GACHA: '#8a6cc9',
  SHOP: '#d98a3c',
  COLLAB: '#3fa87a',
  ANNOUNCEMENT: '#888888',
};

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? '#8b98a8';
}
