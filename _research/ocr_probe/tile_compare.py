# 临时探针：长图 OCR 整图 vs 切片对比。
# 用法：python tile_compare.py
# 输出每张样本两种模式的行数/字符数/耗时，并把识别文本写入 out_tile/ 供目检。
import io
import os
import time

import httpx
import numpy as np
from PIL import Image
from rapidocr import RapidOCR

# 按长宽比分层抽取的样本（尺寸与长宽比来自 measure.py）
SAMPLES = [
    ('ratio21.8_21793', 'https://i0.hdslb.com/bfs/new_dyn/2d4e43a71a8abcc5a418ac4523f59c3f161775300.jpg'),
    ('ratio14.5_15640', 'https://i0.hdslb.com/bfs/new_dyn/22722b00e57f7f8397feb596df634c421955897084.jpg'),
    ('ratio8.4_9078', 'https://i0.hdslb.com/bfs/new_dyn/4d634470411a9e8020f4b6382eaf89311955897084.jpg'),
    ('ratio4.4_4798', 'https://i0.hdslb.com/bfs/new_dyn/e9e281f333f2165a76eb3e344ab10bb01955897084.jpg'),
    ('ratio2.7_2887', 'https://i0.hdslb.com/bfs/new_dyn/de309a891dc5f8885096e31f7b7e84e43494376565115651.png'),
]

TILE_MAX_H = int(os.environ.get('OCR_TILE_MAX_H', '2000'))
SEARCH_BAND = int(os.environ.get('OCR_TILE_BAND', '240'))

engine = RapidOCR()


def row_energy(gray: np.ndarray) -> np.ndarray:
    """行能量：相邻像素差分均值。文字行边缘密集则能量高，空白/纯色行接近 0。"""
    arr = gray.astype(np.float32)
    return np.abs(np.diff(arr, axis=1)).mean(axis=1)


def smart_cuts(gray: np.ndarray, max_h: int, band: int) -> list[int]:
    """生成自上而下的切点（绝对 y 坐标，不含末尾）。在理想切点附近寻找低能量行，避免切断文字。"""
    h = gray.shape[0]
    energy = row_energy(gray)
    cuts: list[int] = []
    y = max_h
    while y < h:
        lo = max(0, y - band)
        hi = min(h, y + band)
        window = energy[lo:hi]
        # 窗口内最低能量位置；要求明显低于窗口中位数（确认是空白带而非整页密集文字）
        idx = int(np.argmin(window))
        median = float(np.median(window))
        best = float(window[idx])
        if best < median * 0.5:
            cuts.append(lo + idx)
            y = lo + idx + max_h
        else:
            cuts.append(y)
            y += max_h
    return cuts


def split_image(img: Image.Image):
    """纵向切片；返回各片 PIL 图像。"""
    gray = np.asarray(img.convert('L'))
    cuts = smart_cuts(gray, TILE_MAX_H, SEARCH_BAND)
    bounds = [0] + cuts + [img.height]
    return [img.crop((0, bounds[i], img.width, bounds[i + 1])) for i in range(len(bounds) - 1)]


def run_engine(img: Image.Image):
    buf = io.BytesIO()
    # PNG 无损，避免二次压缩伪影影响检测
    img.save(buf, format='PNG')
    result = engine(buf.getvalue())
    return list(result.txts or [])


os.makedirs('out_tile', exist_ok=True)
print(f'{"sample":18} {"size":11} {"whole行/字/秒":>20} {"tile片数":>7} {"tile行/字/秒":>20}')
summary = []
for name, url in SAMPLES:
    resp = httpx.get(url, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content)).convert('RGB')

    t0 = time.time()
    whole = run_engine(img)
    whole_ms = time.time() - t0

    tiles = split_image(img)
    t0 = time.time()
    tiled: list[str] = []
    per_tile = []
    for i, tile in enumerate(tiles):
        lines = run_engine(tile)
        per_tile.append(len(lines))
        tiled.extend(lines)
    tile_ms = time.time() - t0

    with open(f'out_tile/{name}_whole.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(whole))
    with open(f'out_tile/{name}_tile.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(tiled))

    w_chars = sum(len(l) for l in whole)
    t_chars = sum(len(l) for l in tiled)
    print(f'{name:18} {f"{img.width}x{img.height}":11} '
          f'{len(whole):>5} {w_chars:>5} {whole_ms:>6.1f}s '
          f'{len(tiles):>7} {len(tiled):>5} {t_chars:>5} {tile_ms:>6.1f}s')
    summary.append((name, len(whole), w_chars, whole_ms, len(tiles), len(tiled), t_chars, tile_ms))
