# GamePulse

一个基于社交媒体动态的游戏活动日历。追游戏活动有多烦？九款游戏的官号要挨个盯着，活动公告全是长图，时间埋在图里、措辞五花八门——"活动期间"、"版本更新后"、"第8天"……一不小心就错过卡池和限时商店。

GamePulse 把这件事自动化：**拉取游戏官方 B站动态 → 图片 OCR 识读长图 → LLM 拆分出活动/卡池/商店/公告 → 存进 SQLite，输出 RSS、日历与周视图**。你只需要订阅一个 RSS，或者打开日历页看排期。

> 仓库定位是**数据源整合**：以后会接入更多社媒平台和数据源，持续提高活动数据质量。监控看板等展示应用规划为独立仓库，通过 `data/feed.db` 或 RSS 端点消费这里的数据。

## 已支持的游戏

| 游戏 | B站官号 UID | gameId |
|---|---|---|
| 明日方舟 | 161775300 | `arknights` |
| 明日方舟：终末地 | 1265652806 | `endfield` |
| 三角洲行动 | 3494376565115651 | `delta-force` |
| 鸣潮 | 1955897084 | `wuthering-waves` |
| 碧蓝航线 | 233114659 | `azur-lane` |
| 蓝色星原：旅谣 | 3546569016085336 | `azur-promilia` |
| 原神 | 401742377 | `genshin` |
| 崩坏：星穹铁道 | 1340190821 | `honkai-star-rail` |
| 绝区零 | 1636034895 | `zenless-zone-zero` |

新增游戏只需在 [src/core/games.ts](src/core/games.ts) 加一行；若需要专属分类规则，再在 [src/processing/gameRules.ts](src/processing/gameRules.ts) 加一条（未登记的游戏走通用词表）。接入新的社媒平台则实现一个 `SourceAdapter`（见 `src/sources/adapters/`）。`GAMES` 的数组顺序即周视图分组顺序：同厂商相邻，米哈游三款置于末尾。

## 它是怎么工作的

```
RSSHub（每游戏约 12 条动态窗口）
   ↓  适配器归一化 + 去重
posts 表（原始动态）
   ↓  动态里的图片 → RapidOCR 侧车识读长图
ocr_records 表（按图片 URL 幂等，失败重试有上限）
   ↓  正文 + OCR 文本 + 日期上下文 → LLM（OpenAI 兼容协议）
entries 表（活动条目：起止时间、分段、卡池、奖励截止、置信度与原文溯源）
   ↓
RSS 订阅 / 列表页 / 日历页 / 周视图
```

定时调度分两条独立循环：拉取循环默认**每天 00:00**（北京时间），处理链（OCR + LLM）默认每 30 分钟清一次积压；两条循环都可以改成 cron 表达式或固定间隔。所有时间都按游戏服务器时间 = 北京时间处理，展示固定 `Asia/Shanghai` 时区，部署在哪都不怕时区漂移。

LLM 遵循"宁缺毋滥"：有把握的时间直接锚定；能推算的（"开启后第8天"）推算后标记预估；完全没把握的（"版本更新后"）只保留原文引用，等回填扫描锚定——绝不编造。维护窗口回填与语义锚定命中后，会覆盖原先的估算标记。

原文只给出日期、没给时刻时，存储仍按当日 00:00 补一个值用于排序，但同时写入 `startTimeKnown` / `endTimeKnown` = false；列表页、周视图与 RSS 据此只显示日期，不展示补出来的时分。

## 快速开始

依赖：Node.js ≥ 22（用内置 `node:sqlite`）、pnpm、Python 3.10+（OCR 侧车）、自建 RSSHub（B站路由需配置个人 Cookie）。

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
Copy-Item .env.example .env   # 编辑填入 LLM_API_KEY 等

# 3. 启动 OCR 侧车（Python，默认 127.0.0.1:1225）
pnpm ocr

# 4. 启动 RSSHub（Docker 或任意方式，默认 localhost:1200）

# 5. 构建并启动 Web 服务（自动触发首轮同步）
pnpm build
pnpm web
```

手动同步一轮（CLI 报告输出，不启动服务）：`pnpm sync`。

## 看数据的三种方式

**Web 页面**（默认 `http://localhost:3000`）：

| 路径 | 说明 |
|---|---|
| `/` | 列表视图：结构化条目（排期视角）+ 原始动态 |
| `/calendar?month=YYYY-MM` | 日历视图：活动开始/结束/奖励截止/进行中铺进当月 |
| `/week?from=YYYY-MM-DD` | 周视图：按游戏分组的甘特式横轴，支持折叠分组与小时/天/周/月精度切换 |
| `/health` | 源健康：拉取异常与自动恢复状态 |

**RSS 订阅**（原始动态与解析后条目分开）：

| 路径 | 内容 |
|---|---|
| `/rss/posts` | 原始动态聚合（追加 `/<gameId>` 订阅单游戏） |
| `/rss/entries` | 结构化条目：活动/卡池/公告排期（追加 `/<gameId>` 订阅单游戏） |
| `/rss/post?id=` / `/rss/entry?id=` | 单条原始动态 / 单条结构化条目 |

**直接查库**：`data/feed.db` 是标准 SQLite 文件（WAL 模式），任何 SQLite 工具都能打开。

## 配置

复制 `.env.example` 为 `.env`（已被 .gitignore 排除，禁止提交），常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RSSHUB_BASE` | `http://localhost:1200` | RSSHub 地址 |
| `OCR_SERVICE_URL` | `http://127.0.0.1:1225` | RapidOCR 侧车地址 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | OpenAI 兼容端点（DeepSeek/GLM/Kimi/Ollama 通用）；不配则跳过结构化 |
| `LLM_BATCH_LIMIT` / `OCR_BATCH_LIMIT` | 10 / 20 | 单轮最多送 LLM 的动态数 / 单轮最多识别的图片数 |
| `OCR_MAX_ATTEMPTS` / `EXTRACT_MAX_ATTEMPTS` | 3 | OCR 单图 / LLM 单动态的最大重试次数 |
| `FETCH_CRON` / `PROCESS_CRON` | 留空 | 拉取循环 / 处理链循环的 cron 表达式（5 字段，按北京时间解释） |
| `FETCH_INTERVAL_MINUTES` / `PROCESS_INTERVAL_MINUTES` | 留空 / 30 | 固定间隔分钟；拉取循环留空即每天 00:00 |
| `LOG_LEVEL` / `LOG_PRETTY` / `LOG_FILE` | `info` / `1` / `logs/app.log` | `debug` 看每次 HTTP；`LOG_PRETTY=0` 出 JSON 行；`LOG_FILE` 留空关闭落盘 |

完整清单见 [.env.example](.env.example)。

## 目录结构

```
src/
  core/         模型与基础设施：types / games / env / logger / imageUrl
  sources/      源接入：adapters/ + pipeline（拉取）+ dedup（去重）
  processing/   处理链：ocr / enrich（OCR 批处理）/ llm / extract（LLM 结构化）
                + recall（召回）/ gameRules（游戏词表）/ semanticAnchor（语义锚定）
                + maintenance（维护窗口回填）
  storage/      store.ts：SQLite 表（posts / ocr_records / entries / meta / events / maintenance_windows）
  web/          server.ts（路由）+ page.ts（列表与日历）+ week.ts（周视图）
                + rss.ts（RSS 生成）+ assets/（前端脚本与样式）
  scheduler.ts  定时编排：拉取 → OCR → 结构化 → 时间回填
  index.ts      CLI 手动同步
ocr-service/    RapidOCR Python 侧车
_research/      调研探针脚本（单条 LLM dry-run、OCR 状态机测试、历史动态注入）
```

## 路线图

- [ ] 接入更多社媒平台与数据源（GameData 等结构化源）
- [ ] B站动态 API 游标直连：按时间段回溯历史动态（当前 RSS 窗口仅 12 条）
- [x] 引用型时间回填扫描（"版本更新后"随版本公告锚定）：`maintenance.ts` 走固定模式，`semanticAnchor.ts` 处理其余引用
- [ ] 游戏登记与开关配置化：在统一位置增删游戏、启停抓取
- [ ] 任务队列控制（终止本次执行、顶置某游戏）与全链路状态监控页（当前仅源健康）
- [ ] 展示层重构为 React + Tailwind
- [ ] 监控/看板独立仓库（消费 feed.db 或 RSS）

## 文档

- [prd.md](prd.md)：产品需求与验收标准
- [调研报告-活动数据结构.md](调研报告-活动数据结构.md)：Item/Entry 数据模型权威定义
- [调研报告-OCR选型.md](调研报告-OCR选型.md)：OCR 方案选型依据
- [CLAUDE.md](CLAUDE.md)：AI 编码代理协作指南（约定、测试方法、已知坑）
