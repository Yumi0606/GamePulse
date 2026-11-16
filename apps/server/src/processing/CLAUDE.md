# src/processing/CLAUDE.md — OCR 与 LLM 处理链

职责：动态图片 OCR、文本增强、LLM 结构化、候选召回。由 `src/scheduler.ts` 按 `runPipeline → enrichOcr → extractEntries` 顺序调用。

## OCR 客户端（ocr.ts / enrich.ts）

- 侧车地址 `OCR_SERVICE_URL`（默认 `http://127.0.0.1:1225`），`POST /ocr {imageUrl}` → `{lines, slices}`；侧车细节见 `ocr-service/CLAUDE.md`。
- 噪声过滤（单字符行、纯数字行）在 Node 侧做，**保留空行**——空行是侧车按版面块插入的分隔符，LLM 靠它区分长图中的不同活动卡片。
- 错误分类决定是否消耗重试次数：`OcrInfraError`（不可达/超时/5xx）是临时故障，不烧 `ocr_records.attempts`；死图（侧车返回"图片下载失败"）烧次数，达上限后放弃。
- OCR 状态机与幂等键在存储层，见 `src/storage/CLAUDE.md`。

## LLM 结构化（extract.ts）

Prompt 原则**宁缺毋滥**：

- 拿不准的时间不编造；有把握的写 `startAt/endAt`；可由活动起止推算的偏移表述换算后标 `estimated: true`；完全无法定位的只留 `startRef/endRef`。
- 纯日期（"10月8日维护后"）按游戏缺省更新时刻补全（`DATE_DEFAULT_TIME`），同时保留原文并置 `estimated`；碧蓝航线的维护引用随后由维护窗口回填覆盖（见下）。
- 每条条目必须有 `confidence` 与 `provenance`（fields + evidence 原文引用）。
- 固定引流尾注（分隔线 + ▼ + 下载/图文地址）不得作为证据；主体与排期无关的动态输出空数组。
- ACTIVITY / COLLAB / GACHA 至少要有时间区间或可执行的玩法/奖励说明，两者皆无则不产出。
- `canonicalName` 只保留活动专名，禁止拼接版本名、大类前缀与宣传措辞；同名活动跨动态必须一致。
- 上下文日期以北京时间喂给 LLM（模型默认按 UTC 推算会偏 8 小时）。
- 字段定义以 `调研报告-活动数据结构.md` 为权威，`src/core/types.ts` 是其落地；不一致时先对齐再改代码。

幂等与兜底：

- post 内容未变（`updated_at` 未刷新）不重跑；重跑时按 post 整体替换 entries（合并语义在存储层）。
- 单条失败记 `extract_attempts`，达 `EXTRACT_MAX_ATTEMPTS` 后放弃；`LLM_RETRY_COOLDOWN` 内不重试。
- 连续基础设施失败达 `INFRA_BREAK_STREAK` 熔断本批剩余，避免服务不可用时刷失败计数。

## 召回（recall.ts）

- 触发：结构化前用动态正文 + OCR 文本召回本游戏历史条目，渲染为候选表供 LLM 填 `matchedEntryId`。
- 实现：jieba-node 自举词典 + 字段加权 BM25（canonicalName 3 / title 2 / summary 1 / tags 1），按 `type + eventKey` 归组，上限 100 组。
- 名称命中兜底：帖子文本字面包含某条目 eventKey 时强制进入候选池，不受 BM25 排名与组数上限影响。
- 候选组输出同组全部 id 与最早条目；LLM 命中组内任一 id 时统一归到最早条目。召回只读，0 次 LLM 调用。

## 维护窗口与引用型时间（maintenance.ts / semanticAnchor.ts）

- `maintenance.ts`：扫描全部已登记游戏的维护/版本更新公告（兼容 `10月22日10:00~16:00` 与 `2026/10/15 06:00 - 12:00`），抽取出维护窗口写入 `maintenance_windows`；再把条目的 `startRef/endRef` 按固定模式回填为绝对时间（"维护后/版本更新后"→窗口结束，"维护/版本更新维护前"→窗口开始）。纯代码，0 次 LLM 调用，幂等。
- 回填约束：无年份引用只能落在发布年或次年；锚点与发布时间的绝对差 ≤ 45 天；"下次维护"系列要求窗口不早于发布日。不满足则保持 `unanchored`，避免缺失旧公告时吸附到多年后的窗口。回填后若结束早于开始，撤销本次新增锚定。
- `semanticAnchor.ts`：固定模式覆盖不了的引用（如"3.7版本活动期间"）交给 LLM，仅送含维护语义（维护/更新/版本/停服/闪断）的引用，纯日期不送；模型只能从已有窗口中选择，返回结果同样经年份/距离与区间自洽校验，无法确定返回 null。结论写入 `TimeRef.semanticCheckedAt/semanticNote`，同一公告周期内不重复检查。
- 触发：`runProcessOnce` 开始时同步窗口并回填；本轮有新条目时结束时补一次回填。维护窗口公告晚于活动动态时，下一轮自动锚定。

## 验证

- 单条：`pnpm build` 后用 `_research/llm_probe/run_one.mjs --post <postId>` dry-run，确认后加 `--save`。
- 先离线探针验证，再单条在线验证，最后才考虑批量。**未经用户验收不得全量重跑或重置**；全量前先说明影响范围与预计调用次数。脚本清单见 `_research/CLAUDE.md`。
