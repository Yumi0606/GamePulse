# 《明日方舟：终末地》活动日历与过期提醒：GitHub 轮子调研

## 摘要：不要从零抓公告，最值得复用的是“终末地数据核心 + 薄推送层”

截至 **2026-10-24**，最接近“开箱可用”的不是某个完整机器人，而是已经把终末地当期卡池、活动起止和降级来源做掉的 **`gacha-calendar-core`**（浏览器扩展 `EastMG/gacha-calendar-extension` 与 DSH 插件只是它的两个外壳）。它已覆盖明日方舟与终末地，MIT、零运行时依赖、2026 年 10 月仍在发版，是数据层首选。[1][2] 第二梯队是熵增项目组的 **`endfield-plugin` / `astrbot_plugin_endfield` / `nonebot-plugin-endfield`**：它们已经把“查日历—订阅—到点推送”跑通在 QQ 生态里，但活动数据依赖第三方终末地 API（`end-api.shallow.ink` 一类），属于“能用但要承担后端稳定性”，AGPL-3.0。[3][4][5]

纯展示侧，**`jacket-sikaha/game-schedule`** 有现成的 `endfield/` Cloudflare Worker 适配器、标准化 `CalendarActivity` 和一套不错的网格日历组件，但项目自述早期只精确到“天”，且近一年提交节奏明显放缓，适合借适配器与 UI，不适合当高准时推送源。[6][7] **`cmyyx/cep`** 与 **`MoguJunn/endfield-gacha`** 是终末地专用前端：卡池日历、版本倒计时、活动/卡池时间都有，前者纯静态导出、后者带 Node API 与数据库；两者都没有“订阅后主动按剩余时间轰炸你”的通道，归为 C 类。[8][9]

结论性路线：**`gacha-calendar-core` 出结构化事件 → 一个无状态 Cloudflare Worker 做去重、时区与 VALARM（提前 24h / 4h / 30min）→ `ical-generator` 吐 `/endfield.ics` → `nrouanet/eventsbot` 或自写 OneBot/Mirai 投递 QQ/Discord/Telegram/Webhook**。自己只补三件事：终末地服区与夏令时口径、提醒状态存储、以及 Wiki 字段缺漏时的兜底规则。方舟旧轮子（`GanttKnights`、`ArkBulletinGPT`）只能借“公告→事件+提醒策略”，数据不能迁移到终末地。[10][11]

## 一、口径：先分清“有数据”“有骨架”和“只有日历脸”

本报告的分类直接决定一个仓库值不值得 fork：

| 类别 | 判定 | 对终末地的意义 |
|---|---|---|
| **A 有结构化数据** | 仓库里已有终末地/方舟的抓取器、适配器或经过校验的活动表，输出含 `start/end/title/type` | 可直接喂日历与提醒，**优先复用** |
| **A- 数据来自绑定 API** | 终末地专用，但靠第三方聚合 API、cookie/cred 或公告接口，断一处就全断 | 上线最快，运维成本藏在“上游” |
| **B 框架/骨架** | 有定时、订阅、QQ/Discord/Telegram、ICS 或 cron，事件要自己填 | 只复用通道与状态机 |
| **C 前端组件/静态页** | 有月历、时间条、倒计时 UI，无服务端抓取与推送 | 抄视图，不抄架构 |

“最近提交时间”以检索到的仓库页面/包索引最新可见提交或发布为准，基准日 2026-10-24；GitHub 主站在抓取环节对部分原页返回安全拦截，因此个别仓库的**精确 commit hash、star、归档开关**若无法由公开页面坐实，一律写“未确认”，不用第三方镜像猜。

## 二、A 类：真正能直接喂终末地的四个轮子

### 2.1 `EastMG/gacha-calendar-core` + `gacha-calendar-extension`：数据层第一名，几乎不用改

| 项 | 结论 |
|---|---|
| 仓库 | [EastMG/gacha-calendar-extension](https://github.com/EastMG/gacha-calendar-extension)（核心包 [gacha-calendar-core](https://www.npmjs.com/package/gacha-calendar-core)，DSH 插件 `dsh-gacha-calendar`） |
| 语言/栈 | TypeScript；浏览器扩展 MV3 + 独立 core；DSH 桌面端共用同一 core |
| 维护状态 | **活跃**：扩展页面可见 2026-10-16 提交（升级 core 至 0.12.0）；core 在 npm 可见 2026-10-22 发布 0.9.40；未确认是否归档 |
| 数据来源 | 每游戏独立：官网公告 / Wiki / 第三方站，抓取失败自动降级到其他来源；终末地与明日方舟都在覆盖游戏清单里 |
| 核心能力 | 当期卡池+活动起止、倒计时、悬停看原文、按游戏开关/排序/自定义条目；**无内建 ICS、无推送** |
| 后端定时 | 没有。是客户端“按间隔拉取”模型，刷新间隔 1–42 天可配；要做主动提醒必须外包一层 |
| 部署难度 | 极低：想只看，装扩展或 DSH 插件；想服务化，`import` core 后写 30 行 wrapper |
| License | MIT（扩展与 DSH 插件页均明示 MIT）[1][2] |
| 终末地可用性 | **A，最可用**：终末地已在 28 款清单（鹰角：明日方舟/终末地），core 0.12 被扩展内联 |

**为什么它赢**：终末地活动最烦的是“公告标题里只有开始时间”“Wiki 写作 UTC+8 而美欧服另算”“新卡池还没公布时要保留上期而非报错”。这个 core 的失败降级、原文保留、每游戏独立源设计，正好把脏活做完了。它的输出模型（标题、起止、来源链接、图标）足够扁平，能直接映射成 iCal `VEVENT`，不需要再解析 HTML。

**坑**：core 仓库本体未在本次检索中成功打开，扩展页只能证明“终末地在清单内、core 0.12.0 可用”，不能证明每个终末地字段都 100% 准。上线前必须跑一次 `verify-live` 等价检查，并把“未公布”状态单独映射成 `TENTATIVE`，不要生成确定结束时间。另因扩展扩表会新增域名，服务化时要把允许列表/代理加白一起管起来。[1]

### 2.2 熵增项目组终末地插件族：QQ 用户的最短路径，但被第三方 API 绑架

| 项 | `endfield-plugin`（Yunzai） | `astrbot_plugin_endfield` | `nonebot-plugin-endfield` |
|---|---|---|---|
| 组织/仓库 | [Entropy-Increase-Team/endfield-plugin](https://github.com/Entropy-Increase-Team/endfield-plugin) | 组织同名 AstrBot 插件（仓库页未确认） | [pynickle/nonebot-plugin-endfield](https://github.com/TomeChen/nonebot-plugin-endfield) 的 PyPI 发布 [5] |
| 栈 | TypeScript/Node + Yunzai | Python + AstrBot | Python 3.9+ / NoneBot2 + OneBot |
| 最近提交 | 页面检索到 2026 年持续更新；精确日期未确认 | 未确认 | 仓库 2026-05-26 v1.21.0；npm 侧 1.20.x 线 2026 年 3 月后仍有发布，维护口径“Sustainable” [12] |
| 数据源 | 第三方终末地 API（README 致谢“浅巷墨黎整理提供的终末地 API 后端”） | 同一后端体系 + 森空岛 | `end-api.shallow.ink`，需 `endfield_api_key` [4][5] |
| 日历/倒计时 | `日历` 活动版本日历、`公告`、活动速览 | `日历` 活动版本日历 + 公告订阅 | 有公告获取与图片化，**日历/到期提醒不是主打** |
| 推送 | QQ 会话订阅/取消订阅、公告订阅、定时推送 | 公告、理智、调度券订阅推送 | 需自己接 NoneBot 定时任务与 matcher |
| 后端定时 | 宿主机器人常驻即带定时；不是独立 worker | AstrBot 调度 | `nonebot-plugin-scheduler` 之类另接 |
| 部署难度 | 中：要 Yunzai/OneBot + 登录凭据体系 | 中：AstrBot 环境 | 中低：NoneBot2 标准插件，`pip install` 即可 |
| License | AGPL-3.0（仓库 README 明示）[3] | 未确认（组织口径多为 AGPL-3.0） | MIT（PyPI 元数据 SPDX）[5] |
| 终末地可用性 | **A-，QQ 群直用** | **A-** | **B+**：有数据客户端，提醒要补 |

**它能省掉什么**：不是“抓公告”那一段，而是“用户绑定—会话订阅—按服按人推送—卡片渲染”整条 QQ 链路。熵增组的 README 把 Yunzai / AstrBot / NoneBot2 / Karin 四个框架并列维护，说明抽象层已经下沉到共享数据服务，这是比单仓库更值钱的信号。[3]

**它不能当唯一真相源**：活动结束时间来自聚合 API 的二次整理，官方改公告措辞、上游换字段、API key 限额都会让你“准时地推错”。正确用法是把它当**第一个消费者 + 人工兜底**，主 ICS 仍由 core 或 Wiki 适配器生成，两者不一致时报警而不是静默覆盖。

### 2.3 `jacket-sikaha/game-schedule`：终末地适配器 + 日历 UI 都很完整，准时性要降级预期

| 项 | 结论 |
|---|---|
| 仓库 | [jacket-sikaha/game-schedule](https://github.com/jacket-sikaha/game-schedule) |
| 语言/栈 | TypeScript monorepo；React 19 + Vite 前端，Cloudflare Workers（itty-router）+ Redis + pnpm/Turborepo |
| 维护状态 | 2024 年提交密集、2026 年仍可见 CI workflow 与 release 记录；**近期 commit 精确日期未确认**，明显不是高频活跃，未确认归档 |
| 数据来源 | 官网与 Wiki API 抓取，归一为 `CalendarActivity`；`apps/cloudflare-backend/src/endfield/` 即终末地适配器；缓存 300s [6][7] |
| 核心能力 | 月/周网格、重叠时间条与 `levelAssignment` 布局、Banner 提取预览、按游戏路由懒加载、已结束下沉；**ICS 端点未在检索到的 README 中确认** |
| 后端定时 | Worker 是 HTTP + 短缓存，不是 cron；要过期提醒得自己在外部轮询 `/endfield` 再投送 |
| 部署难度 | 中高：Cloudflare + Redis + 前后端两套构建，但 `pnpm dev`/`pnpm build` 已标准化 |
| License | 未确认（仓库页面被拦截，未在 README 摘要中出现） |
| 终末地可用性 | **A- 做原型极快，生产提醒需复核**：endfield 源真实存在，但作者早期自述时间“暂时精确到天”[7] |

**真正该抄的是两个文件**：`endfield/` 里的抓取/归一化，以及 `EventCalendar/utils.ts` 的层级排布算法。前者解决“Wiki 表格 → 事件”，后者解决“五个活动同时在周三怎么不叠成一条”。若你只做 Web 日历，直接 fork 这个仓库比从零写快两周；若做“提前 30 分钟提醒”，它的天级精度反而要被 core 或公告 API 替换掉。

### 2.4 `cmyyx/cep` 与 `MoguJunn/endfield-gacha`：终末地 UI 现成，推送自己接

| 项 | `cmyyx/cep` | `MoguJunn/endfield-gacha` |
|---|---|---|
| 仓库 | [cmyyx/cep](https://github.com/cmyyx/cep) | [MoguJunn/endfield-gacha](https://github.com/MoguJunn/endfield-gacha) |
| 栈 | Next.js 16 App Router + TS strict + Shadcn/Tailwind + Zustand；纯静态 `output: export` | Node >=22 + 浏览器前端 + API + DB schema + 官方 Bot；v4.6.4（2026-10-09）[8][9] |
| 维护状态 | 2026 年持续提交（精确日期未确认）；未确认归档 | **活跃**：2026-10-09 发版、10-17 仍有热修；未确认归档 |
| 数据来源 | 子模块 `cep-assets` 的游戏文案/目录 + 公共只读接口；卡池日历含复刻排期，**偏静态/半静态** | 公共数据接口、官方版本导览与导入记录；公告/卡池修改默认可本地草稿，服务端写入在沙盒关闭 [9] |
| 能力 | 卡池日历、角色/武器/基质规划、i18n；无 ICS/推送 | 当前寻访、版本倒计时、独立活动×卡池日历、抽卡模拟；**无可见的订阅投递管道** |
| 后端定时 | 无（静态站；接 API 时另算） | 有 API 与 DB，但公开仓库 `backend/` 只留合同与测试，完整 worker 配置未公开 [9] |
| 部署 | 极低：`pnpm build` 丢任意静态托管 | 中：需 Node、DB、环境变量，按贡献指南起 |
| License | 未确认（页面摘要未出现） | MIT（README 明示）[9] |
| 终末地可用性 | **C+**：日历视图可直接嵌入，数据是快照 | **C+/A- 边界**：时间数据最“像产品”，但不能直接拿来做推送源 |

这两个项目揭示了一个重要事实：**终末地社区已经不再缺“把活动时间画出来”的轮子，缺的是把时间变成可靠通知**。因此别 fork 一整个规划器只为要一张日历；把它的事件 JSON 导出契约抄出来（title / start / end / server / banner / url），用 core 的实时数据覆盖 start/end，才是低成本组合。

## 三、B 类：通道骨架值得借，但别指望它懂终末地

### 3.1 `nrouanet/eventsbot`：iCal → Discord 的最短胶水

Python + YAML + Docker，读任意 iCal URL，把事件灌进 Discord 服务器（创建 Discord Events 并可选发消息），支持“只跑一次”和服务化模式，还有早期 serverless 入口。[13] **没有游戏知识、没有抓取、没有 QQ/Telegram**。License MIT；2026 年状态与最新 commit 在本次检索中未确认。

价值：你的 Worker 只要吐一份标准 ICS，Discord 侧零代码。它也是架构上的“正确分叉点”——ICS 是事实源，bot 只是视图，换 QQ 时不用改数据层。

### 3.2 `ical-generator` + `sebbo2002/ical-generator`

Node/TS 的 iCal 生成库，856 star 量级，2026-10-13 仍有 develop 提交，MIT。[14] 关键是它支持时区、`Temporal` 日期、重复规则与可直接挂 HTTP 的 `calendar.createEvent(...)`。终末地必须带 `VALARM`：

```text
BEGIN:VALARM
TRIGGER:-PT24H
ACTION:DISPLAY
DESCRIPTION:终末地「xxx」将于 24 小时后结束
END:VALARM
```

**注意**：Apple 日历对 `VALARM` 的重复/时区处理比 Android 挑剔；订阅型 ICS 的告警是否生效还取决于客户端，故“必须推送到手”的场景要在服务端再保一份提醒状态，不能只靠 ICS。

### 3.3 通用事件提醒 bot 为什么都不入选短名单

`Hvrnbi/Ical-discord-bot`（Python，读本地 `cal.ics`，`/day today`，MIT，最后 2026-03-05）太玩具；`Boualam3/EventReminderBot`（Node Telegram 提醒，MIT）只有用户自己建事件的 TODO 骨架；`game-scheduler/game-scheduler` 是“约人打游戏”的 Discord 会话编排（FastAPI+RabbitMQ+PostgreSQL），和版本活动无关。它们都能学定时/去重/时区写法，但没有一行使终末地活动出现。

## 四、方舟旧轮子：提醒策略可借，数据不可借

### 4.1 `Zrief/GanttKnights`——最值得抄的“过期提醒心智模型”

AstrBot 插件，Python/matplotlib 出明日方舟甘特图，**MIT，2026-09 仍在发版**（0.1.5，2026-09-24）。它把公告当主键、Wiki 数据页只当目录，修掉了“Wiki 改名导致幻影活动重复一行”的坑；提醒预设是「只提醒最后一天」和「开启前一天也提醒」，并且**第一个发命令的人不会自动被加进推送目标**，必须显式订阅。[10]

对终末地直接可搬的三条：① 事件 identity 用“公告 ID + 官方名归一”，别用 Wiki 页面名；② 长期活动（帝江号赛季、常驻轮换）与限时活动分开，快结束的那个才单独占一行并升级提醒；③ 订阅状态独立于查询命令。它**不含终末地数据、没有 ICS**，所以是 B 类模板，不是数据源。

### 4.2 `Astrian/ArkBulletinGPT`——反面教材也很有价值

TypeScript/Deno 风格小服务，抓明日方舟国服公告、GPT 抽时间、Telegram 发摘要，并吐 `arknights_events.ics`；最后可见 2026-05 提交，License 未确认。[11] 思路（公告原文 → LLM 结构化 → 人审/置信度 → 日历）在终末地新活动刚开、字段还没进 Wiki 时是很好的**兜底解析器**，但“大部分由 GPT-4 生成”意味着你不能把它的输出直接当 `CONFIRMED`。若复用，只允许它产出 `TENTATIVE` 候选，人工或第二次公告抓取确认后才转正式事件。

### 4.3 `gxy12345/arknights-plugin` 与手写 ICS 手动档

Yunzai 方舟插件，基于森空岛 API，2026-03 仍有提交，MIT，能力是便签/签到/抽卡/练度，**日历提醒不是主线**。[15] NGA 那份 `ark-events.ics`（gitee 手动维护，提前 4h 开、提前 8h 结）则说明：最稳的终末地 v1 甚至可以是“一人维护 + 订阅地址”。代价是做不到分钟级新活动秒同步，适合当灰度备选而不是主方案。

## 五、横向评分：为什么短名单把数据核心排第一

评分口径：现成终末地数据 30%、维护 25%、日历能力 20%、推送可接性 15%、许可/部署 10%。不是流行度排名。

![候选轮子离终末地可用的距离](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/1898/1b6ed4290b5d4907b788285e58c3113b/0RVDqgJQTGD/task-f8a41af2d1c4e39fafd10b643d01836a/.rendered/_assets/dr%3Agithub%E6%B8%B8%E6%88%8F%E6%B4%BB%E5%8A%A8%E6%97%A5%E5%8E%86%E9%A1%B9%E7%9B%AE%E8%B0%83%E7%A0%94/%E5%9B%BE1_%E5%A4%8D%E7%94%A8%E8%B7%9D%E7%A6%BB%E8%AF%84%E5%88%86.png)

*图 1：数据核心显著比“完整机器人”更接近终末地可用。数据来源：本报告按上表口径综合评分，原始数据见[候选评分表](/data/workspace/dr:github游戏活动日历项目调研/data_候选评分.csv)（截至 2026-10-24）。*

| 排名 | 仓库 | 类别 | 一句话判断 | 必须自己补 |
|---:|---|---|---|---|
| 1 | **EastMG/gacha-calendar-core** | A | 终末地已在抓取清单，MIT、零依赖、活跃 | ICS/VALARM、服区时区、推送状态表 |
| 2 | **Entropy-Increase-Team/endfield-plugin** | A- | QQ 里“日历+订阅”已跑通，最快给群友用 | 上游 API SLA、双源校验、AGPL 合规 |
| 3 | **jacket-sikaha/game-schedule** | A- | endfield 适配器 + 网格日历一次到位 | 分钟级时间、ICS、活跃度兜底 |
| 4 | **MoguJunn/endfield-gacha** | C+/A- | 终末地版本倒计时与日历最“产品化” | 抽取事件契约、接定时投递 |
| 5 | **ical-generator + nrouanet/eventsbot** | B | 标准 ICS → Discord 几乎零代码 | 全部游戏数据与 QQ/Telegram 适配 |
| 6 | **Zrief/GanttKnights** | B（方舟） | 事件去重、提醒预设、显式订阅的范本 | 换终末地数据源与重写渲染 |

`cmyyx/cep` 紧随第 4 名之后：如果你要做 Web 优先、静态托管、还要顺手带规划器，它比 `endfield-gacha` 更合适；如果只做提醒工具，它的子模块数据反而过重。

## 六、最省事路线：一个 core、一份 ICS、三个触发器

### 推荐架构

```text
[官方公告 / endfield.wiki.gg / 森空岛公告]
          │ 抓取 + 降级
          ▼
 gacha-calendar-core（终末地主轴）
      + game-schedule/endfield 作 Wiki 校验源
      + ArkBulletinGPT 式 LLM 兜底（仅 TENTATIVE）
          │ 归一 Event{id,title,start,end,server,zone,type,src,confidence}
          ▼
 Cloudflare Worker：5 分钟轮询 / 缓存 / 幂等
   ├─ /endfield.ics           ical-generator + VALARM(24h/4h/30m)
   ├─ /endfield.json          给前端网格直接用
   └─ 提醒状态 KV：{eventId, remindAt, channel, ack}
          │
          ├─ Discord  : nrouanet/eventsbot 或直接 webhook
          ├─ Telegram : 自建 30 行 fetch + 定时扫描
          ├─ QQ       : OneBot webhook（Yunzai / NoneBot 侧只收 render 好的卡片）
          └─ 客户端    : 浏览器/DSH 直接 import core，离线看缓存
```

![三条路线的额外工作量对比](https://one-agent-prod-1343551737.cos.ap-guangzhou.myqcloud.com/artifacts/1898/1b6ed4290b5d4907b788285e58c3113b/0RVDqgJQTGD/task-f8a41af2d1c4e39fafd10b643d01836a/.rendered/_assets/dr%3Agithub%E6%B8%B8%E6%88%8F%E6%B4%BB%E5%8A%A8%E6%97%A5%E5%8E%86%E9%A1%B9%E7%9B%AE%E8%B0%83%E7%A0%94/%E5%9B%BE2_%E8%B7%AF%E7%BA%BF%E5%B7%A5%E4%BD%9C%E9%87%8F%E4%BC%B0%E7%AE%97.png)

*图 2：把抓取和触达拆开后，只自研“差值逻辑”。数据来源：基于候选仓库已具备能力与常规接入成本的经验估算；假设已有 Node/Cloudflare 与机器人凭据。*

**为什么不直接用 `endfield-plugin` 一家通吃**：它的优势是 QQ 交互和账号体系，弱点是 AGPL + 单一第三方 API。用 core 当事实源、插件当 QQ 适配器，任一层挂掉都不影响另一层：API 挂了 ICS 仍从 Wiki 出；QQ 平台限流就只靠系统日历告警。

### 最小可上线 v1（约 2 人日）

1. `pnpm add gacha-calendar-core ical-generator`，写一个 `toEvents()` 适配层，把 core 输出规整成统一模型；不确定结束时间的条目不生成 `VALARM`，只标 `TENTATIVE`。
2. Cloudflare Worker 每 5 分钟调一次，按 `eventId + end` 做 etag 式幂等，写入 Cloudflare KV；结束时间变化要**重新调度**已发出的提醒，而不是静默忽略。
3. 暴露 `/endfield.ics`：Asia 服以 UTC+8 为准，美欧服用 endfield.wiki.gg 的双时段字段另建事件（不要在客户端硬加时差，夏令时与开服偏移会错）。[16]
4. 一个 1 分钟 cron：扫“距结束 24h/4h/30m 且未 ack”的记录，POST 到 Discord/Telegram/QQ webhook；失败指数退避，同一 eventId 不重复炸群。
5. 前端先不写：用 `game-schedule` 的 `EventCalendar` 或 `cep` 的日历页占位；等事件契约稳定再换。

### 必须自己补的六件事

| 短板 | 处理方式 | 验收标准 |
|---|---|---|
| **服区语义** | 每个事件带 `server: asia|global`，global 保留 wiki 的 UTC-5/UTC 双写映射 | 同一活动亚洲/全球结束时间不互相覆盖 |
| **时间置信度** | `CONFIRMED` 才发告警；`TENTATIVE` 只进日历黄条；LLM 结果必须二次确认 | 公告只有“开启”无“结束”时绝不推“即将过期” |
| **事件主键** | `normalize(官方名) + server + round`，不要用标题字符串 | Wiki 改名不产生重复事件（借鉴 GanttKnights）[10] |
| **过期语义** | 结束时刻按游戏内结算点（常为整点/半点）减 1 秒算过期；提醒以客户端可见时间为准 | “提前 30 分钟”在 03:59 结束的活动上推 03:29 |
| **订阅治理** | 默认不订阅；`subscribe #channel --before 24h,4h,30m`；退订/静默窗口 | 新用户不会被突然 @ |
| **合规与许可** | core MIT 可内嵌；熵增插件 AGPL 若改源码部署需开源；游戏名/图资产非 MIT | 不打包鹰角美术资源，运行时拉官方 URL 并加缓存 |

## 七、风险与决策建议

**最大的风险不是代码，是“时间从哪来”。** 终末地活动常有亚洲服与全球服错峰、公告先给开启不给结束、Wiki 编辑领先或落后于客户端的情况。`gacha-calendar-core` 的降级来源是目前最省的解法，但它仍是社区抓取，不能承诺秒级。因此 v1 就要把“数据来源 + 抓取时间 + 置信度”塞进每个事件的 `DESCRIPTION` 和前端 tooltip，别藏起来。

**第二风险是“推送把自己做成垃圾源”。** 活动结束前 24h/4h/30m 三连发，加上维护延期、复刻追加，很容易一天十几条。用 GanttKnights 的预设思路：默认只发“最后一天一次 + 结束前 30 分钟一次”，把 24h 做成 opt-in；事件结束时间变更时补一条 `[已更新]` 并取消旧告警。

**上线决策**：

- **只服务自己或几个 QQ 群**：直接装熵增 `endfield-plugin`，半天跑通；同时把 core 的 ICS 挂个人日历做交叉校验。
- **要做公开订阅地址 / 多平台 / 可替换前端**：走图 2 第一条路线，core + Cloudflare Worker + `ical-generator`，QQ 用 webhook 反查 OneBot，不把机器人框架写进数据层。
- **要最漂亮的日历页**：fork `game-schedule` 的 `EventCalendar`，事件源换成 core；别把它的天级 Wiki 抓取当生产推送源。
- **暂时不要做的**：自己写一套公告 HTML 解析、用 GPT 直接写正式 ICS、把 `cep` 整个后端搬过来只为要倒计时。

## 引用来源

[1] https://github.com/EastMG/gacha-calendar-extension
> “28 款二次元手游的当期卡池与活动起止一览……米哈游……库洛（鸣潮）……鹰角（明日方舟 / 终末地）……抓取逻辑来自独立包 gacha-calendar-core，与 DSH 桌面端插件共用同一份核心。”（页面检索结果，2026-10-16 提交记录可见）

> “当前内联的核心版本：gacha-calendar-core@0.12.0……升级核心只需改 package.json 的依赖版本并重新 node build.mjs。”

[2] https://www.npmjs.com/package/dsh-gacha-calendar
> “二游活动/卡池排期速查……支持联网自动刷新与刷新频率设置（原神/星铁/绝区零/鸣潮/明日方舟/终末地/蔚蓝档案……）……License: MIT……Last Publish Sep 21, 2026。”

[3] https://github.com/Entropy-Increase-Team/endfield-plugin
> “Endfield-plugin 是一个为 Yunzai-Bot 开发的终末地游戏插件……日历 活动日历……订阅公告 / 取消订阅公告……开源协议 本项目采用 GNU Affero General Public License v3.0 开源协议。”

[4] https://github.com/Entropy-Increase-Team （组织 README 镜像页）
> “明日方舟:终末地 · Endfield 方向：Yunzai endfield-plugin / Astrbot astrbot_plugin_endfield / NoneBot2 nonebot-plugin-endfield……项目多数以 GNU AGPLv3 开源。”

[5] https://pypi.org/project/nonebot-plugin-endfield/0.2.4/
> “nonebot-plugin-endfield 是一个基于 NoneBot2 的《明日方舟:终末地》插件，支持扫码绑定、账号切换、信息卡、森空岛签到、公告获取与抽卡记录分析……License Expression: MIT……Requires: Python >=3.9。”

[6] https://github.com/jacket-sikaha/game-schedule （DeepWiki 代码索引，基于仓库 README）
> “The backend acts as a proxy and normalization layer… fetching raw data from sources like Gamekee or official JSON endpoints and converting them into a standardized CalendarActivity format… utilizing Redis… to store parsed results for 300 seconds.”

[7] https://github.com/jacket-sikaha/game-schedule （仓库早期 README 快照）
> “通过调用手游官网和 Wiki 的 API，实时获取各大手游活动信息并整理到日历中……目前已接入游戏：PCR 原神 星穹铁道 FGO 明日方舟……鸣潮，战双帕弥什……精确度目前暂时精确到天。”

[8] https://github.com/cmyyx/cep
> “Cep Endfield Planner，终末地规划器……支持基质规划，角色攻略，精锻规划，卡池日历……框架 Next.js 16 (App Router)……构建产物为纯静态文件(output: 'export')。”

[9] https://github.com/MoguJunn/endfield-gacha
> “规划与浏览日程：使用抽卡模拟器，查看当前寻访、版本倒计时和官方版本导览；独立日历展示活动与卡池时间。v4.6.4 已于 2026-10-09 发布……本仓库包含主站、API、数据库 schema、官方 BOT 与验证脚本……License: MIT License。”

[10] https://github.com/Zrief/GanttKnights
> “提醒预设：内置『只提醒最后一天』『开启前一天也提醒』几套常用配法……代码 MIT, Copyright (c) 2026 Zrief……活动时间改为以活动公告为准，wiki 数据页只当目录用。”（更新日志：0.1.5 / 2026-09-24，0.1.3 / 2026-09-18）

[11] https://github.com/Astrian/ArkBulletinGPT
> “ArkBulletinGPT 利用 GPT 总结《明日方舟》国服相关公告、读取《明日方舟》国服活动日程表。活动公告利用 Telegram 发布……订阅地址……就可以订阅《明日方舟》国服活动日程表。大部分情况下，日程表由 GPT-4 生成。”（最后可见提交 2026-05-22）

[12] https://snyk.io/advisor/npm-package/koishi-plugin-endfield
> “Latest version: 1.20.1… Last updated: 9 days ago… License: AGPL-3.0… Maintenance: Sustainable… Dependencies: @pynickle/koishi-plugin-adapter-onebot, axios, dayjs, koishi-plugin-cron, koishi-plugin-puppeteer.”

[13] https://github.com/nrouanet/eventsbot （Docker Hub / 仓库 README 索引）
> “This bot imports automatically events from an iCal calendar into Discord and, optionally, sends a message to inform the server's users about the event… Run the bot with Docker… License MIT license.”

[14] https://github.com/sebbo2002/ical-generator
> “ical-generator is a small piece of code which generates ical calendar files… Latest commit… Oct 13, 2026… MIT license.”（示例：`calendar.createEvent({ start, end, summary, description, url })`）

[15] https://github.com/gxy12345/arknights-plugin
> “arknights-plugin 基于森空岛API开发的Yunzai Bot明日方舟插件……License: MIT…优化命令,日志,帮助 Mar 1, 2026。”

[16] https://endfield.wiki.gg/wiki/Event
> “[Carly's Verdant Anthology] Camera Event — Asia: 2026/10/22 04:00 – 2026/11/04 20:00 (UTC+8); Americas / Europe: 2026/10/22 12:00 – 2026/11/05 04:00 (UTC-5)。”（检索日 2026-10-24，证明终末地活动必须按服区保留双时间字段）

[候选评分原始表](/data/workspace/dr:github游戏活动日历项目调研/data_候选评分.csv)
