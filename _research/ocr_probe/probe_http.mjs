/** OCR 侧车 HTTP 探针：POST /ocr 并打印行数与前 5 行。
 * 用法：node probe_http.mjs [图片URL]
 */

const imageUrl = process.argv[2]
  ?? 'http://i0.hdslb.com/bfs/new_dyn/de309a891dc5f8885096e31f7b7e84e43494376565115651.png';

const res = await fetch('http://127.0.0.1:1225/ocr', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ imageUrl }),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}
const { lines } = await res.json();
console.log('行数:', lines.length);
console.log(lines.slice(0, 5).join(' | '));
