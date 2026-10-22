/**
 * 离线检查条目重复：统计规范化规范名完全相同的分组、标题互相包含的疑似重复、
 * 以及多来源条目与无来源条目的分布。
 * 用法：node _research/llm_probe/db_dup.mjs [gameId]（省略则统计全部游戏）
 */
import { loadEntries } from '../../dist/storage/store.js';
import { normalizeCanonicalName } from '../../dist/core/types.js';

const gameId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const all = await loadEntries();
const entries = gameId ? all.filter((e) => e.gameId === gameId) : all;
const scope = gameId ?? '全部游戏';
console.log(`${scope}：条目 ${entries.length} 条`);

const srcOf = (e) => e.payload.extra?.postIds ?? (e.postId ? [e.postId] : []);

// 1. 完全同名（归一后 canonicalName 相同）——撞车收敛后应恒为 0
const groups = new Map();
for (const e of entries) {
  const key = `${e.gameId}|${e.type}|${normalizeCanonicalName(e.payload.canonicalName || e.title)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
const exact = [...groups.values()].filter((g) => g.length > 1);
console.log(`\n## 完全同名组（应为 0）：${exact.length}`);
for (const g of exact) {
  console.log(`- [${g[0].gameId}/${g[0].type}] ${g[0].payload.canonicalName}`);
  for (const e of g) console.log(`    ${e.id} 来源=${srcOf(e).length} title=${e.title}`);
}

// 2. 标题互相包含（语义重复的弱信号，需人工判断）
const dup = [];
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i];
    const b = entries[j];
    if (a.gameId !== b.gameId || a.type !== b.type) continue;
    const ta = normalizeCanonicalName(a.payload.canonicalName || a.title);
    const tb = normalizeCanonicalName(b.payload.canonicalName || b.title);
    if (ta.length < 3 || tb.length < 3) continue;
    if (ta.includes(tb) || tb.includes(ta)) {
      dup.push(`- [${a.gameId}/${a.type}] ${a.payload.canonicalName ?? a.title}  <->  ${b.payload.canonicalName ?? b.title}\n    ${a.id} | ${b.id}`);
    }
  }
}
console.log(`\n## 标题互相包含的疑似重复：${dup.length}`);
console.log(dup.join('\n'));

// 3. 来源分布
const multi = entries.filter((e) => srcOf(e).length > 1);
const orphans = entries.filter((e) => srcOf(e).length === 0);
console.log(`\n## 多来源条目：${multi.length} / ${entries.length}`);
console.log(`## 无来源条目：${orphans.length}`);
for (const e of orphans.slice(0, 10)) console.log(`- ${e.id} ${e.title}`);
