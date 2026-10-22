# \_research/CLAUDE.md — 探针脚本

`_research/` 独立于 `src/`，直接调用 `dist/` 或读 `data/feed.db`，只用于验证，不参与服务运行。

命名约定：`db_*` 离线查库（0 次外部调用），`probe_*` 离线验证模块逻辑，`run_*` 消耗 LLM，其余为辅助工具。

## 离线查询（0 次 LLM / OCR）

```powershell
# 动态：列表 / 关键词 / 单条详情
node _research/llm_probe/db_posts.mjs --game endfield --title 汉堡王 --limit 5
node _research/llm_probe/db_posts.mjs --id 1256071780002431033 --ocr --entries

# 条目：按游戏 / 关键词 / 类型 / id 查询，--source 展开来源动态与 OCR
node _research/llm_probe/db_entries.mjs --game endfield --kw 烟火生缘
node _research/llm_probe/db_entries.mjs --id endfield:ACTIVITY:1g7qiiu --source
node _research/llm_probe/db_entries.mjs --game endfield --type ANNOUNCEMENT --limit 20

# 重复检查：完全同名组、标题包含关系、来源分布（省略 gameId 则统计全部游戏）
node _research/llm_probe/db_dup.mjs endfield

# 召回诊断：某动态的候选排序，标注关键词是否命中（判断召回缺失 vs LLM 未匹配）
node _research/llm_probe/probe_recall.mjs 1258257057215152129 --keyword 祀的画 --top 10
```

## 在线（消耗 LLM）

```powershell
# 单条 / 少量动态结构化；默认 dry-run，--save 落库，--context 打印喂给 LLM 的完整上下文
node _research/llm_probe/run_one.mjs --post <postId> [--post <postId2>] [--context]
node _research/llm_probe/run_one.mjs --post <postId> --save
node _research/llm_probe/run_one.mjs --game endfield --title 关键词

# 批量重跑某游戏并导出前后快照；无 --yes 只打印影响范围不执行
node _research/llm_probe/run_game.mjs endfield [--limit 10] [--from 2026-10-01] [--out 目录] --yes
```

- `run_game.mjs` 快照与日志默认写到系统临时目录，不留在仓库内。

## OCR（消耗 OCR）

```powershell
# 侧车连通性 / 版面分块：按动态取图（--index 指定第几张）或直传 URL
node _research/ocr_probe/probe_http.mjs --post <postId> --index 1
node _research/ocr_probe/probe_http.mjs --url <图片URL>

# 单条动态逐图重跑生产 OCR；--dry 只识别不写库，--index 只跑第 N 张
node _research/ocr_probe/ocr_one_post.mjs <postId> [--index 2] [--dry]

# 失败重试状态机（会写入测试记录，跑完 cleanup）
node _research/ocr_probe/test_retry.mjs run
node _research/ocr_probe/test_retry.mjs cleanup

# 脱离侧车直接用本地 RapidOCR 识别单图（需 _research/ocr_probe/.venv）
python _research/ocr_probe/probe.py <图片路径>
```

## 约束

- **LLM 与 OCR 是宝贵资源**：任何开发都要用最小样本验证改动确实有效（离线优先、单条其次、批量最后）。
- **未经用户验收，禁止全量重跑或重置**；全量操作必须先说明影响范围并获得明确许可。
- **先离线后在线**：能用 `db_dup.mjs` / `probe_recall.mjs` / `db_entries.mjs` 回答的问题，不调用 LLM 或 OCR。
- 优先给现有脚本加参数，**不为一次验证新建脚本**；确需新建时带用法注释，验证完成后删除或并入现有脚本。
- 禁止在 `_research/` 下留数据库副本、日志、截图、审查快照；临时产物写到系统临时目录，用完删除。
- 脚本统一用 `node` 直跑（读 `dist/`），新增脚本不要再引入 tsx 依赖。
- 展示验证使用用户共用的 3000 端口，规则见 `src/web/CLAUDE.md`。

