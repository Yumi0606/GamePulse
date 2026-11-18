# apps/server/src/web/CLAUDE.md — HTTP 入口与 RSS 产物

职责：Fastify 启动、`/api/v1` 挂载、开发形态的 Vite 中间件、RSS 输出。旧版 HTML 展示层已删除，页面全部由 `apps/web` 在根路径提供。

## 结构

- `server.ts`：Fastify 入口；`/api/v1` 挂 `src/api`，`/rss/*` 交给 `rss.ts`；开发形态（`--web-dev`）额外挂载 `dev.ts`。`--view-only` 跳过 `startScheduler()`，不触发拉取/OCR/LLM。
- `dev.ts`：开发形态把 Vite 以 middlewareMode 挂到根路径（Vite 从 `apps/web` 解析），与 `/api`、`/rss` 共用 3000 端口。
- `rss.ts`：RSS 文档生成与 `/rss/*` 请求处理。

生产形态下 Fastify 不提供页面：nginx 在根路径托管 `apps/web/dist`，并把 `/api` 与 `/rss` 反代到本进程。

## 端口与实例管理

- 验证改动**统一使用用户共用的 3000 端口**，不要另起 3100 之类的测试端口——用户看到的就是这个实例。
- 3000 被占用且代理无权关闭时，请求用户关闭；随后由代理启动实例并持续管理，与用户共用同一个端口。
- 正常情况下代码更新后**不需要重启**，先刷新页面验证；只有新增文件等导致热重载失效时才重启。
- 只读查看用 `pnpm viewonly`（不消耗 OCR/LLM）；需要完整链路时才用 `pnpm web`。

## 约束

- RSS 的输出形态（含 `gp:` 扩展命名空间、URL 路径 `/rss/*`）是外部契约，不得改变，只允许修 bug。
- 时间展示固定 `Asia/Shanghai`，用 `fmtCst`；禁止直接展示 `toISOString()`。
- 展示层可以追溯到多条来源动态（`payload.extra.postIds`），但 `postId` 保持最早的动态。
- 改动后用浏览器 DOM snapshot 核对内容，不只靠类型检查。
