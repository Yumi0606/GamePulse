/** 检查 feed.db 三表结构与数据分布。用法：node _research/ocr_probe/check_db.mjs */

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log('tables:', tables.join(', '));
for (const tb of ['posts', 'ocr_records', 'entries', 'items_v1']) {
  try {
    console.log(tb, '=', db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c);
  } catch {
    console.log(tb, '= (不存在)');
  }
}
const sample = db.prepare('SELECT substr(text, 1, 50) t FROM ocr_records LIMIT 1').get();
console.log('ocr sample:', sample?.t);
const post = db.prepare('SELECT id, game_id, title FROM posts LIMIT 1').get();
console.log('post sample:', post?.game_id, '|', post?.title?.slice(0, 30));
