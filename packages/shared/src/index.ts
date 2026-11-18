/**
 * 前后端共享契约。
 *
 * 约束：
 * - 本包不得依赖 apps/*，只允许标准库与 zod。
 * - DTO 一律 camelCase，时间一律 Unix 秒（展示走 fmtCst，固定 Asia/Shanghai）。
 * - Zod schema 同时承担服务端响应校验、序列化白名单（fastify-type-provider-zod
 *   按 schema 剔除多余字段）与前端类型来源，故字段增删必须同时考虑两侧。
 */
import { z } from 'zod';

// ---- 枚举 ----

/** 原始动态大类（与《调研报告-活动数据结构》§2 对齐） */
export const ITEM_TYPES = ['NEWS', 'ACTIVITY', 'GACHA', 'SHOP', 'COLLAB', 'ANNOUNCEMENT'] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

/** 结构化条目大类：NEWS 只留在 posts，entries 只收可排期大类 */
export const ENTRY_TYPES = ['ACTIVITY', 'GACHA', 'SHOP', 'COLLAB', 'ANNOUNCEMENT'] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

/** 条目大类的中文展示标签（服务端 RSS 与前端共用，避免各处自造） */
export const ENTRY_TYPE_LABEL: Record<EntryType, string> = {
  ACTIVITY: '活动',
  GACHA: '卡池',
  SHOP: '商店',
  COLLAB: '联动',
  ANNOUNCEMENT: '公告',
};

/**
 * 生命周期：条目的到期性质，与"状态"正交（见 SPEC §6）。
 * - limited   有预设结束节点
 * - permanent 没有预设结束节点，长期存在
 * - event     某日生效的一次性内容更新，本身没有持续期
 * 未判定与公告不适用都落为 NULL，用 type 区分公告。
 */
export const ENTRY_LIFECYCLES = ['limited', 'permanent', 'event'] as const;
export type EntryLifecycle = (typeof ENTRY_LIFECYCLES)[number];

/** 生命周期筛选的查询取值：unjudged 表示未判定（排除公告） */
export const ENTRY_LIFECYCLE_FILTERS = [...ENTRY_LIFECYCLES, 'unjudged'] as const;
export type EntryLifecycleFilter = (typeof ENTRY_LIFECYCLE_FILTERS)[number];

/** 生命周期中文标签；筛选用的 unjudged 与数据取值分开维护 */
export const ENTRY_LIFECYCLE_LABEL: Record<EntryLifecycle, string> = {
  limited: '限时',
  permanent: '常驻',
  event: '更新',
};

export const ENTRY_LIFECYCLE_FILTER_LABEL: Record<EntryLifecycleFilter, string> = {
  ...ENTRY_LIFECYCLE_LABEL,
  unjudged: '未判定',
};

// ---- 时间格式化 ----

const CST_DT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Unix 秒 → 北京时间 `YYYY-MM-DD HH:mm`；禁止直接用 toISOString()（UTC）展示 */
export function fmtCst(unix: number): string {
  return CST_DT.format(unix * 1000);
}

// ---- DTO ----

/** 游戏选项：/games 返回，前端据此渲染筛选项，不静态复制游戏清单 */
export const GameDto = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});
export type GameDto = z.infer<typeof GameDto>;

/** 游戏列表响应 */
export const GamesDto = z.object({
  items: z.array(GameDto),
});
export type GamesDto = z.infer<typeof GamesDto>;

/** 拉取批次统计（meta 表） */
export const MetaDto = z.object({
  /** 批次开始时间，Unix 秒 */
  lastRunAt: z.number().int(),
  /** 批次耗时，毫秒 */
  durationMs: z.number().int(),
  fetched: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  errors: z.array(z.string()),
});
export type MetaDto = z.infer<typeof MetaDto>;

/** 源健康事件 */
export const EventDto = z.object({
  id: z.number().int(),
  gameId: z.string().nullable(),
  kind: z.enum(['http', 'network', 'parse', 'empty']),
  summary: z.string(),
  detail: z.string().nullable(),
  isCookieSuspect: z.boolean(),
  /** 发生时间，Unix 秒 */
  occurredAt: z.number().int(),
  /** 恢复时间，Unix 秒；null=未恢复 */
  resolvedAt: z.number().int().nullable(),
});
export type EventDto = z.infer<typeof EventDto>;

/** 源健康事件列表（健康页用），按发生时间倒序，最多保留最近 200 条 */
export const EventListDto = z.object({
  items: z.array(EventDto),
});
export type EventListDto = z.infer<typeof EventListDto>;

/** 单个调度循环的运行状态 */
export const LoopStatusDto = z.object({
  /** 定时循环是否已启动（--view-only 时为 false） */
  started: z.boolean(),
  /** 调度方式的可读描述，如 `cron expr="0 8 * * *" tz=Asia/Shanghai` */
  schedule: z.string(),
  /** 最近一次开始执行时间，Unix 秒；null=尚未执行 */
  lastRunAt: z.number().int().nullable(),
  /** 预计下次触发时间，Unix 秒；null=未启动 */
  nextRunAt: z.number().int().nullable(),
});
export type LoopStatusDto = z.infer<typeof LoopStatusDto>;

/**
 * 项目健康快照：扫描开关、启用游戏、积压量、未恢复事件与最近一次拉取统计。
 * 只读聚合，不含写入与任务控制能力。
 */
export const HealthDto = z.object({
  /** 服务端当前时间，Unix 秒（前端据此校正相对时间显示） */
  now: z.number().int(),
  scan: z.object({
    /** 是否启用定时拉取与处理链 */
    enabled: z.boolean(),
    fetch: LoopStatusDto,
    process: LoopStatusDto,
  }),
  games: z.object({
    enabled: z.number().int(),
    total: z.number().int(),
  }),
  /** 处理链积压：只统计仍会进入队列的量，终态（永久失败）单独计数 */
  backlog: z.object({
    /** 等待 LLM 结构化的动态数（尝试次数未达上限，且引用的图片已全部到达终态） */
    postsToExtract: z.number().int(),
    /** 等待 OCR 的图片数（不含永久失败已放弃的图片） */
    imagesToOcr: z.number().int(),
    /** 永久失败的图片数：识别失败次数达上限，已不再重试 */
    deadImages: z.number().int(),
    /** 已放弃结构化的动态数：提取失败次数达上限，已不再重试 */
    abandonedPosts: z.number().int(),
  }),
  /** 数据质量指标：未判定生命周期暴露在这里，避免新空值悄悄积累 */
  quality: z.object({
    /** type != ANNOUNCEMENT 且 lifecycle IS NULL 的条目数 */
    unjudgedLifecycle: z.number().int(),
  }),
  events: z.object({
    unresolved: z.number().int(),
    cookieSuspect: z.number().int(),
    latest: EventDto.nullable(),
  }),
  /** 最近一次拉取批次；从未拉取时为 null */
  meta: MetaDto.nullable(),
});
export type HealthDto = z.infer<typeof HealthDto>;

// ---- 条目状态 ----

export const ENTRY_STATUSES = ['not-started', 'ongoing', 'ended', 'unknown'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
export const EntryStatusSchema = z.enum(ENTRY_STATUSES);

/** 条目状态的中文标签 */
export const ENTRY_STATUS_LABEL: Record<EntryStatus, string> = {
  'not-started': '未开始',
  ongoing: '进行中',
  ended: '已结束',
  unknown: '时间未知',
};

/** 排序维度白名单：duration 按 (endAt-startAt) 排，跨游戏比较时长 */
export const ENTRY_SORTS = ['end', 'start', 'published', 'duration'] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];
export const EntrySortSchema = z.enum(ENTRY_SORTS);

/** 北京时间相对 UTC 的固定偏移（无夏令时） */
const CST_OFFSET_SEC = 8 * 3600;

/** 北京时间当日 00:00 对应的 Unix 秒 */
export function cstStartOfDay(unix: number): number {
  return Math.floor((unix + CST_OFFSET_SEC) / 86400) * 86400 - CST_OFFSET_SEC;
}

/**
 * 条目状态判定（服务端唯一的判定实现，前端直接用返回值）。
 * ended 以北京时间当日 00:00 为界：结束时间落在今天的活动整日仍算进行中，
 * 避免"凌晨 4 点结束"的活动在当天白天就从列表消失。
 */
export function entryStatus(startAt: number | undefined, endAt: number | undefined, nowSec: number): EntryStatus {
  if (startAt === undefined) return 'unknown';
  if (startAt > nowSec) return 'not-started';
  if (endAt !== undefined && endAt < cstStartOfDay(nowSec)) return 'ended';
  return 'ongoing';
}

// ---- 条目 DTO ----

/** 引用型时间 */
export const TimeRefDto = z.object({
  /** 原文表述，如「雪淞幽梦」版本结束 */
  refText: z.string(),
  /** 锚定到的条目 id；未锚定时不出现 */
  refId: z.string().optional(),
  state: z.enum(['unanchored', 'anchored', 'estimated']),
  semanticCheckedAt: z.number().int().optional(),
  semanticNote: z.string().optional(),
});
export type TimeRefDto = z.infer<typeof TimeRefDto>;

/** 活动分段 */
export const EntryPhaseDto = z.object({
  index: z.number().int(),
  title: z.string().optional(),
  startAt: z.number().int().optional(),
  endAt: z.number().int().optional(),
  startRef: TimeRefDto.optional(),
  endRef: TimeRefDto.optional(),
  /** 该段时间为推算估计值，前端需标注"预估" */
  estimated: z.boolean().optional(),
});
export type EntryPhaseDto = z.infer<typeof EntryPhaseDto>;

/**
 * 结构化条目（列表与详情共用同一形态）。
 * 可选字段在 JSON 中直接缺省，不用 null：前端判断存在性即可。
 */
export const EntryDto = z.object({
  id: z.string(),
  gameId: z.string(),
  type: z.enum(ENTRY_TYPES),
  title: z.string(),
  url: z.string().optional(),
  postId: z.string().optional(),
  /** 发布时间，Unix 秒 */
  publishedAt: z.number().int().optional(),
  /** 活动开始，Unix 秒；缺省=无法确定 */
  startAt: z.number().int().optional(),
  /** 活动结束，Unix 秒；缺省=结束时间未知或无结束节点，需结合 lifecycle 判断 */
  endAt: z.number().int().optional(),
  /** 奖励领取截止，Unix 秒 */
  rewardEndAt: z.number().int().optional(),
  /** 生命周期；缺省=未判定或公告不适用 */
  lifecycle: z.enum(ENTRY_LIFECYCLES).optional(),
  /** false=只有日期精度，前端只显示日期不显示时分 */
  startTimeKnown: z.boolean().optional(),
  endTimeKnown: z.boolean().optional(),
  /** 起止为推断值，前端标注"预估" */
  estimated: z.boolean().optional(),
  status: EntryStatusSchema,
  category: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  canonicalName: z.string().optional(),
  /** 主图 URL */
  bannerUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  phases: z.array(EntryPhaseDto).optional(),
  startRef: TimeRefDto.optional(),
  endRef: TimeRefDto.optional(),
  /** 合并后关联的全部来源动态 id */
  postIds: z.array(z.string()).optional(),
  confidence: z.number(),
});
export type EntryDto = z.infer<typeof EntryDto>;

/** 分页响应外壳（entries 与 posts 共用） */
export function pageDto<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}

/** 条目列表响应 */
export const EntryPageDto = pageDto(EntryDto).extend({
  sort: EntrySortSchema,
  order: z.enum(['asc', 'desc']),
});
export type EntryPageDto = z.infer<typeof EntryPageDto>;

// ---- 动态（原始社媒动态）DTO ----

export const PostDto = z.object({
  id: z.string(),
  gameId: z.string(),
  source: z.string(),
  sourceId: z.string(),
  type: z.enum(ITEM_TYPES),
  title: z.string(),
  url: z.string().optional(),
  author: z.string().optional(),
  /** 发布时间，Unix 秒 */
  publishedAt: z.number().int(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  firstSeenAt: z.number().int(),
  updatedAt: z.number().int(),
  /** 最近一次成功提取产出的条目数；null=从未成功提取 */
  entryCount: z.number().int().nullable(),
});
export type PostDto = z.infer<typeof PostDto>;

/** 动态列表响应（默认按发布时间倒序） */
export const PostPageDto = pageDto(PostDto);
export type PostPageDto = z.infer<typeof PostPageDto>;

/** 单张图片的 OCR 状态：missing=尚无记录（待识别或已放弃但无记录不会出现） */
export const OcrImageDto = z.object({
  imageUrl: z.string(),
  status: z.enum(['ok', 'failed', 'missing']),
  text: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
});
export type OcrImageDto = z.infer<typeof OcrImageDto>;

/** 单条动态的 OCR 明细 */
export const PostOcrDto = z.object({
  postId: z.string(),
  images: z.array(OcrImageDto),
});
export type PostOcrDto = z.infer<typeof PostOcrDto>;
