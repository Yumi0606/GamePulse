/**
 * 查询库内动态：列表 / 关键词搜索 / 单条详情（可选附带 OCR 文本与已结构化条目）。
 * 离线，0 次 LLM 调用。
 *
 * 用法：
 *   node _research/llm_probe/db_posts.mjs --game endfield [--title 关键词] [--limit 10]
 *   node _research/llm_probe/db_posts.mjs --id 1256071780002431033 [--ocr] [--entries]
 *
 * 说明：
 *   --id     支持 id / source_id 片段匹配；命中多条时全部列出，只有唯一一条才展开详情。
 *   --ocr    打印每张图的 OCR 状态与文本（默认只打印状态摘要）。
 *   --entries 打印以该动态为主来源的结构化条目。
 */
import { DatabaseSync } from 'node:sqlite';
import { normalizeImageUrl } from '../../dist/core/imageUrl.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const fmt = (ts) =>
  ts == null ? '—' : new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

const idKey = flag('id');
const game = flag('game');
const title = flag('title', '');
const limit = Number(flag('limit', 10));

/** 按条件取动态行；无任何过滤时返回空，避免误dump整库 */
function selectPosts() {
  const where = [];
  const params = [];
  if (idKey) {
    where.push('(id LIKE ? OR source_id LIKE ?)');
    params.push(`%${idKey}%`, `%${idKey}%`);
  }
  if (game) {
    where.push('game_id = ?');
    params.push(game);
  }
  if (title) {
    where.push('title LIKE ?');
    params.push(`%${title}%`);
  }
  if (where.length === 0) {
    console.error('至少指定 --game / --title / --id 之一');
    process.exit(1);
  }
  const sql = `SELECT id, game_id, source_id, title, description, images, published_at, extracted_at, extract_attempts, extract_last_error
               FROM posts WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit);
}

/** 摘要行：id | 时间 | 已结构化 | 标题 */
function printRow(p) {
  const mark = p.extracted_at ? '已结构化' : '待处理';
  console.log(`${p.id} | ${fmt(p.published_at)} | ${mark} | ${(p.title ?? '').slice(0, 60)}`);
}

/** 详情：正文、OCR、主来源条目 */
function printDetail(p, withOcr) {
  console.log('\n=== 动态 ===');
  console.log(`id: ${p.id}`);
  console.log(`游戏: ${p.game_id}  类型: ${p.source_id ? 'source_id=' + p.source_id : '—'}`);
  console.log(`标题: ${p.title}`);
  console.log(`发布: ${fmt(p.published_at)}`);
  console.log(`结构化: extracted_at=${p.extracted_at ?? 'NULL'} attempts=${p.extract_attempts ?? 0}`);
  if (p.extract_last_error) console.log(`最近错误: ${p.extract_last_error}`);
  console.log(`\n=== 正文 ===\n${p.description || '(空)'}`);

  const images = JSON.parse(p.images || '[]');
  console.log(`\n=== OCR（${images.length} 张图）===`);
  for (const u of images) {
    const r = db
      .prepare('SELECT status, text, attempts FROM ocr_records WHERE image_url = ?')
      .get(normalizeImageUrl(u));
    console.log(`--- ${u.slice(-48)} | ${r ? `${r.status} attempts=${r.attempts} 字数=${(r.text ?? '').length}` : '无记录'}`);
    if (withOcr && r?.text) console.log(r.text);
  }

  if (has('entries')) {
    const rows = db
      .prepare('SELECT id, type, post_id, title, start_at, end_at, payload FROM entries WHERE post_id = ?')
      .all(p.id);
    console.log(`\n=== 以本动态为主来源的条目（${rows.length} 条）===`);
    for (const e of rows) {
      const payload = JSON.parse(e.payload || '{}');
      const src = payload.extra?.postIds ?? (e.post_id ? [e.post_id] : []);
      console.log(`[${e.type}] ${e.title}  ${fmt(e.start_at)} → ${fmt(e.end_at)}`);
      console.log(`  id=${e.id} canonical=${payload.canonicalName ?? '—'} 来源数=${src.length}`);
    }
  }
}

const rows = selectPosts();
if (rows.length === 0) {
  console.log('未匹配到动态');
  process.exit(1);
}

console.log(`匹配 ${rows.length} 条动态${game ? `（${game}）` : ''}${title ? `，标题含"${title}"` : ''}：`);
rows.forEach(printRow);
if (idKey && rows.length === 1) printDetail(rows[0], has('ocr'));
