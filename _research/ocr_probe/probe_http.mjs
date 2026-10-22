/**
 * OCR 侧车连通性与版面分块探针（离线，直连 http://127.0.0.1:1225/ocr）。
 *
 * 用法：
 *   node _research/ocr_probe/probe_http.mjs --post <postId> [--index 1]   按库中动态取图
 *   node _research/ocr_probe/probe_http.mjs --url <图片URL>
 *
 * 输出：切片数、行数、空行数（卡片分块标志）、前若干行文本。
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const postId = flag('post');
const url = flag('url');
const index = Number(flag('index', 1));
const preview = Number(flag('preview', 8));

let imageUrl = url;
if (!imageUrl && postId) {
  const db = new DatabaseSync('data/feed.db', { readOnly: true });
  const row = db.prepare('SELECT images FROM posts WHERE id = ?').get(postId);
  db.close();
  if (!row) {
    console.error(`动态不存在：${postId}`);
    process.exit(1);
  }
  const images = JSON.parse(row.images ?? '[]');
  imageUrl = images[index - 1];
  if (!imageUrl) {
    console.error(`${postId} 只有 ${images.length} 张图，索引 ${index} 越界`);
    process.exit(1);
  }
}
if (!imageUrl) {
  console.error('用法：probe_http.mjs --post <postId> [--index N]  或  --url <图片URL>');
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:1225/ocr', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ imageUrl }),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}

const { lines, slices } = await res.json();
const blanks = lines.filter((l) => l.trim() === '').length;
console.log(`图片: ${imageUrl}`);
console.log(`切片=${slices ?? '—'} 行=${lines.length} 空行=${blanks} 字符=${lines.reduce((n, l) => n + l.length, 0)} 耗时=${Date.now() - t0}ms`);
console.log('--- 前几行 ---');
console.log(lines.slice(0, preview).join('\n'));
