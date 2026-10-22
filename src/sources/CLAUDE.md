# src/sources/CLAUDE.md — 源接入

职责：逐游戏拉取社媒动态、去重、记录源健康事件。产物是 `Item[]`，不写业务表逻辑（入库在 scheduler/store）。

## 结构

- `adapters/rsshubBilibili.ts`：当前唯一适配器，走自建 RSSHub 的 B站动态路由。
- `pipeline.ts`：`runPipeline()` 逐游戏并发拉取 → 汇总 → `dedup()`；单游戏失败不阻断其他游戏，失败写 `events` 表（kind 分类 + cookie 失效特征打标），后续成功且有数据时自动标记恢复。
- `dedup.ts`：首选系统 id（`{gameId}:{type}:{源内id}`）去重，兜底指纹 `{gameId}|{去空白标题}|{publishedAt}`；命中时保留字段更完整的一条。

## 接入新源 / 新游戏

- 新源：在 `adapters/` 实现 `SourceAdapter`，在 `pipeline.ts` 登记；不要绕过适配器直接抓取。
- 新游戏：只需在 `src/core/games.ts` 加一行（配置 id、名称、源参数、启用状态）。
- 不做 B站 API 直连抓取：风控成本高。

## 已知限制（不要当 bug 修）

- RSSHub B站动态路由**无分页**：`offset` 被忽略，加大 `limit` 无效，单源窗口固定 12 条（已实测）。历史回溯需要 B站 API 游标直连，属于 Roadmap。
- 该路由有 5 分钟缓存，同参数连续请求返回同一份缓存；验证抓取逻辑时注意这一点。
- 拉取成功但 0 条会记 `empty` 事件：官号确实无动态与源异常无法区分，不要当作正常静默。

## 排障

- 每款游戏有独立的进入/完成/失败日志（含 `costMs`）；`LOG_LEVEL=debug` 看 HTTP 进出。
- 错误文本命中 `-101|账号未登录|sessdata|cookie` 会打 cookie 嫌疑标记，优先检查 RSSHub 的 B站 cookie 配置。
