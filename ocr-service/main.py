"""OCR 侧车服务：RapidOCR 的 HTTP 封装（选型见《调研报告-OCR选型.md》）。

接口：POST /ocr {"imageUrl": "..."} → {"lines": ["...", ...], "slices": N}
（分块后的文本行：视觉上独立的卡片块之间用空行分隔，噪声过滤在 Node 侧）
模型常驻内存，CPU 推理；单实例设计，无并发优化需求（调用量：每月新增图片几十张）。

长图处理：长边缩放到检测模型输入上限会导致小字漏检，
因此对超高图片按 OCR_TILE_MAX_H 纵向切片，逐片识别后按序合并；
切点在理想位置附近选取行能量最低的空白行，避免切断文字。

版面恢复：利用每行文本的 bbox y 坐标，在全图坐标下按 y 间隙分块，
块之间插入空行，帮助下游 LLM 区分视觉上独立的活动卡片，
避免长图中不同卡片的标题与时间在文本流中交错错位。
"""

import io
import logging
import os
import time

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel
from rapidocr import RapidOCR

app = FastAPI(title="game-feed-ocr")
engine = RapidOCR()
log = logging.getLogger("ocr")

# 超过该高度（像素）的图片切片识别；环境变量供部署期调参
TILE_MAX_H = int(os.environ.get("OCR_TILE_MAX_H", "2000"))
# 理想切点上下搜索空白带的半宽（像素）
TILE_SEARCH_BAND = int(os.environ.get("OCR_TILE_SEARCH_BAND", "240"))
# 尾段小于该高度（像素）时并入前一片：窄于该值的切片会低于引擎最小边限制而报错
MIN_TAIL_H = int(os.environ.get("OCR_TILE_MIN_TAIL", "200"))
# 仅对这些格式切片；GIF 等动态图保持整图字节直送引擎
TILE_FORMATS = {"JPEG", "PNG"}


class OcrRequest(BaseModel):
    imageUrl: str


def row_energy(gray: np.ndarray) -> np.ndarray:
    """行能量：相邻像素差分均值。文字行边缘密集则能量高，空白/纯色行接近 0。"""
    arr = gray.astype(np.float32)
    return np.abs(np.diff(arr, axis=1)).mean(axis=1)


def smart_cuts(gray: np.ndarray, max_h: int, band: int) -> list[int]:
    """生成自上而下的切点（绝对 y 坐标，不含末尾）。

    在每个理想切点 ±band 范围内寻找最低能量行；
    仅当最低能量明显低于窗口中位数时采用，否则按理想位置硬切（整页密集文字的兜底）。
    """
    h = gray.shape[0]
    energy = row_energy(gray)
    cuts: list[int] = []
    y = max_h
    while y < h:
        lo = max(0, y - band)
        hi = min(h, y + band)
        window = energy[lo:hi]
        idx = int(np.argmin(window))
        if float(window[idx]) < float(np.median(window)) * 0.5:
            cut = lo + idx
        else:
            cut = y
        # 尾段过窄则停止切片，尾段并入前一片
        if h - cut < MIN_TAIL_H:
            break
        cuts.append(cut)
        y = cut + max_h
    return cuts


def recognize_tiles(content: bytes) -> tuple[list[str], int]:
    """对超高图片切片识别，返回（分块后的文本行，切片数）。

    切片识别时保留每行 bbox 坐标并偏移回原图坐标，
    最后在全图坐标下按 y 间隙分块，块之间插入空行。
    """
    img = Image.open(io.BytesIO(content))
    # 收集所有 (text, y_center, height)，y 统一到原图坐标
    items: list[tuple[str, float, float]] = []

    if img.format not in TILE_FORMATS or img.height < TILE_MAX_H + MIN_TAIL_H:
        result = engine(content)
        _collect_items(result, items, y_offset=0)
        slices = 1
    else:
        gray = np.asarray(img.convert("L"))
        cuts = smart_cuts(gray, TILE_MAX_H, TILE_SEARCH_BAND)
        bounds = [0] + cuts + [img.height]
        rgb = img.convert("RGB")
        for i in range(len(bounds) - 1):
            tile = rgb.crop((0, bounds[i], rgb.width, bounds[i + 1]))
            buf = io.BytesIO()
            tile.save(buf, format="PNG")  # 无损编码，避免二次压缩伪影
            result = engine(buf.getvalue())
            _collect_items(result, items, y_offset=bounds[i])
        slices = len(bounds) - 1
        log.info("长图切片 size=%dx%d slices=%d cuts=%s", img.width, img.height, slices, cuts)

    lines = _block_by_y_gap(items)
    return lines, slices


def _collect_items(result, items: list[tuple[str, float, float]], y_offset: int) -> None:
    """从 RapidOCR 结果提取 (text, y_center, height)，y 坐标加上切片偏移量。"""
    if result is None or not getattr(result, "txts", None):
        return
    boxes = getattr(result, "boxes", None)
    for idx, text in enumerate(result.txts):
        if boxes is not None and idx < len(boxes):
            ys = boxes[idx][:, 1]
            y_center = float(np.mean(ys)) + y_offset
            height = float(np.max(ys) - np.min(ys))
        else:
            # 无坐标时退化为顺序追加，y_center 递增值避免误判为同一块
            y_center = (items[-1][1] + 1.0) if items else 0.0
            height = 1.0
        items.append((text, y_center, height))


def _block_by_y_gap(items: list[tuple[str, float, float]]) -> list[str]:
    """按 y 中心坐标排序，相邻行 y 间隙超过阈值时插入空行分隔块。

    阈值 = max(行高中位数 × 4, 40px)。
    排版中行间距通常为行高的 1~1.5 倍，卡片间留白为行高的 3 倍以上；
    取 4 倍行高可区分卡片内标题-描述的较大行距与卡片间的块间距。
    """
    if not items:
        return []
    items.sort(key=lambda x: x[1])
    heights = [h for _, _, h in items if h > 0]
    median_h = float(np.median(heights)) if heights else 0.0
    threshold = max(median_h * 4.0, 40.0)

    lines: list[str] = []
    prev_y: float | None = None
    for text, y_center, _ in items:
        if prev_y is not None and (y_center - prev_y) > threshold:
            lines.append("")  # 块分隔空行
        lines.append(text)
        prev_y = y_center
    return lines


@app.post("/ocr")
def ocr(req: OcrRequest) -> dict:
    # B站图片为公开直链，直接下载（http/https 均可，跟随重定向）
    try:
        resp = httpx.get(req.imageUrl, timeout=30, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"图片下载失败: {e}")
    t0 = time.time()
    lines, slices = recognize_tiles(resp.content)
    log.info("OCR 完成 image=%s slices=%d lines=%d costMs=%d",
             req.imageUrl.rsplit("/", 1)[-1], slices, len(lines), (time.time() - t0) * 1000)
    return {"lines": lines, "slices": slices}
