/** 按游戏/关键词查找库内动态。用法：node _research/llm_probe/find_posts.mjs --game endfield [--title 关键词] [--limit 10] */

import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const game = flag('game', 'endfield');
const title = flag('title', '');
const limit = Number(flag('limit', 10));

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const total = db.prepare('SELECT COUNT(*) c FROM posts WHERE game_id = ?').get(game).c;
console.log(`${game} 共 ${total} 条${title ? `，标题含"${title}"的：` : '，最新如下：'}`);

const rows = title
  ? db.prepare('SELECT id, published_at, title FROM posts WHERE game_id = ? AND title LIKE ? ORDER BY published_at DESC LIMIT ?').all(game, `%${title}%`, limit)
  : db.prepare('SELECT id, published_at, title FROM posts WHERE game_id = ? ORDER BY published_at DESC LIMIT ?').all(game, limit);

for (const r of rows) {
  const t = new Date(r.published_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`  ${r.id} | ${t} | ${r.title.slice(0, 50)}`);
}
if (rows.length === 0) console.log('  (无)');
