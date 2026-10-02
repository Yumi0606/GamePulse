/** 抽查库存 OCR 富化结果：统计覆盖数、打印一条长图条目的 ocrTexts。
 * 用法：node _research/ocr_probe/check_store.mjs
 */

import { readFileSync } from 'node:fs';

const map = JSON.parse(readFileSync('data/items.json', 'utf8'));
const items = Object.values(map);
const withImages = items.filter((it) => (it.images?.length ?? 0) > 0);
const withOcr = items.filter((it) => (it.ocrTexts?.length ?? 0) > 0);
console.log(`库存 ${items.length} 条 | 带图 ${withImages.length} 条 | 已 OCR ${withOcr.length} 条`);

const sample = items.find((it) => it.sourceId === '1253751939269656582'); // 三角洲更新公告长图
if (sample) {
  console.log('\n样例：', sample.title);
  for (const t of sample.ocrTexts ?? []) {
    console.log(`  图片: ${t.imageUrl}`);
    console.log(t.text.split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'));
  }
} else {
  console.log('未找到样例条目');
}
