# CLAUDE.md — AI 编码代理协作指南

本文件供 AI 编码代理在本仓库工作前阅读。只保留跨目录的核心事实；按目录的细节写在各目录的 `CLAUDE.md`，进入对应目录前必须读那一份。

## 项目定位

- 本仓库是**数据源整合管道**：多平台社媒源 → 归一化 → OCR → LLM 结构化 → SQLite + RSS 产物。
- **后端单实例 + 多形态前端**：数据验收前端在本仓库 `apps/web`（React）；监控看板、通知等应用作为同一 monorepo 内的独立 app，通过 `/api/v1` 或 RSS 消费数据，不得直连 `data/feed.db`。
- `/rss/*` 的 URL 形态与 `gp:` 扩展命名空间是已订阅用户的外部契约，重构不得改动。
- 不做 B站 API 直连抓取（风控成本高），源接入统一走适配器模式（当前：自建 RSSHub）。
- **前后端分离重构已完成**：`apps/web` 是唯一展示层，直接挂在根路径 `/`；`apps/server/src/web` 只保留 Fastify 入口、Vite 开发中间件与 RSS 产物。

## 技术栈硬事实

- Node.js ≥ 22，使用内置 `node:sqlite`（`DatabaseSync`）——实验特性，启动时的 ExperimentalWarning 属正常，不要引入第三方 ORM/驱动。
- TypeScript 严格模式，ESM：**本地 import 必须带 `.js` 后缀**（`import { x } from './store.js'`）。
- 包管理器 pnpm；依赖极简，新增依赖前先确认无标准库方案。
- 终端是 PowerShell，不要用 Linux 命令；中文乱码时先设 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。
- 时间一律 Unix 秒存储；展示固定 `Asia/Shanghai`（用 `fmtCst`），**禁止直接展示 `toISOString()`**（UTC）。
- 后端 HTTP 层：Fastify + `fastify-type-provider-zod`（Zod 同时承担校验、序列化白名单与 TS 类型），路由前缀 `/api/v1`，日志复用 pino。
- 前端：Vite + React + TypeScript + React Router + TanStack Query；样式 Tailwind CSS v4（`@tailwindcss/vite`，无 `tailwind.config.js`，token 写在 `@theme`）。
- 仓库为 pnpm workspace：`apps/server`（原 `src/` 已迁入）、`apps/web`（React 前端，根路径路由）、`packages/shared`（DTO、Zod schema、游戏与分类枚举、`fmtCst`）。

## 目录与依赖方向

```
apps/server/src/
  core/         types.ts games.ts env.ts logger.ts imageUrl.ts paths.ts
  sources/      adapters/ pipeline.ts dedup.ts
  processing/   ocr.ts enrich.ts llm.ts extract.ts recall.ts gameRules.ts maintenance.ts semanticAnchor.ts
  storage/      store.ts
  api/          /api/v1 路由（Fastify + Zod）：health / meta / games / entries / posts / posts/:id/ocr / events
  web/          server.ts（Fastify 入口）dev.ts（Vite 中间件）rss.ts（RSS 生成与请求处理）
  scheduler.ts  顶层编排：runPipeline → enrichOcr → extractEntries
  index.ts      CLI 手动同步（唯一允许 console.log 的地方）
apps/web/       React 前端（Vite + Tailwind），根路径路由：pages（首页/列表/日历/周视图/动态/健康）components lib
packages/shared/ DTO、Zod schema、游戏与分类枚举、fmtCst
ocr-service/    RapidOCR 侧车（Python）
_research/      探针脚本（不入 apps/server/src）
```

依赖方向单向：`core ← sources / processing / storage / web / api ← scheduler ← 入口`。

- `core/` 不依赖 server 包内其他目录。
- `storage/` 不得依赖 `processing/`。
- `packages/shared/` 不得依赖 `apps/*`；`apps/web` 不得 import `apps/server` 内部模块，只能通过 HTTP 与共享包交互。
- 业务判定（条目状态、时区格式化、游戏列表）只在服务端或共享包实现，前端不得复刻一份。
- 数据目录与日志目录经 `core/paths.ts` 按模块位置回溯到仓库根，不依赖进程工作目录（pnpm 脚本的 cwd 是包目录）。
- 项目业务规范见 [SPEC.md](SPEC.md)；需求与验收条目见 [TODO.md](TODO.md)。`docs/` 下的文档是历史调研与技术说明，不作为口径依据。

## 按目录阅读

| 位置 | 内容 |
|---|---|
| [SPEC.md](SPEC.md) | 唯一业务规范：术语、来源与条目、时间、生命周期、状态与展示口径、数据质量 |
| [apps/server/src/sources/CLAUDE.md](apps/server/src/sources/CLAUDE.md) | RSSHub 适配器、抓取窗口、去重、接入新源 |
| [apps/server/src/processing/CLAUDE.md](apps/server/src/processing/CLAUDE.md) | OCR 客户端、LLM 结构化 Prompt 约定、召回、幂等与失败重试 |
| [apps/server/src/storage/CLAUDE.md](apps/server/src/storage/CLAUDE.md) | 三表结构、条目身份、跨动态合并、迁移 |
| [apps/server/src/web/CLAUDE.md](apps/server/src/web/CLAUDE.md) | 旧展示层（重构中）：RSS 契约、`--view-only`、端口与验证 |
| [apps/web/CLAUDE.md](apps/web/CLAUDE.md) | 新前端：四页结构、URL 为筛选真源、单端口开发形态 |
| [ocr-service/CLAUDE.md](ocr-service/CLAUDE.md) | 侧车接口、长图切片与版面分块参数 |
| [_research/CLAUDE.md](_research/CLAUDE.md) | 探针脚本目录与使用约束 |

## 构建与运行

- `pnpm build`：按依赖顺序构建 `packages/shared`、`apps/server` 与 `apps/web`（`pnpm -r build`）。
- `pnpm web` / `pnpm viewonly` / `pnpm sync` 从仓库根启动；`apps/server` 的脚本在包目录启动同样可用（路径已锚定到仓库根）。
- `pnpm dev`：只读 + 前端开发形态，Vite 以 middlewareMode 挂进 Fastify，3000 同时提供 `/`（热更新）与 `/api/v1`。生产由 nginx 托管 `apps/web/dist` 到根路径并反代 `/api` 与 `/rss`，Fastify 不带 `--web-dev`。
- `packages/shared` 是构建产物依赖：改完共享包先 `pnpm build` 再启动，否则 tsx/vite 读到的仍是旧 dist。
- 前端构建产物路径由 `apps/web/vite.config.ts` 的 `base: '/'` 固定；nginx 根 location 必须与之一致。

## 通用守则

- 服务代码一律 `moduleLogger('<module>')`（pino）；每个阶段进入/完成各打一条带关键参数的日志，完成日志带 `costMs`——**进程卡住时最后一条日志即卡点位置**。
- 禁止在服务代码用 `console.log`（`apps/server/src/index.ts` CLI 报告输出除外）。
- 配置从 `.env` 读。**进程环境变量优先于 .env**：启动前确认终端没有残留的 `$env:LLM_*` / `$env:OCR_*`，或显式清除；排查配置先看启动日志里实际生效的端点与模型。
- **LLM 与 OCR 资源宝贵**：任何改动先做最小验证（离线探针优先，单条其次），证明改动确实有效；**未经用户验收不得进行全量重跑或重置**。
- 验证顺序：`pnpm build` → 单条探针 dry-run → 需要时 `--save` 落库 → 用户共用实例目检。脚本清单与约束见 `_research/CLAUDE.md`。
- 展示验证统一使用用户共用的 **3000 端口**，不要另起测试端口。端口被用户实例占用且无权关闭时，请求用户关闭；随后由代理启动并管理这一个实例，与用户共用。正常情况下代码更新后无需重启，先刷新页面；只有新增文件等导致热重载失效时才重启。
- 开发形态固定为**单端口**：Vite 以 `middlewareMode` 挂进 Fastify，3000 同时提供 `/` 与 `/api`。生产由 nginx 托管前端构建产物并反代 `/api` 与 `/rss`；不要为验证另起 5173 / 3100。
- 新页面只加在 `apps/web`（根路径路由）；前端筛选、分页、月份等状态以 URL query 为唯一真源，业务判定（状态、游戏清单、时间格式）只从共享包或 API 获取。
- 注释用中文，保留原有注释；模块头部说明职责与数据流向，公共导出写文档注释。
- 在长任务中，每完成一个可验证的改动立即 build + 探针验证，不要攒大批量。零碎简单的修改不要浪费时间多次build。
- 提交由用户决定，代理不主动 `git commit`，但主动在多个任务后提醒提交。
