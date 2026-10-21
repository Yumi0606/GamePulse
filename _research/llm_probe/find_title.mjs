// 临时探针：按关键词查 entries 及其来源动态
// 用法：DB_PATH=... node find_title.mjs 关键词
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH || 'data/feed.db');
const kw = process.argv[2];
const entries = db.prepare("SELECT * FROM entries WHERE title LIKE ? OR payload LIKE ?").all(`%${kw}%`, `%${kw}%`);
for (const e of entries) {
  const p = JSON.parse(e.payload);
  console.log(`[${e.type}] ${e.title}  start=${e.start_at} end=${e.end_at} post=${e.post_id}`);
  console.log('  estimated:', p.estimated, 'conf:', p.confidence);
  console.log('  startRef:', JSON.stringify(p.startRef), 'endRef:', JSON.stringify(p.endRef));
  console.log('  phases:', JSON.stringify(p.phases?.map(x => ({ t: x.title, s: x.startAt, e: x.endAt, sr: x.startRef, er: x.endRef }))));
}
console.log('count:', entries.length);
