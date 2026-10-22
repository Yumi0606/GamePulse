/**
 * 批量重跑某游戏动态的结构化（真实 LLM），前后各导出一份快照。
 * 属于高消耗操作：默认只打印影响范围，必须显式加 --yes 才执行。
 *
 * 用法：
 *   node _research/llm_probe/run_game.mjs <gameId> [--limit 10] [--from 2026-10-01] [--out 目录] [--yes]
 *
 * 说明：
 *   --limit  只跑最新的 N 条（默认全部）。
 *   --from   只跑该日期（北京时间）之后发布的动态。
 *   --out    快照与日志输出目录，默认系统临时目录（不留存在仓库内）。
 *   前置快照已存在时不覆盖，便于分批执行后仍保留原始对照。
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractOnePost } from '../../dist/processing/extract.js';
import { loadEntries } from '../../dist/storage/store.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const gameId = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
const limit = flag('limit') ? Number(flag('limit')) : undefined;
const from = flag('from');
const outDir = flag('out') ?? path.join(os.tmpdir(), `gamepulse-review-${gameId}`);
const yes = args.includes('--yes');

if (!gameId) {
  console.error('用法：node run_game.mjs <gameId> [--limit N] [--from YYYY-MM-DD] [--out 目录] [--yes]');
  process.exit(1);
}

const fmt = (ts) =>
  ts == null ? '—' : new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const db = new DatabaseSync('data/feed.db');

/** 目标动态：按发布时间升序，可限制条数与起始日期 */
function targetPosts() {
  const where = ['game_id = ?'];
  const params = [gameId];
  if (from) {
    const ts = Math.floor(Date.parse(`${from}T00:00:00+08:00`) / 1000);
    if (Number.isNaN(ts)) {
      console.error(`--from 日期无法解析：${from}`);
      process.exit(1);
    }
    where.push('published_at >= ?');
    params.push(ts);
  }
  const order = limit ? 'DESC' : 'ASC';
  const sql = `SELECT id, title, published_at, extracted_at, images FROM posts
               WHERE ${where.join(' AND ')} ORDER BY published_at ${order}${limit ? ' LIMIT ?' : ''}`;
  const rows = db.prepare(sql).all(...params, ...(limit ? [limit] : []));
  return limit ? rows.reverse() : rows;
}

const posts = targetPosts();
if (posts.length === 0) {
  console.log('无匹配动态');
  process.exit(0);
}

console.log(`目标游戏: ${gameId}`);
console.log(`影响范围: ${posts.length} 条动态，预计 ${posts.length} 次 LLM 调用`);
console.log(`输出目录: ${outDir}`);
for (const p of posts) console.log(`  ${p.id} | ${fmt(p.published_at)} | ${(p.title ?? '').slice(0, 50)}`);
if (!yes) {
  console.log('\n未执行。确认后加 --yes 重跑。');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const prePath = path.join(outDir, `${gameId}_pre.md`);
const postPath = path.join(outDir, `${gameId}_post.md`);
const logPath = path.join(outDir, `${gameId}_run.log`);

/** 快照：动态清单 + 全部条目（含来源与规范名） */
async function snapshot(target) {
  const entries = (await loadEntries()).filter((e) => e.gameId === gameId);
  const lines = [`# ${gameId} 快照（${fmt(Math.floor(Date.now() / 1000))}）`, ''];
  lines.push(`动态 ${posts.length} 条，条目 ${entries.length} 条`, '');
  lines.push('## 条目对照', '| id | type | canonicalName | title | 来源数 | 来源 postIds | start | end |', '|---|---|---|---|---|---|---|---|');
  const sorted = [...entries].sort(
    (a, b) => a.type.localeCompare(b.type) || (a.payload.canonicalName ?? '').localeCompare(b.payload.canonicalName ?? ''),
  );
  for (const e of sorted) {
    const ids = e.payload.extra?.postIds ?? (e.postId ? [e.postId] : []);
    lines.push(`| ${e.id} | ${e.type} | ${e.payload.canonicalName ?? '（空）'} | ${e.title} | ${ids.length} | ${ids.join('<br>')} | ${fmt(e.startAt)} | ${fmt(e.endAt)} |`);
  }
  lines.push('', '## 动态清单', '| post id | 时间 | 图 | 已结构化 | 标题 |', '|---|---|---|---|---|');
  for (const p of posts) {
    const imgs = p.images ? JSON.parse(p.images).length : 0;
    lines.push(`| ${p.id} | ${fmt(p.published_at)} | ${imgs} | ${p.extracted_at ? '是' : '否'} | ${p.title} |`);
  }
  writeFileSync(target, lines.join('\n'), 'utf8');
}

if (existsSync(prePath)) console.log(`前置快照已存在，保留原文件：${prePath}`);
else {
  await snapshot(prePath);
  console.log(`已导出前置快照：${prePath}`);
}

writeFileSync(logPath, `# ${gameId} 重跑日志\n`, 'utf8');
const counts = { processed: 0, skipped: 0, failed: 0, entries: 0 };
let i = 0;
for (const p of posts) {
  i++;
  const t0 = Date.now();
  let line;
  try {
    const r = await extractOnePost({ postId: p.id, save: true });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    counts.entries += r.entries.length;
    line = `[${i}/${posts.length}] ${p.id} ${r.status} entries=${r.entries.length} ${Date.now() - t0}ms`;
  } catch (err) {
    counts.failed += 1;
    line = `[${i}/${posts.length}] ${p.id} failed ${err.message}`;
  }
  console.log(line);
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

await snapshot(postPath);
console.log(`\n完成：processed=${counts.processed} skipped=${counts.skipped} failed=${counts.failed} 产出条数=${counts.entries}`);
console.log(`后置快照：${postPath}\n日志：${logPath}`);
