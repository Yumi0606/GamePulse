/**
 * 单条动态逐图重跑 OCR（走生产 recognizeImage，含重试），默认落库。
 *
 * 用法：
 *   node _research/ocr_probe/ocr_one_post.mjs <postId> [--index 2] [--dry]
 *
 * 说明：
 *   --index  只跑第 N 张图（1 开始）；省略则跑全部。
 *   --dry    只识别不写库，便于先确认效果再决定是否消耗一次落库机会。
 */
import { DatabaseSync } from 'node:sqlite';
import { recognizeImage } from '../../dist/processing/ocr.js';
import { saveOcrRecord } from '../../dist/storage/store.js';

const args = process.argv.slice(2);
const postId = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const onlyIndex = Number(flag('index', 0));
const dry = has('dry');

if (!postId) {
  console.error('用法：node ocr_one_post.mjs <postId> [--index N] [--dry]');
  process.exit(1);
}

const db = new DatabaseSync('data/feed.db');
const row = db.prepare('SELECT images FROM posts WHERE id = ?').get(postId);
db.close();
if (!row) {
  console.error(`动态不存在：${postId}`);
  process.exit(1);
}

const urls = JSON.parse(row.images ?? '[]');
const targets = onlyIndex > 0 ? [urls[onlyIndex - 1]].filter(Boolean) : urls;
if (targets.length === 0) {
  console.error(`图片索引越界：该动态共 ${urls.length} 张`);
  process.exit(1);
}
console.log(`${postId} 共 ${urls.length} 张图，本次处理 ${targets.length} 张${dry ? '（dry-run 不写库）' : ''}`);

for (const url of targets) {
  // B 站直链偶发 502，重试几次再放弃
  let rec = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rec = await recognizeImage(url);
      break;
    } catch (e) {
      console.log(`  attempt ${attempt} 失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!rec) {
    console.log(`  ${url.slice(-30)} 放弃`);
    continue;
  }
  if (!dry) await saveOcrRecord(url, postId, rec.text);
  const lines = rec.text.split('\n');
  const blanks = lines.filter((l) => l.trim() === '').length;
  console.log(`  ${url.slice(-30)} lines=${lines.length} blanks=${blanks}${dry ? '' : ' 已落库'}`);
  if (dry) {
    for (const line of lines.slice(0, 20)) console.log(`    ${line}`);
  }
}
