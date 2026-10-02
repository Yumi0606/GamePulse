# OCR 接入选型报告（v1.5 结构化版）

> 版本：v0.1（2026-10-02）
> 目标：为 v1.5 结构化处理链选择 OCR 引擎——把 B站动态海报图/长图中的活动时间、卡池、公告正文识别为文本，供后续 LLM 解析。
> 需求约束（来自 PRD §3.3/§6）：中文海报与长图为主；调用量小（5 款游戏、每月新增图片几十张）；Node.js 主服务；未来部署 Linux 服务器；零成本优先、本地优先；OCR 产物需带证据可追溯。

---

## 1. 结论与推荐

**推荐：RapidOCR（Python 包 `rapidocr`）作为独立 OCR 微服务 + Node 侧 `OcrClient` 抽象层；腾讯云 OCR 作为云降级备选。**

- RapidOCR 已实测通过：真实三角洲更新公告长图（1080×2887），CPU 识别 2.1 秒，29 行文本质量足以支撑时间/数值提取；
- 它内置 PaddleOCR 官方 PP-OCRv6 模型（精度标杆），但免去 paddlepaddle 框架的安装重量——**接现成轮子，不自研**；
- 架构上以 HTTP 微服务隔离 Python 运行时，Node 主服务不引入 Python 依赖；未来云 OCR 可作为同接口的备选实现。

## 2. 候选全景（含被否路径，状态标记沿用数据源报告约定）

| 候选 | 状态 | 一句话结论 |
|------|------|-----------|
| RapidOCR（`rapidocr` 包） | ✅ 已实测通过 | 本地首选：PP-OCRv6 模型 + ONNX Runtime CPU，27MB，活跃维护 |
| 腾讯云 OCR | 🔍 未实测，备选 | 通用印刷体识别 1000 次/月免费（每月发放、当月有效）；零部署；超量后付费需关停护栏 |
| Umi-OCR | 🔍 未实测，开发期可选 | Windows 解压即用 + HTTP API（默认 1224 端口）；但 Linux 部署靠 Docker+Qt/Wine 路线偏重，官方注明并发支持较差 |
| PaddleOCR 官方 | ⬜ 不单独立项 | PP-OCRv6 是精度标杆，但 paddlepaddle 框架安装重；RapidOCR 已内置同源模型，收益重复 |
| 百度智能云 OCR | ⬜ 备选池 | 与腾讯云同类，未查证当前免费额度细节；腾讯云额度已够用 |
| Tesseract（tesseract.js） | ❌ 否决 | 中文识别质量明显弱于 Paddle 系，海报艺术字/长图排版效果差 |
| Node 原生 onnxruntime 自研 | ❌ 否决 | 需自研 DBNet 后处理与 CTC 解码，等于造轮子 |
| EasyOCR | ❌ 否决 | 模型大、中文效果不及 Paddle 系 |

关键事实依据（2026-10 检索）：
- `rapidocr_onnxruntime` 等旧包已停止维护，统一为 `rapidocr`（PyPI v3.9.2，2026-07-21 发布，支持 Python 3.8–3.13）；whl 约 27MB，内含 PP-OCRv6 检测/识别 small 模型，安装即用、无需联网下载模型；
- PP-OCRv6 为 PaddleOCR 最新一代（官方称 medium 档精度超 PP-OCRv5_server 5.1%）；
- 腾讯云 OCR 免费额度：通用印刷体识别 1000 次/月（免费资源包每月 1 号发放、当月有效）；注意"部分失败错误码也计费"。

## 3. 对比表

| 维度 | RapidOCR | 腾讯云 OCR | Umi-OCR |
|------|----------|-----------|---------|
| 中文海报/长图质量 | ✅ 实测通过（§4） | ✅ 商用级（未实测） | ✅ 同 Paddle 系（未实测） |
| 部署 | pip 装 venv 即可；服务器为普通 Python 服务 | 无需部署，Node 直连 API | Windows 解压即用；Linux 需 Docker+Qt，重 |
| Node 集成 | HTTP 微服务（约 30 行 Python 侧车） | HTTP API/SDK 直连 | HTTP API（base64 POST） |
| 成本 | 免费（本地 CPU） | 1000 次/月免费，超量付费 | 免费 |
| 隐私 | 图片不出本机 | 图片上传腾讯云（公开动态图，风险低） | 图片不出本机 |
| 运维风险 | 需保活一个 Python 进程 | 无进程、依赖外网与密钥 | Windows 期无；服务器期容器重 |
| 与服务器部署契合 | ✅ 好 | ✅ 好 | △ 勉强 |
| 量级适配 | 无限制 | 每月几十张 ≪ 1000 次，够用 | 无限制 |

## 4. 实测记录（RapidOCR，2026-10-02）

- 环境：Windows 11 + Python 3.10.11（独立 venv：`_research/ocr_probe/.venv`），`pip install rapidocr onnxruntime`（清华源）；
- 输入：三角洲行动《9月30日更新公告》真实长图（1080×2887，即本项目首个"信息全在图里"的案例），已存 `_research/ocr_probe/delta_notice.png`；
- 探针：`_research/ocr_probe/probe.py`（加载引擎 → 识别 → 打印全部文本行）；
- 结果：**模型加载 0.5s，识别 2.1s（CPU），29 行文本**，关键内容全部正确：
  - 日期类：`9月30日更新公告`、`2026年9月30日`；
  - 数值类：`四肢伤害倍率：0.6倍→0.4 倍`、`腹部伤害倍率：1.0倍→0.9 倍`；
  - 正文段落完整，标点与换行可用；
- 已知瑕疵（可后处理过滤）：装饰图标被误识为单字 `曰`/`口`；图顶部出现噪声行 `000001`。过滤规则建议：丢弃单字符行与纯数字行。

## 5. 推荐架构（Node ↔ OCR 边界）

```
Node 主服务（数据层处理链）
  └─ OcrClient 抽象接口：recognize(input): Promise<{ url, lines }>
       ├─ RapidOcrClient   → HTTP POST 图片 → Python 侧车服务（FastAPI + rapidocr，约 30 行）
       └─ TencentOcrClient → 腾讯云 API（备选降级，同一接口）
```

- Python 侧车服务与主服务同机部署（开发期 Windows venv 启动；服务器期 docker-compose 双容器），接口仅一个：图片 URL/base64 → 文本行数组；
- OCR 结果建议作为标准条目新增公有字段（供 LLM 消费 + evidence 追溯 + 幂等免重复识别）：
  `ocrTexts?: { imageUrl: string; text: string }[]`（待确认，见 §7）；
- 首版只实现 RapidOcrClient；云客户端在本地服务不可用时再接。

## 6. 成本与量级核算

- 图片量：63 条动态中 60 条带图（95%），但幂等机制保证每张图只识别一次；按官号日更 2–5 条估算，每月新增图片约 60–200 张；
- RapidOCR：0 元，CPU 单张 2–3 秒，夜间批量无压力；
- 云 OCR 若启用：约 200 次/月 ≪ 腾讯云 1000 次/月免费额度，0 元可覆盖。

## 7. 已定决策（2026-10-02）

1. **双运行时方案已接受**：Node 主服务 + Python OCR 侧车（FastAPI + rapidocr，目录 `ocr-service/`）；服务器部署时 docker-compose 双容器。
2. **字段方案已定**：标准条目新增公有字段 `ocrTexts?: { imageUrl; text }[]`（已同步《调研报告-活动数据结构》§4）。
3. **噪声过滤规则按 §4 建议执行**：丢弃单字符行与纯数字行，过滤逻辑在 Node 侧 OcrClient（业务规则不固化进通用侧车）。
