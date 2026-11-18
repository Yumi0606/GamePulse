# apps/web/CLAUDE.md — 新前端（React）

职责：用户页（即将到期 / 全部活动 / 日历 / 周视图）+ 运维页（原始动态 / 源健康），路由前缀 `/app/*`，只通过 `/api/v1` 取数。

## 结构

```
src/
  main.tsx       入口：QueryClientProvider + BrowserRouter(basename="/app")
  App.tsx        路由表
  index.css      Tailwind v4 入口与 @theme 语义色令牌
  components/    Layout / EntryCard / PostCard / OcrPanel / Filters / ui（按钮档位、徽标、分页、占位）
  pages/         HomePage / ListPage / PostsPage / CalendarPage / WeekPage / HealthPage（week.css 只服务甘特图）
  lib/           api（/api/v1 客户端）format（北京时间展示与倒计时）game-theme（配色）hooks（游戏清单）
```

## 路由与信息层级

| 路径 | 页面 | 定位 |
|---|---|---|
| `/app` | HomePage | 即将到期：按今天 / 3 天内 / 7 天内 / 14 天内 / 更晚 / 未定分组 |
| `/app/all` | ListPage | 全部活动（筛选 + 分页归档） |
| `/app/calendar` | CalendarPage | 月历 |
| `/app/week` | WeekPage | 甘特周视图 |
| `/app/posts` | PostsPage | 原始动态（数据核验，页脚入口） |
| `/app/health` | HealthPage | 源健康（运维，页脚入口） |

- 管道健康度只出现在 `/app/health`；首页仅在存在未恢复异常时显示一行可点击提示。
- 导航透传 `gameId` / `type` / `q`，四个用户页的筛选语义保持一致。

## 硬约束

- 不引组件库；样式用 Tailwind 工具类，token 写在 `index.css` 的 `@theme`，没有 `tailwind.config.js`。
- 游戏清单只从 `/api/v1/games` 取；条目状态直接用响应里的 `status`，前端不复算。
- 时间展示走共享包 `fmtCst` / 本地 `fmtDate`，固定 `Asia/Shanghai`；禁止 `toISOString()`。
- 筛选、分页、月份等状态以 URL query 为唯一真源；localStorage 不存业务状态。
- 筛选区统一用 `components/Filters` 的 `FilterPanel` + `FilterGrid` + `FilterField`：主筛选常驻，次级筛选在窄屏收进「更多筛选」；字段标签在上、控件占满列宽，不回到 flex-wrap 平铺。
- 时间粒度：`startTimeKnown/endTimeKnown === false` 时只显示日期。
- 日历按月、周视图按可见时间窗口向 `/api/v1/entries` 传 `from` / `to` 取数，不再拉全量；无开始时间的条目用 `status=unknown` 单独查一次。
- 深链定位条目用 `/app/all?entry=<id>`，列表页据此按 `id` 过滤并忽略状态筛选；旧链接 `/app?entry=` 自动重定向。

## 单端口开发形态

- `pnpm dev`：Fastify 以 `--web-dev --view-only` 启动，Vite middlewareMode 挂 `/app`，3000 同时提供 `/api`。
- 不使用独立 dev server 端口；Vite 依赖声明在本包，服务端通过 `createRequire` 从 `apps/web` 解析。
- 生产：`pnpm build` 产出 `dist`，由 nginx 在 `/app` 托管（`base` 固定 `/app/`），`/api` 反代到 Fastify。

## 验证

- 类型与构建：`pnpm --filter @gamepulse/web build`。
- 目检统一用 3000 共用实例；改动后先刷新页面，前端热更新即可生效（服务端 tsx 无热重载）。
