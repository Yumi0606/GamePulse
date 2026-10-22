# src/web/CLAUDE.md — 最小展示层

职责：数据验收用的列表页 + 日历视图 + RSS 输出。**不是**监控/看板产品，保持极简，不要在 `src/web` 内扩展成前端应用。

## 结构

- `server.ts`：HTTP 入口与路由；`--view-only` 跳过 `startScheduler()`，不触发拉取/OCR/LLM。
- `page.ts`：列表与日历页面渲染。
- `rss.ts`：RSS 产物。
- `week.ts` / `assets/week.js`：周视图（无限横轴）。

## 端口与实例管理

- 验证改动**统一使用用户共用的 3000 端口**，不要另起 3100 之类的测试端口——用户看到的就是这个实例。
- 3000 被占用且代理无权关闭时，请求用户关闭；随后由代理启动实例并持续管理，与用户共用同一个端口。
- 正常情况下代码更新后**不需要重启**，先刷新页面验证；只有新增文件等导致热重载失效时才重启。
- 只读查看用 `pnpm viewonly`（不消耗 OCR/LLM）；需要完整链路时才用 `pnpm web`。

## 约束

- 时间展示固定 `Asia/Shanghai`，用 `fmtCst`；禁止直接展示 `toISOString()`。
- 展示层可以追溯到多条来源动态（`payload.extra.postIds`），但 `postId` 保持最早的动态。
- 改动后用浏览器 DOM snapshot 核对内容，不只靠类型检查。
