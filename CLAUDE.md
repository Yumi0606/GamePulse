# CLAUDE.md — AI 编码代理协作指南

本文件供 AI 编码代理（Claude Code 等）在本仓库工作前阅读。目标是让代理不做错方向的事、不踩已踩过的坑、用项目既定方法验证。

## 项目定位（先读这段，避免做错方向）

- 本仓库是**数据源整合管道**：多平台社媒源 → 归一化 → OCR → LLM 结构化 → SQLite + RSS 产物。
- 监控/看板应用规划为**独立仓库**，不要在本仓库实现前端监控层；现有 `src/web` 仅是数据验收用的最小展示页（列表 + 日历），保持极简。
- 不做 B站 API 直连抓取（风控成本高），源接入统一走适配器模式（当前：自建 RSSHub）。
- 用户是程序员，中文交流；回答平实准确，技术术语首次出现给英文原文。

## 技术栈硬事实

- Node.js ≥ 22，使用内置 `node:sqlite`（`DatabaseSync`）——**实验特性，启动时有 ExperimentalWarning 属正常**，不要因此引入第三方 ORM/驱动。
- TypeScript 严格模式，ESM：**本地 import 必须带 `.js` 后缀**（`import { x } from './store.js'`）。
- 包管理器 pnpm；依赖极简（fast-xml-parser、pino），**新增依赖前先确认无标准库方案**。
- 终端是 PowerShell，不要用 Linux 命令；控制台中文乱码时先设 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。
- 时间一律 Unix 秒存储；游戏服务器时间 = 北京时间，展示固定 `Asia/Shanghai` 时区（用 `fmtCst`，**禁止 `toISOString()` 直接展示**，它是 UTC）。

## 目录结构与依赖规则

```
src/
  core/         types.ts games.ts env.ts logger.ts imageUrl.ts   # 模型与基础设施
  sources/      adapters/ pipeline.ts dedup.ts                    # 源接入与拉取
  processing/   ocr.ts enrich.ts llm.ts extract.ts                # OCR 与 LLM 处理链
  storage/      store.ts                                          # SQLite 三表
  web/          server.ts page.ts rss.ts                          # 路由 / 页面渲染 / RSS 生成
  scheduler.ts  顶层编排：runPipeline → enrichOcr → extractEntries
  index.ts      CLI 手动同步（唯一允许 console.log 的地方）
```

依赖方向（单向，禁止反向）：

```
core ← sources / processing / storage / web ← scheduler ← web/server 入口
```

- `core/` 不依赖任何其他目录。
- `storage/` 不得依赖 `processing/`（曾因 store 依赖 ocr 的 normalizeImageUrl 形成坏依赖，已抽到 `core/imageUrl.ts`）。
- 新增外部数据源：在 `sources/adapters/` 实现 `SourceAdapter`（见 rsshubBilibili.ts），在 pipeline 登记；新游戏在 `core/games.ts` 加一行。

## 数据模型与幂等语义（改存储代码前必读）

SQLite 单文件 `data/feed.db`（WAL 模式），表结构定义与字段注释集中在 `src/storage/store.ts`：

| 表 | 主键 | 幂等语义 |
|---|---|---|
| `posts` | `{gameId}:{type}:{bilibili动态id}` | 内容不变不刷 `updated_at`；`extracted_at` 非空 = 已结构化；失败计数 `extract_attempts` 达 `EXTRACT_MAX_ATTEMPTS` 后放弃 |
| `ocr_records` | 规范化图片 URL | 状态机：无记录 → `failed`（attempts<上限可重试）→ `ok`（终态）；键必须经 `normalizeImageUrl`（B站图床 i0~i9 镜像统一为 i0） |
| `entries` | `{gameId}:{type}:{slug}:{短哈希}` | 按 post **整体替换**（事务全删全插）；同 post 多条同类条目靠标题短哈希防撞键 |
| `meta` | 单行 | 最近一次同步结果（供页面状态行） |

- 表结构变更走 `ensureColumn` 幂等迁移（启动时检测补列），不要删旧表。
- 旧表 `items_v1` 是 v1 留档，勿删勿写。

## LLM 结构化约定（改 extract.ts 前必读）

- Prompt 原则**宁缺毋滥**：拿不准的时间不编造；有把握的写 `startAt/endAt`，可从活动起止推算的偏移表述（"开启后第8天"）推算后标 `estimated: true`，完全无法定位的写 `TimeRef { refText, state: 'unanchored' }` 留给回填扫描。
- 每条条目必须有 `confidence` 与 `provenance`（fields + evidence 原文引用）。
- 字段定义以 `调研报告-活动数据结构.md` 为权威，`src/core/types.ts` 是其 TypeScript 落地；两者不一致时先对齐再改代码。
- 上下文里的日期以北京时间喂给 LLM（模型默认按 UTC 推算会偏 8 小时）。

## 日志约定

- 服务代码一律 `moduleLogger('<module>')`（pino），每个阶段：进入打一条 info（含关键参数），完成/失败打带 `costMs` 的日志——**进程卡住时最后一条日志即卡点位置**，这是本项目排障约定。
- 禁止在服务代码用 `console.log`（`src/index.ts` CLI 报告输出除外）。
- `LOG_LEVEL=debug` 看每次 HTTP 进出；`LOG_PRETTY=0` 出 JSON 行。

## 环境变量与真实踩坑

- 配置从 `.env` 读（模板 `.env.example`），`.env` 不入库。
- **坑：进程环境变量优先于 .env 文件**（`process.loadEnvFile()` 不覆盖已存在变量）。PowerShell 终端有状态，跨命令残留的 `$env:LLM_BASE_URL` 等 mock/旧值会让服务静默读到错误配置（曾致 7 条动态结构化全失败）。启动服务前确认终端干净，或显式 `Remove-Item Env:LLM_*`。
- 排查配置问题先看启动日志：`LLM 结构化开始 model=... @ ...` 会打印实际生效的端点与模型（key 脱敏）。

## 测试与验证方法（快速迭代，不要全量盲跑）

验证顺序：`pnpm build`（tsc 是第一道兜底）→ 单条探针 dry-run → 需要时 `--save` 落库 → `pnpm web` 目检。

探针脚本（`_research/`，独立于 src，直连 `dist/`）：

```powershell
# LLM 单条转换测试（dry-run：不写库不消耗幂等状态，可反复跑）
node _research/llm_probe/test_one.mjs --post delta-force:NEWS:<动态id>
node _research/llm_probe/test_one.mjs --game endfield --title 部分标题关键词
node _research/llm_probe/test_one.mjs --post <id> --save     # 确认效果后落库

# 注入 RSS 12 条窗口之外的历史动态（模拟该游戏官号新动态入库+OCR）
node _research/llm_probe/inject_opus.mjs

# OCR 状态机三场景验证 / 数据库快速检查
node _research/ocr_probe/test_retry.mjs run
node _research/llm_probe/check_entries.mjs
```

- 测试转换效果用 `test_one.mjs`，**不要为了测试去全量跑 63 条**（烧 LLM 配额）。
- 数据库快速查看：`node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/feed.db');/*...*/"`，或用任何 SQLite 工具打开 `data/feed.db`。
- Web 改动验证：`PORT=3100 node dist/web/server.js` 起测试实例（3000 可能被用户实例占用），页面用浏览器 DOM snapshot 验证内容。

## 已知限制（不要当 bug 修）

- RSSHub B站动态路由**无分页**：`offset` 被忽略、`limit` 加大无效，单源窗口固定 12 条（已实测）。历史回溯需 B站 API 游标直连（Roadmap）。
- RSSHub 该路由有 5 分钟缓存，同参数连续请求返回同一份缓存。
- 长图 OCR 多活动卡片的时间块与标题可能错位——由 `confidence` 降级表达不确定性，属于 LLM 固有波动，勿试图在代码里硬编码修复。

## 修改守则

- 注释用中文，保留原有注释；模块头部注释说明职责与数据流向。
- 公共导出（函数/类型）写文档注释。
- 每完成一个可验证的改动立即 build + 探针验证，不要攒大批量。
- 提交由用户决定，代理不主动 `git commit`。
