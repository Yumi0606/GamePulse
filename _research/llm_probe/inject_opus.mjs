/** 单条历史动态注入（RSS 窗口外的补测样本）：构造 Item → 正式管道入库 → OCR 补齐。
 * 样本：B站 opus 1248144986163118083（终末地「集成援助·泡泡出击」活动说明，2026-09-15 12:00 发布）
 * 用法：node _research/llm_probe/inject_opus.mjs
 */

import { upsertPosts } from '../../dist/store.js';
import { enrichOcr } from '../../dist/enrich.js';

// 浏览器抓取的完整正文（截去尾部游戏卡片杂讯）
const desc = `#明日方舟终末地# #雪凇幽梦#
「集成援助·泡泡出击」集成生产活动说明

▼//活动时间
2026/09/16 12:00 - 2026/09/30 16:00（服务器时间）

▼//活动奖励
活动开放期间，完成任务，累计可获得【嵌晶玉】【高阶培养自选箱Ⅰ】【高级认知载体】【存续的痕迹】等活动奖励。

▼//参与条件
完成主线任务「第二章 - 进程Ⅱ - 无患之患」

▼//活动说明
· 活动期间，完成特定任务以解锁援助物品配方与物资兑换处。生产援助物品并提交至据点可获得【武陵调度券】与【援助成果券】，使用【援助成果券】可在物资兑换处兑换物资。（活动开启后第8天，物资兑换处将新增额外的可兑换物资。）
· 9月30日16:00（服务器时间）活动结束后，已生产但未提交至据点的援助物品，将会自动兑换为【武陵调度券】与【援助成果券】，并通过邮件发送。其中，超出可兑换调度券上限的部分将自动兑换为【援助成果券】。
· 活动结束后，物资兑换处还会额外开放一段时间便于管理员兑换剩余物资。请管理员在10月7日04:00（服务器时间）前及时兑换。
· 活动期间，达成指定条件即可获得本活动专属蚀刻章。

※ 更多活动详细说明，请前往游戏内【活动中心】查看。`;

// 与 RSS 管道同形态的 Item（title 为正文截断，图为主视觉海报原图 URL）
const item = {
  id: 'endfield:NEWS:1248144986163118083',
  sourceId: '1248144986163118083',
  source: 'rsshub-bilibili',
  gameId: 'endfield',
  type: 'NEWS',
  title: '#明日方舟终末地##雪凇幽梦# 「集成援助·泡泡出击」集成生产活动说明 ▼//活动时间 2026/09/16 12:00 - 2026/09/30',
  url: 'https://www.bilibili.com/opus/1248144986163118083',
  publishedAt: Math.floor(Date.parse('2026-09-15T12:00:00+08:00') / 1000),
  author: '明日方舟终末地',
  description: desc,
  images: ['https://i0.hdslb.com/bfs/new_dyn/c2caf7b65d4c8e42efd4a528f486db811265652806.png'],
};

const r = await upsertPosts([item]);
console.log('入库结果:', JSON.stringify(r));

// 新图走 OCR 侧车补识别（侧车未启动时内部跳过并告警）
const ocr = await enrichOcr();
console.log('OCR 结果:', JSON.stringify(ocr));
