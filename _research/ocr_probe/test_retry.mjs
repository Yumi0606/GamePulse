/** OCR 失败重试状态机测试（直调 store API，不跑 sync 避免 posts.images 被源覆盖）。
 * 用法：node _research/ocr_probe/test_retry.mjs run|cleanup */

import { saveOcrFailure, saveOcrRecord, listUnrecognizedImages, loadOcrTexts } from '../../dist/storage/store.js';
import { normalizeImageUrl } from '../../dist/core/imageUrl.js';
import { DatabaseSync } from 'node:sqlite';

const DEAD_URL = 'http://i1.hdslb.com/bfs/new_dyn/__test_dead__.png';
const POST_ID = 'arknights:NEWS:1254468906744020999';

function inQueue() {
  const db = new DatabaseSync('data/feed.db', { readOnly: true });
  const n = db.prepare(`
    SELECT COUNT(*) c FROM posts p, json_each(p.images) j
    LEFT JOIN ocr_records o ON o.image_url = j.value
    WHERE (o.image_url IS NULL OR (o.status = 'failed' AND o.attempts < 3))
      AND j.value LIKE '%__test_dead__%'
  `).get();
  db.close();
  return n.c === 1;
}

if (process.argv[2] === 'run') {
  // 注入死图到 posts.images（sync 不跑则不会被覆盖）
  const db = new DatabaseSync('data/feed.db');
  const post = db.prepare('SELECT images FROM posts WHERE id = ?').get(POST_ID);
  const list = JSON.parse(post.images);
  const deadKey = normalizeImageUrl(DEAD_URL); // 与生产路径一致：posts.images 经规范化
  if (!list.includes(deadKey)) {
    db.prepare('UPDATE posts SET images = ? WHERE id = ?').run(JSON.stringify([...list, deadKey]), POST_ID);
  }
  db.close();

  // 场景 1：首次失败 → attempts=1，仍在队列（待重试）
  await saveOcrFailure(DEAD_URL, POST_ID, '模拟失败 1');
  console.log('失败1次：在队列(待重试) =', inQueue());

  // 场景 2：失败到上限 3 次 → 放弃，不在队列
  await saveOcrFailure(DEAD_URL, POST_ID, '模拟失败 2');
  await saveOcrFailure(DEAD_URL, POST_ID, '模拟失败 3');
  const db2 = new DatabaseSync('data/feed.db', { readOnly: true });
  console.log('3次后记录：', JSON.stringify(db2.prepare("SELECT status, attempts, last_error FROM ocr_records WHERE image_url LIKE '%__test_dead__%'").get()));
  db2.close();
  console.log('3次后：已放弃(不在队列) =', !inQueue());

  // 场景 3：后来识别成功 → 转正 ok，attempts 保留历史，loadOcrTexts 可取
  await saveOcrRecord(DEAD_URL, POST_ID, '测试OCR文本');
  const db3 = new DatabaseSync('data/feed.db', { readOnly: true });
  console.log('转正后记录：', JSON.stringify(db3.prepare("SELECT status, attempts FROM ocr_records WHERE image_url LIKE '%__test_dead__%'").get()));
  db3.close();
  console.log('转正后不在队列 =', !inQueue(), '；loadOcrTexts 含文本 =', (await loadOcrTexts(POST_ID)).includes('测试OCR文本'));
} else if (process.argv[2] === 'cleanup') {
  const db = new DatabaseSync('data/feed.db');
  const post = db.prepare('SELECT images FROM posts WHERE id = ?').get(POST_ID);
  db.prepare('UPDATE posts SET images = ? WHERE id = ?')
    .run(JSON.stringify(JSON.parse(post.images).filter((u) => !u.includes('__test_dead__'))), POST_ID);
  db.prepare("DELETE FROM ocr_records WHERE image_url LIKE '%__test_dead__%'").run();
  db.close();
  console.log('测试数据已清理');
} else {
  console.log('用法：node test_retry.mjs run|cleanup');
}
