# ocr-service/CLAUDE.md — OCR 侧车

RapidOCR 的 HTTP 封装（Python/FastAPI），模型常驻内存、CPU 推理，单实例设计。选型见《调研报告-OCR选型.md》。

## 接口

- `POST /ocr` 请求 `{"imageUrl": "..."}`，返回 `{"lines": ["..."], "slices": N}`。
- `lines` 是分块后的文本行：视觉上独立的卡片块之间用空行分隔。
- 图片下载失败返回 502 + "图片下载失败"；Node 客户端据此判定为死图并消耗重试次数。
- 启动：`pnpm ocr`（`node ocr-service/start.js`）；默认端口 1225，与 `OCR_SERVICE_URL` 对齐。

## 长图处理

- 长边缩放到检测模型输入上限会漏检小字，因此超高图片按 `OCR_TILE_MAX_H`（默认 2000）纵向切片，逐片识别后按序合并。
- 切点在理想位置 ±`OCR_TILE_SEARCH_BAND`（默认 240）内选行能量最低的空白行，避免切断文字；尾段高度低于 `OCR_TILE_MIN_TAIL`（默认 200）时并入前一片。
- 只对 `TILE_FORMATS`（JPEG/PNG）切片；GIF 等动态图整图直送引擎。

## 版面分块

- 利用每行 bbox 的 y 坐标，在全图坐标系下按间隙分块，块间插入空行；阈值 `max(行高中位数 × 4, 40px)`。
- 目标：避免长图中不同卡片的标题与时间在文本流里交错，导致 LLM 把时间归给错误活动。
- 当前只处理上下排列的卡片；左右双栏布局未处理，出现时需要再做列检测。
- 切片还原时必须把片内 y 偏移加回全图坐标，否则分块边界会错。

## 边界

- 噪声过滤（单字符行、纯数字行）在 Node 侧做，侧车保持通用，不固化业务规则。
- 修改分块逻辑后，先对一张已知长图跑 `_research/ocr_probe/ocr_one_post.mjs <postId>` 查看空行分布，再跑 LLM 验证时间归属。
