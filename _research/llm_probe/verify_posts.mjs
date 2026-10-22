/**
 * 批量动态 LLM 结构化回归验证（dry-run，不写库、不消耗幂等状态）。
 * 用途：改 Prompt / 游戏规则后，对一组 postId 快速核对类型、规范名、子类与时间。
 * 单条详查（含完整喂给 LLM 的上下文）用 test_one.mjs。
 *
 * 用法：
 *   node verify_posts.mjs <postId> [postId ...]
 *   DB_PATH=/path/to/feed.db node verify_posts.mjs <postId>
 * 需先 pnpm build，并在 .env 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
 */
import '../../dist/core/env.js';
import { extractOnePost } from '../../dist/processing/extract.js';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('用法：node verify_posts.mjs <postId> [postId ...]');
  process.exit(1);
}

for (const postId of ids) {
  const r = await extractOnePost({ postId });
  console.log(`\n===== ${postId}  [${r.status}] =====`);
  if (r.status !== 'processed' && r.status !== 'skipped') {
    console.log('  异常/未找到');
    continue;
  }
  if (!r.entries.length) {
    console.log('  (无条目：预过滤或 LLM 判定不收)');
    continue;
  }
  for (const e of r.entries) {
    const fmt = (u) => (u
      ? new Date(u * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '—');
    console.log(`  [${e.type}] ${e.title}`);
    console.log(`    canonical: ${e.payload.canonicalName ?? '-'}`);
    console.log(`    category : ${e.payload.category ?? '-'}`);
    console.log(`    时间     : ${fmt(e.startAt)} → ${fmt(e.endAt)}  est=${e.payload.estimated ?? false} conf=${e.payload.confidence}`);
    if (e.payload.startRef || e.payload.endRef) {
      console.log(`    ref      : ${e.payload.startRef?.refText ?? '-'} ~ ${e.payload.endRef?.refText ?? '-'}`);
    }
  }
}
