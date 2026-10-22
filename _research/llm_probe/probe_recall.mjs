/**
 * 召回诊断（离线）：查看某条动态的召回候选，并标注指定关键词命中情况。
 * 用于判断「活动未合并」是召回缺失还是 LLM 未匹配。
 *
 * 用法：
 *   node _research/llm_probe/probe_recall.mjs <postId 或片段> [--keyword 烟火生缘] [--top 40]
 *
 * 默认关键词取动态正文中的「」引号内容；游戏 id 从 postId 前缀推导。
 */
import { DatabaseSync } from 'node:sqlite';
import { recallCandidates } from '../../dist/processing/recall.js';
import { loadOcrTexts } from '../../dist/storage/store.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const tail = args[0];
if (!tail) {
  console.error('用法：node probe_recall.mjs <postId 或片段> [--keyword 关键词] [--top 40]');
  process.exit(1);
}

const db = new DatabaseSync('data/feed.db', { readOnly: true });
const row = db
  .prepare('SELECT id, game_id, title, description FROM posts WHERE id LIKE ?')
  .get(`%${tail}%`);
if (!row) {
  console.error(`动态不存在：${tail}`);
  process.exit(1);
}

const keyword = flag('keyword') ?? (row.title?.match(/「([^」]{2,20})」/)?.[1] ?? '');
const top = Number(flag('top', 40));
const ocr = await loadOcrTexts(row.id);
const text = [row.title, row.description ?? '', ...ocr].join('\n');
const cands = await recallCandidates(row.game_id, text);

console.log(`动态: ${row.id}`);
console.log(`游戏: ${row.game_id}  文本长度=${text.length}  OCR 段=${ocr.length}`);
console.log(`候选组: ${cands.length}（按相关度排序，上限 ${top}）\n`);
cands.slice(0, top).forEach((c, i) => {
  const tag = keyword && (c.canonicalName + c.title).includes(keyword) ? '  ← 命中' : '';
  console.log(`#${i + 1} [${c.type}] ${c.canonicalName} | 组内 ${c.entryIds.length} 条 | ${c.entryIds.slice(0, 3).join(', ')}${tag}`);
});
if (keyword) {
  const hits = cands.filter((c) => (c.canonicalName + c.title).includes(keyword));
  console.log(`\n关键词「${keyword}」命中 ${hits.length} 组${hits.length === 0 ? '（召回缺失）' : ''}`);
}
