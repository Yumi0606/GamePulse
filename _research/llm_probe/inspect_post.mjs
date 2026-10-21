// 临时探针：查看指定动态的正文、图片 OCR 文本与已结构化条目
// 用法：node inspect_post.mjs <sourceId或id片段>
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.DB_PATH || 'data/feed.db';
const db = new DatabaseSync(dbPath);
const key = process.argv[2];

const post = db.prepare('SELECT * FROM posts WHERE id LIKE ? OR source_id LIKE ?').get(`%${key}%`, `%${key}%`);
if (!post) {
  console.log('未找到动态，key=', key);
  process.exit(0);
}
console.log('=== POST ===');
console.log('id:', post.id);
console.log('title:', post.title);
console.log('publishedAt:', post.published_at, new Date(post.published_at * 1000).toISOString());
console.log('description:', post.description);
console.log('images:', post.images);
console.log('extracted_at:', post.extracted_at, 'attempts:', post.extract_attempts, 'error:', post.extract_last_error);

const images = JSON.parse(post.images || '[]');
console.log('\n=== OCR ===');
for (const u of images) {
  const r = db.prepare('SELECT status, text FROM ocr_records WHERE image_url = ?').get(u);
  console.log('---', u.slice(-50), r?.status);
  console.log(r?.text || '(无记录)');
}

console.log('\n=== ENTRIES ===');
const entries = db.prepare('SELECT type, title, start_at, end_at, payload FROM entries WHERE post_id = ?').all(post.id);
for (const e of entries) {
  console.log(`[${e.type}] ${e.title}  ${e.start_at}~${e.end_at}`);
  const p = JSON.parse(e.payload);
  console.log('  category:', p.category, 'confidence:', p.confidence, 'evidence:', p.provenance?.[0]?.evidence);
}
console.log('entries count:', entries.length);
