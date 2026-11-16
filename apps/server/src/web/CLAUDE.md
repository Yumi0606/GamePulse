# apps/server/src/web/CLAUDE.md — 旧展示层（重构中）

职责：数据验收用的列表页 + 日历视图 + RSS 输出。

**本目录是旧展示层，正在拆除**：四个页面迁移到 `apps/web`（React + Tailwind），路由迁入 `apps/server/src/api`（`/api/v1`）。迁移完成前两套共存；完成后本目录只保留 `rss.ts`，`page.ts` / `week.ts` / `assets/` / `legacy.ts` 中的页面路由删除。**不要再在此目录新增页面级功能**，新功能写在新前端。

## 结构

- `server.ts`：Fastify 入口；`/api/v1` 挂 `src/api`，其余 GET 交给 `legacy.ts`；`--view-only` 跳过 `startScheduler()`，不触发拉取/OCR/LLM；`--web-dev` 额外挂载 `dev.ts`。
- `dev.ts`：开发形态把 Vite 以 middlewareMode 挂到 `/app`（Vite 从 `apps/web` 解析），与旧页、`/api` 共用 3000 端口。
- `legacy.ts`：旧页面、RSS、静态资源的原生响应处理。
- `page.ts`：列表与日历页面渲染。
- `rss.ts`：RSS 产物。
- `week.ts` / `assets/week.js`：周视图（无限横轴）。

## 端口与实例管理

- 验证改动**统一使用用户共用的 3000 端口**，不要另起 3100 之类的测试端口——用户看到的就是这个实例。
- 3000 被占用且代理无权关闭时，请求用户关闭；随后由代理启动实例并持续管理，与用户共用同一个端口。
- 正常情况下代码更新后**不需要重启**，先刷新页面验证；只有新增文件等导致热重载失效时才重启。
- 只读查看用 `pnpm viewonly`（不消耗 OCR/LLM）；需要完整链路时才用 `pnpm web`。

## 约束

- RSS 的输出形态（含 `gp:` 扩展命名空间、URL 路径 `/rss/*`）是外部契约，重构不得改变，只允许修 bug。
- 时间展示固定 `Asia/Shanghai`，用 `fmtCst`；禁止直接展示 `toISOString()`。
- 展示层可以追溯到多条来源动态（`payload.extra.postIds`），但 `postId` 保持最早的动态。
- 改动后用浏览器 DOM snapshot 核对内容，不只靠类型检查。
