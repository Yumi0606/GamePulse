# GamePulse

追游戏活动有多烦？五个官号要挨个盯着，活动公告全是长图，时间埋在图里、措辞五花八门——"活动期间"、"版本更新后"、"第8天"……一不小心就错过卡池和限时商店。

GamePulse 把这件事自动化：**拉取游戏官方 B站动态 → 图片 OCR 识读长图 → LLM 拆分出活动/卡池/商店/公告 → 存进 SQLite，输出 RSS 和日历**。你只需要订阅一个 RSS，或者打开日历页看排期。

> 仓库定位是**数据源整合**：以后会接入更多社媒平台和数据源，持续提高活动数据质量。监控看板等展示应用规划为独立仓库，通过 `data/feed.db` 或 RSS 端点消费这里的数据。

## 已支持的游戏

| 游戏 | B站官号 UID | gameId |
|---|---|---|
| 明日方舟 | 161775300 | `arknights` |
| 明日方舟：终末地 | 1265652806 | `endfield` |
| 三角洲行动 | 3494376565115651 | `delta-force` |
| 鸣潮 | 1955897084 | `wuthering-waves` |
| 碧蓝航线 | 233114659 | `azur-lane` |

新增游戏只需在 [src/core/games.ts](src/core/games.ts) 加一行；接入新的社媒平台则实现一个 `SourceAdapter`（见 `src/sources/adapters/`）。

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
RSS 订阅 / 列表页 / 日历页
```

定时调度默认**每天 00:00**（北京时间）跑一轮，也可以配成固定间隔。所有时间都按游戏服务器时间 = 北京时间处理，展示固定 `Asia/Shanghai` 时区，部署在哪都不怕时区漂移。

LLM 遵循"宁缺毋滥"：有把握的时间直接锚定；能推算的（"开启后第8天"）推算后标记预估；完全没把握的（"版本更新后"）只保留原文引用，等回填扫描锚定——绝不编造。

## 快速开始

依赖：Node.js ≥ 22（用内置 `node:sqlite`）、pnpm、Python 3.10+（OCR 侧车）、自建 RSSHub（B站路由需配置个人 Cookie）。

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
Copy-Item .env.example .env   # 编辑填入 LLM_API_KEY 等

# 3. 启动 OCR 侧车（Python，默认 127.0.0.1:8080）
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

**RSS 订阅**（原始动态与解析后条目分开）：

| 路径 | 内容 |
|---|---|
| `/rss/posts` | 原始动态聚合（追加 `/<gameId>` 订阅单游戏） |
| `/rss/entries` | 结构化条目：活动/卡池/公告排期（追加 `/<gameId>` 订阅单游戏） |

**直接查库**：`data/feed.db` 是标准 SQLite 文件（WAL 模式），任何 SQLite 工具都能打开。

## 配置

复制 `.env.example` 为 `.env`（已被 .gitignore 排除，禁止提交），常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RSSHUB_BASE` | `http://localhost:1200` | RSSHub 地址 |
| `OCR_BASE` | `http://localhost:8080` | RapidOCR 侧车地址 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | OpenAI 兼容端点（DeepSeek/GLM/Kimi/Ollama 通用）；不配则跳过结构化 |
| `LLM_BATCH_LIMIT` | 10 | 单次同步最多送 LLM 的动态数 |
| `OCR_MAX_ATTEMPTS` / `EXTRACT_MAX_ATTEMPTS` | 3 | OCR 单图 / LLM 单动态的最大重试次数 |
| `FETCH_INTERVAL_MINUTES` | 留空 | 留空=每天 00:00；填数字=固定间隔分钟 |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `1` | `debug` 看每次 HTTP；`LOG_PRETTY=0` 出 JSON 行 |

完整清单见 [.env.example](.env.example)。

## 目录结构

```
src/
  core/         模型与基础设施：types / games / env / logger / imageUrl
  sources/      源接入：adapters/ + pipeline（拉取）+ dedup（去重）
  processing/   处理链：ocr / enrich（OCR 批处理）/ llm / extract（LLM 结构化）
  storage/      store.ts：SQLite 三表（posts / ocr_records / entries）
  web/          server.ts（路由）+ page.ts（页面渲染）+ rss.ts（RSS 生成）
  scheduler.ts  定时编排
  index.ts      CLI 手动同步
ocr-service/    RapidOCR Python 侧车
_research/      调研探针脚本（单条 LLM dry-run、OCR 状态机测试、历史动态注入）
```

## 路线图

- [ ] 接入更多社媒平台与数据源（GameData 等结构化源）
- [ ] B站动态 API 游标直连：回溯历史动态（当前 RSS 窗口仅 12 条）
- [ ] 引用型时间回填扫描（"版本更新后"随版本公告锚定）
- [ ] 监控/看板独立仓库（消费 feed.db 或 RSS）

## 文档

- [prd.md](prd.md)：产品需求与验收标准
- [调研报告-活动数据结构.md](调研报告-活动数据结构.md)：Item/Entry 数据模型权威定义
- [调研报告-OCR选型.md](调研报告-OCR选型.md)：OCR 方案选型依据
- [CLAUDE.md](CLAUDE.md)：AI 编码代理协作指南（约定、测试方法、已知坑）
