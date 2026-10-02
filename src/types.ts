/**
 * 标准数据模型（v1 社媒子集）。
 * 与《调研报告-活动数据结构》的统一 Item 模型对齐；
 * v1 仅消费 B站官号动态，故类型固定为 NEWS，活动/卡池等大类在后续版本扩展。
 */

/** 条目大类。v1 只用 NEWS；预留 ACTIVITY/GACHA/ANNOUNCEMENT 等。 */
export type ItemType = 'NEWS' | 'ACTIVITY' | 'GACHA' | 'ANNOUNCEMENT';

/** 游戏配置 */
export interface Game {
  /** 游戏标识，跨源稳定唯一，如 arknights */
  id: string;
  /** 展示名 */
  name: string;
  /** B站官号 uid */
  bilibiliUid: number;
  /** 是否启用 */
  enabled: boolean;
}

/** 归一化后的标准条目（当前即"原始动态"，存储于 posts 表；拆分产物存 entries 表） */
export interface Item {
  /** 本系统内稳定唯一 id：`${gameId}:${type}:${sourceId}` */
  id: string;
  /** 信息源内原始 id（B站动态 id） */
  sourceId: string;
  /** 信息源标识，如 rsshub-bilibili */
  source: string;
  /** 所属游戏 id */
  gameId: string;
  /** 条目大类，v1 固定 NEWS */
  type: ItemType;
  /** 标题 */
  title: string;
  /** 原文链接 */
  url: string;
  /** 发布时间，Unix 秒 */
  publishedAt: number;
  /** 作者/账号名，可空 */
  author?: string;
  /** 正文纯文本（由动态 HTML 去标签得到，OCR/LLM 结构化的输入），可空 */
  description?: string;
  /** 动态携带的原始图片 URL 列表（海报/长图，OCR 的输入），无图可空 */
  images?: string[];
}

/** 信息源适配器契约：每个信息源实现一个，输出标准条目 */
export interface SourceAdapter {
  /** 源标识 */
  source: string;
  /** 拉取并归一化为标准条目 */
  fetch(game: Game): Promise<Item[]>;
}
