// 临时探针：通过真实 HTTP 接口验证切片效果。
// 用法：node http_verify.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const samples = [
  ['ratio21.8_21793', 'https://i0.hdslb.com/bfs/new_dyn/2d4e43a71a8abcc5a418ac4523f59c3f161775300.jpg'],
  ['ratio14.5_15640', 'https://i0.hdslb.com/bfs/new_dyn/22722b00e57f7f8397feb596df634c421955897084.jpg'],
  ['ratio8.4_9078', 'https://i0.hdslb.com/bfs/new_dyn/4d634470411a9e8020f4b6382eaf89311955897084.jpg'],
  ['ratio4.4_4798', 'https://i0.hdslb.com/bfs/new_dyn/e9e281f333f2165a76eb3e344ab10bb01955897084.jpg'],
  ['ratio2.7_2887', 'https://i0.hdslb.com/bfs/new_dyn/de309a891dc5f8885096e31f7b7e84e43494376565115651.png'],
];

mkdirSync('out_http', { recursive: true });
for (const [name, url] of samples) {
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:1225/ocr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageUrl: url }),
  });
  if (!res.ok) {
    console.error(name, 'HTTP', res.status, await res.text());
    continue;
  }
  const { lines, slices } = await res.json();
  const chars = lines.reduce((n, l) => n + l.length, 0);
  writeFileSync(`out_http/${name}.txt`, lines.join('\n'), 'utf8');
  console.log(`${name} slices=${slices} 行=${lines.length} 字=${chars} costMs=${Date.now() - t0}`);
}
