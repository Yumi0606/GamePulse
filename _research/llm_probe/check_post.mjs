/** 确认测试目标动态在库且 OCR 完好。
 * 用法：node _research/llm_probe/check_post.mjs [--game xxx] [--title xxx] [--post postId] */

import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const db = new DatabaseSync('data/feed.db', { readOnly: true });

// 指定 post id 精确查；否则按 gameId+标题模糊查
let rows;
if (flag('post')) {
  rows = db.prepare('SELECT id, game_id, title, published_at, images, extracted_at FROM posts WHERE id = ?').all(flag('post'));
} else {
  rows = db
    .prepare("SELECT id, game_id, title, published_at, images, extracted_at FROM posts WHERE game_id = ? AND title LIKE ?")
    .all(flag('game') ?? 'delta-force', `%${flag('title') ?? '9月30日更新公告'}%`);
}

if (rows.length === 0) {
  console.log('未找到目标动态');
  process.exit(1);
}

for (const p of rows) {
  console.log('id:', p.id);
  console.log('title:', p.title);
  console.log('发布:', new Date(p.published_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  console.log('处理状态: extracted_at =', p.extracted_at ?? 'NULL（待处理）');
  const imgs = JSON.parse(p.images || '[]');
  console.log('图片数:', imgs.length);
  for (const u of imgs) {
    const o = db.prepare('SELECT status, text, length(text) len, attempts FROM ocr_records WHERE image_url = ?').get(u);
    console.log(`  ocr: ${o ? `${o.status} 文本长度=${o.len} attempts=${o.attempts}` : '(无记录)'} | ${u}`);
    if (o?.text) console.log('  ---- OCR 文本 ----\n' + o.text + '\n  ------------------');
  }
}
