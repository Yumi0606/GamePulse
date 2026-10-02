"""OCR 探针：用 RapidOCR 识别真实海报长图，检验活动时间类信息的识别质量。

用法：python probe.py <图片路径>
"""

import sys
import time

from rapidocr import RapidOCR

t_load = time.time()
engine = RapidOCR()
load_s = time.time() - t_load

t_run = time.time()
result = engine(sys.argv[1])
run_s = time.time() - t_run

txts = list(result.txts or [])
print(f"模型加载: {load_s:.1f}s | 识别耗时: {run_s:.1f}s | 文本行数: {len(txts)}")
print("-" * 40)
for line in txts:
    print(line)
