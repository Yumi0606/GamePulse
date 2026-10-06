# 临时探针：统计库中非 GIF 图片的尺寸与长宽比，用于挑选长图样本
import concurrent.futures
import io
import sqlite3

import httpx
from PIL import Image

db = sqlite3.connect('data/feed.db')
rows = db.execute(
    "select image_url, length(text) from ocr_records "
    "where status='ok' and image_url not like '%.gif'"
).fetchall()


def size(item):
    url, tlen = item
    try:
        r = httpx.get(url, timeout=20, follow_redirects=True)
        r.raise_for_status()
        im = Image.open(io.BytesIO(r.content))
        return (url, im.size[0], im.size[1], tlen, len(r.content))
    except Exception:
        return (url, -1, -1, tlen, 0)


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    out = list(ex.map(size, rows))

out = [o for o in out if o[1] > 0]
out.sort(key=lambda x: -x[2])
for url, w, h, tlen, blen in out:
    name = url.rsplit('/', 1)[-1]
    print(f'{w}x{h} ratio={h / w:.2f} text={tlen} bytes={blen} {name}')
