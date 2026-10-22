/**
 * 查询库内条目：按游戏 / 关键词 / 类型 / 条目 id 过滤；可选展开来源动态与 OCR。
 * 离线，0 次 LLM 调用。
 *
 * 用法：
 *   node _research/llm_probe/db_entries.mjs --game endfield --kw 烟火生缘
 *   node _research/llm_probe/db_entries.mjs --game endfield --type ACTIVITY [--limit 50]
 *   node _research/llm_probe/db_entries.mjs --id endfield:ACTIVITY:1g7qiiu --source
 *
 * 说明：
 *   --kw      匹配 payload（含 canonicalName/title/summary）。
 *   --id      支持条目 id 片段匹配，命中多条时全部列出。
 *   --source  展开每条目的来源动态正文与 OCR（截断 25 行/图）。
 */
import { DatabaseSync } from 'node:sqlite';
import { normalizeImageUrl } from '../../dist/core/imageUrl.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const game = flag('game');
const kw = flag('kw') ?? (args[0] && !args[0].startsWith('--') ? args[0] : undefined);
const idKey = flag('id');
const type = flag('type');
const limit = Number(flag('limit', 40));
const withSource = has('source');

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const fmt = (ts) =>
  ts == null ? '—' : new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

const where = [];
const params = [];
if (game) { where.push('game_id = ?'); params.push(game); }
if (type) { where.push('type = ?'); params.push(type); }
if (idKey) { where.push('id LIKE ?'); params.push(`%${idKey}%`); }
if (kw) { where.push('payload LIKE ?'); params.push(`%${kw}%`); }
if (where.length === 0) {
  console.error('至少指定 --game / --kw / --id / --type 之一');
  process.exit(1);
}

const rows = db
  .prepare(`SELECT id, game_id, type, post_id, title, start_at, end_at, payload, first_seen_at
            FROM entries WHERE ${where.join(' AND ')} ORDER BY start_at DESC LIMIT ?`)
  .all(...params, limit);

console.log(`匹配 ${rows.length} 条条目${game ? `（${game}）` : ''}${kw ? `，关键词"${kw}"` : ''}\n`);
for (const e of rows) {
  const p = JSON.parse(e.payload || '{}');
  const src = p.extra?.postIds ?? (e.post_id ? [e.post_id] : []);
  console.log(`[${e.type}] ${p.canonicalName ?? e.title}`);
  console.log(`  id=${e.id}  来源数=${src.length}  first_seen=${fmt(e.first_seen_at)}`);
  console.log(`  时间=${fmt(e.start_at)} → ${fmt(e.end_at)}  estimated=${p.estimated ?? false} conf=${p.confidence ?? '—'}`);
  if (p.startRef || p.endRef) console.log(`  ref=${p.startRef?.refText ?? '—'} ~ ${p.endRef?.refText ?? '—'}`);
  console.log(`  postIds=${JSON.stringify(src)}`);

  if (withSource) {
    for (const pid of src) {
      const post = db
        .prepare('SELECT title, description, published_at, images FROM posts WHERE id = ?')
        .get(pid);
      if (!post) { console.log(`  [来源动态缺失] ${pid}`); continue; }
      console.log(`\n  --- 来源 ${pid} @ ${fmt(post.published_at)} ---`);
      console.log(`  标题: ${post.title}`);
      console.log(`  正文: ${(post.description ?? '').replace(/\s+/g, ' ').slice(0, 500)}`);
      for (const u of post.images ? JSON.parse(post.images) : []) {
        const ocr = db
          .prepare('SELECT text, status FROM ocr_records WHERE image_url = ?')
          .get(normalizeImageUrl(u));
        if (!ocr) { console.log(`  [OCR 缺失] ${u}`); continue; }
        console.log(`  OCR(${ocr.status}) ${u.slice(-24)}:`);
        for (const line of (ocr.text ?? '').split('\n').slice(0, 25)) console.log(`    ${line}`);
      }
    }
    console.log('');
  }
}
