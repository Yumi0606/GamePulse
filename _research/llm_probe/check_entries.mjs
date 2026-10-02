/** 检查 entries 写入质量。用法：node _research/llm_probe/check_entries.mjs */

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const rows = db.prepare('SELECT id, game_id, type, title, start_at, end_at, payload FROM entries LIMIT 4').all();
for (const r of rows) {
  const p = JSON.parse(r.payload);
  const fmt = (u) => (u ? new Date(u * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
  console.log(`[${r.type}] ${r.game_id} | ${r.title}`);
  console.log(`  时间: ${fmt(r.start_at)} → ${fmt(r.end_at)}; endRef=${p.endRef ?? '—'}; 置信=${p.confidence}; 溯源=${p.provenance.map((x) => x.method).join('+')}`);
}
const stats = db.prepare('SELECT type, COUNT(*) c FROM entries GROUP BY type').all();
console.log('分布:', JSON.stringify(stats));
const processed = db.prepare('SELECT COUNT(*) c FROM posts WHERE extracted_at IS NOT NULL').get().c;
console.log('已处理 posts:', processed);
