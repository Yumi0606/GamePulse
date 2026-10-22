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

/** 条目大类的中文展示标签（展示层与 RSS 共用） */
export const ENTRY_TYPE_LABEL: Record<EntryType, string> = {
  ACTIVITY: '活动',
  GACHA: '卡池',
  SHOP: '商店',
  COLLAB: '联动',
  ANNOUNCEMENT: '公告',
};

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
  /** 大类内子类型（活动类型/卡池类型/公告类型），取值受游戏专属规则词表约束；无合适值为"其他" */
  category?: string;
  /** 跨动态稳定的活动规范名：同一现实活动的多条报道产出相同值，作为第二阶段跨 post 合并键 */
  canonicalName?: string;
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
  extra?: EntryExtra;
}

/** entries.payload.extra 的演化面结构：跨 post 合并后多来源追溯等信息存于此 */
export interface EntryExtra {
  /** 合并后该条目关联的所有来源动态 id（posts.id），按发布时间升序；单来源时也存 */
  postIds?: string[];
  [key: string]: unknown;
}

/**
 * 归一化 canonicalName 作为跨 post 合并键：
 * 去首尾空白、压缩内部连续空白、统一全半角标点（全角→半角）。
 * 只用于合并匹配与 id 生成，展示仍用 LLM 原始值。
 */
export function normalizeCanonicalName(name: string | undefined): string {
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[，。！？、；：（）【】「」『』《》]/g, (ch) => {
      const map: Record<string, string> = {
        '，': ',', '。': '.', '！': '!', '？': '?', '、': ',',
        '；': ';', '：': ':', '（': '(', '）': ')', '【': '[',
        '】': ']', '「': '[', '」': ']', '『': '[', '』': ']',
        '《': '<', '》': '>',
      };
      return map[ch] ?? ch;
    });
}

/**
 * 固定模板词：LLM 常在专名前后附加这些运营用语（如「挑战活动·百趣演武」）。
 * 只做首尾剥除，不按子串匹配；剥除后剩余部分必须完全相等才视为同一活动。
 * 顺序按长度降序，保证「新区域开放」先于「新区域」、「赛季轮换」先于「赛季」。
 */
const TEMPLATE_TOKENS = [
  '新区域开放', '赛季轮换', '挑战活动', '限时活动', '趣味活动',
  '叙事活动', '拍照活动', '引入活动', '武库申领', '新区域',
  '开放', '赛季', '活动',
] as const;

/**
 * 公告类专名的通用后缀：公告标题常把「X 正式上线（新增网页版）」写成完整句子。
 * 仅 ANNOUNCEMENT 类型启用，避免把活动名里的「上线」误当装饰。
 */
const ANNOUNCEMENT_TOKENS = [
  '(新增网页版)', '（新增网页版）', '官方云游戏上线', '正式上线', '新增网页版',
] as const;

/** 首尾装饰字符：分隔符、引号残留、空白 */
const EDGE_DECOR = /^[\s·・•\-—–_/\\|,.;!?]+|[\s·・•\-—–_/\\|,.;!?]+$/g;

/** 去掉首尾装饰，以及整体包裹的 [] / <>（「」《》归一化后的形态） */
function trimEdge(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(EDGE_DECOR, '').trim();
    if (
      (out.startsWith('[') && out.endsWith(']')) ||
      (out.startsWith('<') && out.endsWith('>'))
    ) {
      out = out.slice(1, -1).trim();
    }
    if (out === before) break;
  }
  return out;
}

/**
 * 活动身份键：在 normalizeCanonicalName 基础上再去掉首尾模板词与分隔符。
 *
 * 用途仅限“同一活动”的确定性判定：两个名称的 eventKey 完全相等才合并。
 * 不做子串包含、编辑距离或模糊匹配，避免把不同活动误合并。
 * 地区/版本限定的变体（如「丹青渡」新区域「武陵-祀的画」）不会收敛到「祀的画」，
 * 这是有意保留的边界。
 */
export function eventKey(name: string | undefined, type?: string): string {
  let out = normalizeCanonicalName(name);
  if (!out) return '';
  // 分隔符不承载专名信息，「战争回响·异想」与「战争回响 异想」应同键
  out = out.replace(/[\s·・•\-—–_/\\|]+/g, '');
  out = trimEdge(out);
  const tokens =
    type === 'ANNOUNCEMENT'
      ? [...ANNOUNCEMENT_TOKENS, ...TEMPLATE_TOKENS]
      : TEMPLATE_TOKENS;
  for (let guard = 0; guard < 8; guard++) {
    out = trimEdge(out);
    let changed = false;
    for (const token of tokens) {
      if (out.startsWith(token)) {
        out = trimEdge(out.slice(token.length));
        changed = true;
        break;
      }
      if (out.endsWith(token)) {
        out = trimEdge(out.slice(0, -token.length));
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return out;
}
