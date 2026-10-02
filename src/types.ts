/**
 * 标准数据模型（v1.5）。
 * 与《调研报告-活动数据结构》的统一 Item 模型对齐；
 * 拆分产物（entries）覆盖可排期大类，NEWS 留在 posts 表。
 */

/** 条目大类（全量枚举，与调研报告 §2 对齐） */
export type ItemType = 'NEWS' | 'ACTIVITY' | 'GACHA' | 'SHOP' | 'COLLAB' | 'ANNOUNCEMENT';

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

/** 结构化条目大类：NEWS 不入 entries（posts 已覆盖展示），entries 只收"可排期"的大类 */
export type EntryType = Exclude<ItemType, 'NEWS'>;

/** 图片（调研报告 §4 Image） */
export interface Image {
  /** 图片 URL */
  url: string;
  /** 内容 hash（可选，去重用） */
  hash?: string;
}

/** 引用型时间（调研报告 §3 TimeRef）：终点/起点是事件表述而非时间戳时使用 */
export interface TimeRef {
  /** 原文表述，如 "「雪淞幽梦」版本结束" */
  refText: string;
  /** 锚定到的其他条目 id（版本公告等）；由回填扫描填充，未锚定为空 */
  refId?: string;
  /** 锚定状态：unanchored=待回填；anchored=已回填绝对值；estimated=估计值 */
  state: 'unanchored' | 'anchored' | 'estimated';
}

/** 活动分段（调研报告 §3 Phase） */
export interface EntryPhase {
  /** 段序号，从 1 开始 */
  index: number;
  /** 段名（"普通关"/"EX 关"…），可空 */
  title?: string;
  /** 该段开始，Unix 秒；无法锚定为空 */
  startAt?: number;
  /** 该段结束，Unix 秒；无法锚定为空 */
  endAt?: number;
  /** 引用型起止（与 startAt/endAt 二选一或并存），由回填扫描锚定 */
  startRef?: TimeRef;
  endRef?: TimeRef;
  /** 该段时间为按活动起止推算的估计值（如"开启后第8天"），展示层标注"预估" */
  estimated?: boolean;
}

/** LLM/规则拆分出的结构化条目（entries 表），模型见《调研报告-活动数据结构》§4 */
export interface Entry {
  /** 本系统内唯一 id：`${gameId}:${type}:${postSourceId}/${slot}` */
  id: string;
  /** 来源动态 id（posts.id）；未来其他信息源（GameData 等）可空 */
  postId?: string;
  /** 所属游戏 id */
  gameId: string;
  /** 条目大类：ACTIVITY / GACHA / SHOP / COLLAB / ANNOUNCEMENT */
  type: EntryType;
  /** 产出源标识，如 llm-bilibili */
  source: string;
  /** 源内原始 id：`${动态 sourceId}/${slot}`，slot ∈ activity|gacha|shop|collab|announcement */
  sourceId: string;
  /** 条目标题 */
  title: string;
  /** 原文/活动页链接，可空 */
  url?: string;
  /** 发布时间（继承来源动态），Unix 秒 */
  publishedAt?: number;
  /** 活动开始时间（锚定后的绝对值），Unix 秒；无法锚定为空 */
  startAt?: number;
  /** 活动结束时间（锚定后的绝对值），Unix 秒；无法锚定为空 */
  endAt?: number;
  /** 完整条目负载：schedule 细节（引用型时间/分段/奖励期）、置信度、溯源等 */
  payload: EntryPayload;
}

/** entries 的 payload 结构（查询面已进列，演化面在此），键与调研报告 §4/§5 对齐 */
export interface EntryPayload {
  /** 简述 */
  summary?: string;
  /** 条目详细说明（LLM 从正文/OCR 提炼的活动详情），可空 */
  description?: string;
  /** 大类内子类型（活动类型/卡池类型/公告类型），可空 */
  category?: string;
  /** 语义化主图：LLM 指定第几张动态图（1-based）为该条目 banner，代码侧解析为 Image */
  banner?: Image;
  /** 来源自带标签（B站动态话题 #xxx#），非系统分类 */
  tags?: string[];
  /** 引用型起止时间（无法锚定为绝对值时保留原文，由数据层回填扫描处理） */
  startRef?: TimeRef;
  endRef?: TimeRef;
  /** 奖励领取期结束（不属于分段），Unix 秒 */
  rewardEndAt?: number;
  /** 分段列表 */
  phases?: EntryPhase[];
  /** 起止时间为 LLM 推断值（原文未明确年份/日期，按上下文补全）——展示层需标注"预估" */
  estimated?: boolean;
  /** 结构化置信度 0~1（LLM 产物必填） */
  confidence: number;
  /** 字段溯源（调研报告 §4 ExtractRecord：fields=被提取的字段） */
  provenance?: { fields: string[]; method: string; evidence?: string }[];
  /** 其余未归类字段 */
  extra?: Record<string, unknown>;
}
