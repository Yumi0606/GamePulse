# apps/web/CLAUDE.md — 新前端（React）

职责：数据验收四页（列表 / 日历 / 周视图 / 源健康），路由前缀 `/app/*`，只通过 `/api/v1` 取数。

## 结构

```
src/
  main.tsx       入口：QueryClientProvider + BrowserRouter(basename="/app")
  App.tsx        路由表
  index.css      Tailwind v4 入口与 @theme 语义色令牌
  components/    Layout / EntryCard / PostCard / OcrPanel / ui（徽标、分页、占位）
  pages/         ListPage / CalendarPage / WeekPage / HealthPage（week.css 只服务甘特图）
  lib/           api（/api/v1 客户端）format（北京时间展示）game-theme（配色）hooks（游戏清单）
```

## 硬约束

- 不引组件库；样式用 Tailwind 工具类，token 写在 `index.css` 的 `@theme`，没有 `tailwind.config.js`。
- 游戏清单只从 `/api/v1/games` 取；条目状态直接用响应里的 `status`，前端不复算。
- 时间展示走共享包 `fmtCst` / 本地 `fmtDate`，固定 `Asia/Shanghai`；禁止 `toISOString()`。
- 筛选、分页、月份等状态以 URL query 为唯一真源；localStorage 不存业务状态。
- 时间粒度：`startTimeKnown/endTimeKnown === false` 时只显示日期。
- 日历/周视图一次拉全量（`limit=1000`）在前端切分；条目量级到千级以上再改为区间查询。
- 深链定位条目用 `/app?entry=<id>`，列表页据此按 `id` 过滤并忽略状态筛选。

## 单端口开发形态

- `pnpm dev`：Fastify 以 `--web-dev --view-only` 启动，Vite middlewareMode 挂 `/app`，3000 同时提供 `/api`。
- 不使用独立 dev server 端口；Vite 依赖声明在本包，服务端通过 `createRequire` 从 `apps/web` 解析。
- 生产：`pnpm build` 产出 `dist`，由 nginx 在 `/app` 托管（`base` 固定 `/app/`），`/api` 反代到 Fastify。

## 验证

- 类型与构建：`pnpm --filter @gamepulse/web build`。
- 目检统一用 3000 共用实例；改动后先刷新页面，前端热更新即可生效（服务端 tsx 无热重载）。
