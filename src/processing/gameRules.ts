/**
 * 游戏专属结构化规则（P1）：
 * 通用 Prompt 定义大类语义与时间规则；本模块为每款游戏提供小活动归类细则与固定子类型词表，
 * 按 gameId 注入 system prompt。规则只在 LLM 提取阶段生效，不做硬编码的字段修补。
 *
 * 维护方式：直接修改本文件中的 prompt 文本与 categories 词表；新增游戏时加一条并在 games.ts 登记。
 */
import type { EntryType } from '../core/types.js';

export interface GameRule {
  /** 注入 system prompt 的专属规则正文（Markdown，接在通用规则之后） */
  prompt: string;
  /** 各大类允许的 category 词表；LLM 输出词表外值时由代码归一为"其他"；未列出的大类不约束 */
  categories: Partial<Record<EntryType, string[]>>;
}

/** 所有游戏通用的固定子类型兜底名 */
export const CATEGORY_OTHER = '其他';

const RULES: Record<string, GameRule> = {
  arknights: {
    prompt: `## 明日方舟专属规则
- 版本更新/停机维护本身归 ANNOUNCEMENT；版本内的活动、卡池、商品各自独立成条，不要把版本更新重复建成 ACTIVITY。
- 同一条动态同时包含维护公告与维护补偿时，合并为一条维护公告（补偿写进描述）；只有独立发布的补偿公告才单独成条。
- 前瞻特别节目：有明确日期才收录为 ANNOUNCEMENT；多条动态（预告、回顾）报道同一期节目时，canonicalName 必须完全一致，如"丹青渡版本前瞻特别节目"。
- 活动/卡池的"即将结束/最后 X 天"提醒归 ANNOUNCEMENT；商品下架不收；事件已结束后的返图、留影、回顾不收。
- ACTIVITY：SideStory 及活动关卡、集成战略内容更新、危机合约、剿灭作战追加、限时签到、常驻玩法内容更新。
- GACHA：限时寻访（限定/联动/定向甄选）、中坚寻访、常驻标准寻访。常驻标准寻访每月是不同卡池，canonicalName 必须包含当期 UP 干员名，如"标准寻访·妮芙/波卜"。
- SHOP：游戏内一切可购买或兑换内容——时装（含复刻/回顾展）、家具、组合包、凭证区兑换更新；换装附属剧情同归 SHOP。
- COLLAB：现实 IP/品牌联动，以及线下展会/参展信息（即使无游戏内道具）。`,
    categories: {
      ACTIVITY: ['SideStory/活动关卡', '集成战略更新', '危机合约', '剿灭作战', '限时签到', '常驻玩法更新', CATEGORY_OTHER],
      GACHA: ['限时寻访', '中坚寻访', '常驻标准寻访', CATEGORY_OTHER],
      SHOP: ['限时时装', '时装复刻', '限时家具', '组合包', '凭证区兑换更新', CATEGORY_OTHER],
      ANNOUNCEMENT: ['停机维护', '闪断更新', '版本更新', '补偿公告', '前瞻节目', '结束提醒', CATEGORY_OTHER],
      COLLAB: ['IP联动', '线下展会', CATEGORY_OTHER],
    },
  },

  endfield: {
    prompt: `## 明日方舟：终末地专属规则
- 抽取系统统一归 GACHA：干员抽取（特许寻访、重构寻访）与武器抽取（武库申领、重构申领）都是，category 用"干员寻访/武器申领"区分；仅"新干员登场"而无寻访开启或概率信息时不建 GACHA。
- 核心章节版本上线归 ANNOUNCEMENT（category=核心章节版本上线）；版本内具体内容各自独立成条：限时活动（如"烟火生缘"）归 ACTIVITY、寻访归 GACHA、新区域开放归 ACTIVITY（category=新区域开放）。
- 同一期寻访被多条动态报道时 canonicalName 必须一致，并含区分要素（池名+UP 对象），如"特许寻访·烟火邀星河（明河）"；分多期的寻访按期区分。
- 维护公告与同帖补偿合并为一条；独立补偿单独成条。前瞻特别节目有日期才收 ANNOUNCEMENT，多动态报道同一期 canonicalName 一致。
- ACTIVITY：版本限时活动、叙事/挑战/趣味/拍照/解谜活动、限时签到、干员试用、赛季轮换、常驻玩法（战争回响、密境行者等）更新、新区域开放、可领奖励的网页活动（如新版本导览页首次查看送嵌晶玉，归 ACTIVITY）；纯信息导览页不收。
- SHOP：协议通行证、寻访组合包、塔晶集换兑换（装饰物品、拍照动作等游戏内可兑换内容）、限时兑换。
- COLLAB：现实 IP/品牌联动（如汉堡王），以及线下展会/参展信息（即使无游戏内道具）。
- 活动结束提醒归 ANNOUNCEMENT；已结束后的留影/回顾不收。`,
    categories: {
      ACTIVITY: ['版本活动', '限时活动', '叙事活动', '挑战活动', '趣味活动', '拍照活动', '解谜活动', '限时签到', '干员试用', '赛季轮换', '常驻玩法更新', '新区域开放', '网页活动', CATEGORY_OTHER],
      GACHA: ['干员寻访', '武器申领', CATEGORY_OTHER],
      SHOP: ['通行证', '组合包', '装饰兑换', '限时兑换', CATEGORY_OTHER],
      ANNOUNCEMENT: ['核心章节版本上线', '维护公告', '补偿公告', '前瞻节目', '服务上线', '结束提醒', CATEGORY_OTHER],
      COLLAB: ['IP联动', '线下展会', CATEGORY_OTHER],
    },
  },

  'wuthering-waves': {
    prompt: `## 鸣潮专属规则
- 角色活动唤取、武器活动唤取归 GACHA，canonicalName 含 UP 对象，分多期时含期数，如"角色活动唤取·显影于明日（洛瑟菈）"。
- 现实品牌/IP 联动一律归 COLLAB（如爱回收"返航新生"），即使参与可领游戏道具礼包；不要因为有游戏内奖励而改归 ACTIVITY。线下展会（CICF）、巡游巴士、快闪等现实活动也归 COLLAB。
- 版本开启/版本更新归 ANNOUNCEMENT；版本内的活动（休闲玩法、网页活动、签到等）归 ACTIVITY。
- 前瞻通讯/前瞻节目有日期才收 ANNOUNCEMENT，多动态报道同一期 canonicalName 一致。
- ACTIVITY：版本活动、战斗活动、休闲活动、可领奖励的网页活动、限时签到、双倍掉落、角色试用、探索委托。
- SHOP：游戏内可购买/兑换内容（礼包、珊瑚商店上架等）。
- 活动/唤取结束提醒归 ANNOUNCEMENT；已结束后的返图/留影不收。`,
    categories: {
      ACTIVITY: ['版本活动', '战斗活动', '休闲活动', '网页活动', '限时签到', '双倍掉落', '角色试用', '探索委托', CATEGORY_OTHER],
      GACHA: ['角色活动唤取', '武器活动唤取', CATEGORY_OTHER],
      SHOP: ['商店上架', '限时礼包', CATEGORY_OTHER],
      ANNOUNCEMENT: ['版本开启', '维护公告', '补偿公告', '前瞻节目', '结束提醒', CATEGORY_OTHER],
      COLLAB: ['IP联动', '线下展会', '巡游活动', CATEGORY_OTHER],
    },
  },

  'azur-lane': {
    prompt: `## 碧蓝航线专属规则
- 时间表述常为"X月X日维护后""X月X日维护""下次维护后"：输出纯日期 YYYY-MM-DD（代码按该游戏缺省时刻补全），同时把原文**逐字**填入对应一端的 startRef/endRef；不要自行改写、补全或省略"下次/维护后"。
- 维护相关的具体时刻由代码依据港区改建公告的维护窗口回填，你不需要推算 10:00/16:00；日期仍要填，供公告到达前的展示兜底。
- 港区改建（维护）、在线更新、问题修复归 ANNOUNCEMENT；活动结束提醒也归 ANNOUNCEMENT（category=活动结束提醒）；商品换装下架不收。
- 同帖维护与补偿合并为一条公告。
- ACTIVITY：大型活动、限时活动、轻量复刻/复刻活动、舰船限时活动获取、作战档案录入更新、世界巡游/通行证、研发计划、限时任务。
- GACHA：限时建造、限定祈愿建造、常驻建造池新增。
- SHOP：游戏内一切可购买/兑换内容——换装（含 Live2D/誓约/复刻）、换装礼盒、密语剧情、主题家具、特许巡游凭证、军需/核心/META 等商店兑换新增、限时礼包。
- COLLAB：现实 IP/品牌联动，以及线下展会/参展信息。`,
    categories: {
      ACTIVITY: ['大型活动', '限时活动', '复刻活动', '舰船限时获取', '作战档案更新', '世界巡游', '研发计划', '限时任务', CATEGORY_OTHER],
      GACHA: ['限时建造', '限定祈愿建造', '常驻建造新增', CATEGORY_OTHER],
      SHOP: ['限时换装', '换装复刻', '换装礼盒', '密语剧情', '限时家具', '商店兑换新增', '特许巡游凭证', '限时礼包', CATEGORY_OTHER],
      ANNOUNCEMENT: ['港区改建', '在线更新', '问题修复', '活动结束提醒', CATEGORY_OTHER],
      COLLAB: ['IP联动', '线下展会', CATEGORY_OTHER],
    },
  },

  'delta-force': {
    prompt: `## 三角洲行动专属规则
- 本游戏不使用 GACHA：付费或代币抽取的补给/军需/抽奖归 SHOP（category=付费补给/军需）；免费的累计在线时长、累计登录、完成任务领取归 ACTIVITY。
- ACTIVITY：赛季（新赛季开启、赛季通行证冲刺）、限时玩法/模式（黑潮爆破、极星守望等新玩法上线）、登录与累计福利（三角券、载具、外观登录领）、畅玩月（经验/军功加倍、保分）、游戏内公益行动（可领/送游戏内公益金等）、高校认证的游戏内福利（如限时免费体验武器、全干员解锁）、常驻内容上新（新武器配件、新模式内容）。
- 不收录：纯线下电竞赛事/观赛、城市赛点、网吧冲榜等无游戏内道具领取的现实活动；纯公益直播（无游戏内奖励）不收。
- COLLAB 仅用于现实 IP/品牌联动（如与艺人、餐饮品牌的联动）；线下展会参展也归此。
- 同一条汇总动态包含多件事时按上述边界逐条拆分：游戏内可领道具的建条，纯线下部分不建。
- ANNOUNCEMENT：版本更新、维护公告、纯直播/节目预告（有日期且与游戏内容相关时）。
- 活动/赛季结束提醒归 ANNOUNCEMENT。`,
    categories: {
      ACTIVITY: ['赛季', '限时玩法', '登录/累计福利', '畅玩月加倍', '游戏内公益', '高校认证福利', '常驻内容上新', CATEGORY_OTHER],
      SHOP: ['外观上架', '付费补给/军需', '通行证', CATEGORY_OTHER],
      ANNOUNCEMENT: ['版本更新', '维护公告', '节目预告', '结束提醒', CATEGORY_OTHER],
      COLLAB: ['IP联动', '线下展会', CATEGORY_OTHER],
    },
  },
};

/** 取游戏专属规则；未登记游戏返回 undefined（调用方只发通用规则） */
export function gameRuleFor(gameId: string): GameRule | undefined {
  return RULES[gameId];
}

/** 校验并归一 category：不在该游戏该大类词表内的值归一为"其他"；游戏/大类无词表时原样返回 */
export function normalizeCategory(gameId: string, type: EntryType, category: string | undefined): string | undefined {
  const c = category?.trim();
  if (!c) return undefined;
  const allowed = RULES[gameId]?.categories[type];
  if (!allowed || allowed.includes(c)) return c;
  return CATEGORY_OTHER;
}
