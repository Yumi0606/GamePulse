# src/storage/CLAUDE.md — SQLite 存储

单文件 `data/feed.db`，WAL 模式，使用内置 `node:sqlite` 的 `DatabaseSync`。表结构与字段注释集中在 `store.ts`。

## 表与幂等语义

| 表 | 主键 | 语义 |
|---|---|---|
| `posts` | `{gameId}:{type}:{bilibili动态id}` | 内容不变不刷 `updated_at`；`extracted_at` 非空 = 已结构化；`entry_count` 为最近一次成功提取的条目数（0=无排期，NULL=从未成功提取）；`extract_attempts` 达上限后放弃 |
| `ocr_records` | 规范化图片 URL | 无记录 → `failed`（attempts 未达上限可重试）→ `ok`（终态）；键必须经 `normalizeImageUrl`（B站图床 i0~i9 统一为 i0） |
| `entries` | `{gameId}:{type}:{id 段}` | 按 post **整体替换**；新条目 id 由 `hash36(normalizeCanonicalName)` 派生，历史条目保留旧 id |
| `meta` | 单行 | 最近一次同步结果（页面状态行） |
| `events` | 自增 | 源拉取异常与恢复记录 |
| `maintenance_windows` | `{gameId}:{维护开始 Unix 秒}` | 从停机维护公告抽取的维护窗口；同窗口多条公告按 `announced_at` 取最新结束时刻与来源 |

- 表结构变更走 `ensureColumn` 幂等迁移（启动时检测补列），不要删旧表。
- 旧表 `items_v1` 是 v1 留档，勿删勿写。

## 条目身份与合并

- `canonicalName` 是跨动态合并键，归一化只去空白与统一标点（`normalizeCanonicalName`），展示仍用原值；活动身份判定用 `eventKey`（再剥离首尾模板词，完全相等才合并）。
- `updateEntrySchedule` 只更新时间字段与 payload，供维护窗口/语义锚定回填，不改标题与来源列。
- `replaceEntriesForPost` 三步：
  1. 从所有条目的 `payload.extra.postIds` 移除当前 post（旧条目没有 `postIds` 时退回 `post_id` 列判断），变空则删除该条目；
  2. 逐条按 id 合并或插入，`postIds` 记为多来源，主来源 `postId` 取最早发布的动态；
  3. 规范化规范名撞车时收敛为一行，并合并各行的来源列表。
- 字段合并：时间以本次重跑为准（`b ?? a`，避免历史错误值因 confidence 壁垒无法修正）；`confidence` 取本次值不累积 max；文本取发布时间最新；`category`/`tags` 取并集；`canonicalName` 现有值优先、为空时补齐。
- 开始时间精度保护：本次结果只有纯日期/相对表述引用（`rough`）时，不覆盖已有的明确绝对值或锚定值（`exact`）；`confidence` 不参与该判定。

## 依赖规则

- `storage/` 不得依赖 `processing/`；共用的 URL 归一化在 `core/imageUrl.ts`。
- 新增查询优先复用已有导出，不要在其他模块直接持有 `DatabaseSync`（探针脚本除外）。

## 验证

- 库状态：`node _research/llm_probe/db_entries.mjs --game <gameId>`；重复检查：`node _research/llm_probe/db_dup.mjs <gameId>`。
- 改存储语义前先导出快照；`data/feed.db` 不入库，误操作无法从 git 恢复。
