/**
 * 一次性生命周期回填脚本（不调用 LLM，可重复执行）。
 *
 * 用法：
 *   node _research/lifecycle_backfill.mjs            # 干跑：打印分布与样例，不写库
 *   node _research/lifecycle_backfill.mjs --apply    # 先 VACUUM INTO 快照，再写入
 *
 * 规则与 `apps/server/src/processing/extract.ts` 的 resolveLifecycle 保持一致，
 * 顺序即优先级（见 SPEC §6.2）：
 *   1. type = ANNOUNCEMENT → NULL（不适用）
 *   2. 有 end_at → limited
 *   3. 有 endRef → limited（不得 permanent）
 *   4. 标题明确写「限时」→ limited（结束时间未知；分类里的「限时」不作依据）
 *   5. 标题同时含「常驻」与更新类词 → event（一次性更新优先于常驻）
 *   6. 标题或 category 含更新类用词 → event（优先于「常驻」，
 *      避免「常驻【标准寻访】更新」「常驻模式奖励轮换」被误判为永久）
 *   7. 标题或 category 含「常驻」→ permanent
 *   8. 仍无依据 → NULL
 *
 * 只填充 lifecycle IS NULL 的行，不覆盖已经由 LLM 或人工确定的值；
 * 因此重复执行是幂等的。公告永远不写。
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'feed.db');
const apply = process.argv.includes('--apply');

const PERMANENT_RE = /常驻/;
const LIMITED_RE = /限时/;
const EVENT_RE = /更新|拓展|修复|新增|记录|轮换|上新/;

/** 与线上代码一致的单条判定；lifecycle 已确定的行不参与 */
function resolveLifecycle(row) {
  if (row.type === 'ANNOUNCEMENT') return null;
  if (row.end_at !== null && row.end_at !== undefined) return 'limited';
  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  const endRef = payload.endRef;
  if (typeof endRef === 'string' ? endRef.trim() : endRef?.refText?.trim()) return 'limited';
  const text = `${row.title}\n${payload.category ?? ''}`;
  // 分类由 LLM 生成，出现过「全新模式上线」被判为「限时玩法」的错例，只认标题
  if (LIMITED_RE.test(row.title)) return 'limited';
  if (EVENT_RE.test(text)) return 'event';
  if (PERMANENT_RE.test(text)) return 'permanent';
  return null;
}

if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

// 旧库可能还没有 lifecycle 列：脚本自带一次幂等迁移，保证可独立运行
const columns = db.prepare('PRAGMA table_info(entries)').all();
if (!columns.some((c) => c.name === 'lifecycle')) {
  db.exec('ALTER TABLE entries ADD COLUMN lifecycle TEXT');
  console.log('已补 entries.lifecycle 列');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_entries_lifecycle ON entries(lifecycle, end_at)');

// 写库前先落一致性快照：VACUUM INTO 会包含 WAL 中尚未合并的内容
let backupPath = null;
if (apply) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  backupPath = path.join(root, 'data', 'feed.db.lifecycle-bak-' + stamp);
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`已生成快照：${backupPath}`);
}

const rows = db.prepare('SELECT id, type, title, lifecycle, end_at, payload FROM entries').all();

const before = { limited: 0, permanent: 0, event: 0, null: 0, announcement: 0 };
const planned = { limited: 0, permanent: 0, event: 0, null: 0 };
const samples = { limited: [], permanent: [], event: [], null: [] };

for (const row of rows) {
  if (row.type === 'ANNOUNCEMENT') {
    before.announcement += 1;
    continue;
  }
  if (row.lifecycle === 'limited' || row.lifecycle === 'permanent' || row.lifecycle === 'event') {
    before[row.lifecycle] += 1;
    continue;
  }
  before.null += 1;

  const next = resolveLifecycle(row);
  const key = next ?? 'null';
  planned[key] += 1;
  if (samples[key].length < 5) {
    let category = '';
    try {
      category = JSON.parse(row.payload).category ?? '';
    } catch {
      category = '';
    }
    samples[key].push(`${row.id} | ${row.title} | category=${category || '-'}`);
  }
  if (apply && next) {
    db.prepare('UPDATE entries SET lifecycle = ? WHERE id = ? AND lifecycle IS NULL').run(next, row.id);
  }
}

console.log('\n=== 现有分布 ===');
console.log(`条目总数：${rows.length}`);
console.log(
  `limited=${before.limited} permanent=${before.permanent} event=${before.event} 未判定=${before.null} 公告（不适用）=${before.announcement}`,
);
console.log('\n=== 回填计划 ===');
console.log(`limited=${planned.limited} permanent=${planned.permanent} event=${planned.event} 仍为未判定=${planned.null}`);
for (const key of ['limited', 'permanent', 'event', 'null']) {
  if (samples[key].length === 0) continue;
  console.log(`\n[${key}] 抽样：`);
  for (const line of samples[key]) console.log(`  ${line}`);
}

if (!apply) {
  console.log('\n干跑完成，未写库。确认后加 --apply 执行。');
} else {
  console.log(`\n已写入。写入前快照：${backupPath}`);
}
db.close();
