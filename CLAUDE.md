# CLAUDE.md — AI 编码代理协作指南

本文件供 AI 编码代理在本仓库工作前阅读。只保留跨目录的核心事实；按目录的细节写在各目录的 `CLAUDE.md`，进入对应目录前必须读那一份。

## 项目定位

- 本仓库是**数据源整合管道**：多平台社媒源 → 归一化 → OCR → LLM 结构化 → SQLite + RSS 产物。
- 监控/看板应用规划为**独立仓库**，不要在本仓库实现前端监控层；`src/web` 仅是数据验收用的最小展示页。
- 不做 B站 API 直连抓取（风控成本高），源接入统一走适配器模式（当前：自建 RSSHub）。

## 技术栈硬事实

- Node.js ≥ 22，使用内置 `node:sqlite`（`DatabaseSync`）——实验特性，启动时的 ExperimentalWarning 属正常，不要引入第三方 ORM/驱动。
- TypeScript 严格模式，ESM：**本地 import 必须带 `.js` 后缀**（`import { x } from './store.js'`）。
- 包管理器 pnpm；依赖极简，新增依赖前先确认无标准库方案。
- 终端是 PowerShell，不要用 Linux 命令；中文乱码时先设 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。
- 时间一律 Unix 秒存储；展示固定 `Asia/Shanghai`（用 `fmtCst`），**禁止直接展示 `toISOString()`**（UTC）。

## 目录与依赖方向

```
src/
  core/         types.ts games.ts env.ts logger.ts imageUrl.ts
  sources/      adapters/ pipeline.ts dedup.ts
  processing/   ocr.ts enrich.ts llm.ts extract.ts recall.ts gameRules.ts
  storage/      store.ts
  web/          server.ts page.ts rss.ts week.ts
  scheduler.ts  顶层编排：runPipeline → enrichOcr → extractEntries
  index.ts      CLI 手动同步（唯一允许 console.log 的地方）
ocr-service/    RapidOCR 侧车（Python）
_research/      探针脚本（不入 src）
```

依赖方向单向：`core ← sources / processing / storage / web ← scheduler ← 入口`。

- `core/` 不依赖任何其他目录。
- `storage/` 不得依赖 `processing/`。
- 条目最终形态与合并语义见 [活动匹配原理.md](活动匹配原理.md)；需求与验收条目见 [待办.md](待办.md)。

## 按目录阅读

| 位置 | 内容 |
|---|---|
| [src/sources/CLAUDE.md](src/sources/CLAUDE.md) | RSSHub 适配器、抓取窗口、去重、接入新源 |
| [src/processing/CLAUDE.md](src/processing/CLAUDE.md) | OCR 客户端、LLM 结构化 Prompt 约定、召回、幂等与失败重试 |
| [src/storage/CLAUDE.md](src/storage/CLAUDE.md) | 三表结构、条目身份、跨动态合并、迁移 |
| [src/web/CLAUDE.md](src/web/CLAUDE.md) | 最小展示层、`--view-only`、端口与验证 |
| [ocr-service/CLAUDE.md](ocr-service/CLAUDE.md) | 侧车接口、长图切片与版面分块参数 |
| [_research/CLAUDE.md](_research/CLAUDE.md) | 探针脚本目录与使用约束 |

## 通用守则

- 服务代码一律 `moduleLogger('<module>')`（pino）；每个阶段进入/完成各打一条带关键参数的日志，完成日志带 `costMs`——**进程卡住时最后一条日志即卡点位置**。
- 禁止在服务代码用 `console.log`（`src/index.ts` CLI 报告输出除外）。
- 配置从 `.env` 读。**进程环境变量优先于 .env**：启动前确认终端没有残留的 `$env:LLM_*` / `$env:OCR_*`，或显式清除；排查配置先看启动日志里实际生效的端点与模型。
- **LLM 与 OCR 资源宝贵**：任何改动先做最小验证（离线探针优先，单条其次），证明改动确实有效；**未经用户验收不得进行全量重跑或重置**。
- 验证顺序：`pnpm build` → 单条探针 dry-run → 需要时 `--save` 落库 → 用户共用实例目检。脚本清单与约束见 `_research/CLAUDE.md`。
- 展示验证统一使用用户共用的 **3000 端口**，不要另起测试端口。端口被用户实例占用且无权关闭时，请求用户关闭；随后由代理启动并管理这一个实例，与用户共用。正常情况下代码更新后无需重启，先刷新页面；只有新增文件等导致热重载失效时才重启。
- 注释用中文，保留原有注释；模块头部说明职责与数据流向，公共导出写文档注释。
- 每完成一个可验证的改动立即 build + 探针验证，不要攒大批量。
- 提交由用户决定，代理不主动 `git commit`，但主动在多个任务后提醒提交。
