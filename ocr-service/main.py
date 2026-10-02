"""OCR 侧车服务：RapidOCR 的 HTTP 封装（选型见《调研报告-OCR选型.md》）。

接口：POST /ocr {"imageUrl": "..."} → {"lines": ["...", ...]}（原始文本行，过滤在 Node 侧）
模型常驻内存，CPU 推理；单实例设计，无并发优化需求（调用量：每月新增图片几十张）。
"""

import logging

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from rapidocr import RapidOCR

app = FastAPI(title="game-feed-ocr")
engine = RapidOCR()
log = logging.getLogger("ocr")


class OcrRequest(BaseModel):
    imageUrl: str


@app.post("/ocr")
def ocr(req: OcrRequest) -> dict:
    # B站图片为公开直链，直接下载（http/https 均可，跟随重定向）
    try:
        resp = httpx.get(req.imageUrl, timeout=30, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"图片下载失败: {e}")
    result = engine(resp.content)
    return {"lines": list(result.txts or [])}
