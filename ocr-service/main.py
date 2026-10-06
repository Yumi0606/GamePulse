"""OCR 侧车服务：RapidOCR 的 HTTP 封装（选型见《调研报告-OCR选型.md》）。

接口：POST /ocr {"imageUrl": "..."} → {"lines": ["...", ...], "slices": N}
（原始文本行，噪声过滤在 Node 侧）
模型常驻内存，CPU 推理；单实例设计，无并发优化需求（调用量：每月新增图片几十张）。

长图处理：长边缩放到检测模型输入上限会导致小字漏检，
因此对超高图片按 OCR_TILE_MAX_H 纵向切片，逐片识别后按序合并；
切点在理想位置附近选取行能量最低的空白行，避免切断文字。
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
        cuts.append(cut)
        y = cut + max_h
    return cuts


def recognize_tiles(content: bytes) -> tuple[list[str], int]:
    """对超高图片切片识别，返回（合并后的文本行，切片数）。"""
    img = Image.open(io.BytesIO(content))
    if img.format not in TILE_FORMATS or img.height <= TILE_MAX_H:
        result = engine(content)
        return list(result.txts or []), 1

    gray = np.asarray(img.convert("L"))
    cuts = smart_cuts(gray, TILE_MAX_H, TILE_SEARCH_BAND)
    bounds = [0] + cuts + [img.height]
    rgb = img.convert("RGB")
    lines: list[str] = []
    for i in range(len(bounds) - 1):
        tile = rgb.crop((0, bounds[i], rgb.width, bounds[i + 1]))
        buf = io.BytesIO()
        tile.save(buf, format="PNG")  # 无损编码，避免二次压缩伪影
        result = engine(buf.getvalue())
        lines.extend(list(result.txts or []))
    log.info("长图切片 size=%dx%d slices=%d cuts=%s", img.width, img.height, len(bounds) - 1, cuts)
    return lines, len(bounds) - 1


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
