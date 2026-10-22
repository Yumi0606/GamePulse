/**
 * 单条 / 少量动态的真实 LLM 结构化（默认 dry-run，不写库）。
 * 合并了旧的 test_one / verify_posts / run_extract_one。
 *
 * 用法：
 *   node _research/llm_probe/run_one.mjs --post <postId> [--post <postId2>] [--context] [--system] [--raw]
 *   node _research/llm_probe/run_one.mjs --post <postId> --save
 *   node _research/llm_probe/run_one.mjs --game endfield --title 关键词 [--context]
 *
 * 说明：
 *   --context  打印完整喂给 LLM 的上下文（仅单条时有效）。
 *   --system   打印送入 LLM 的 system prompt（含召回候选表），审计召回与匹配用。
 *   --raw      打印 LLM 原始 JSON 输出，审计规整前的 matchedEntryId / canonicalName。
 *   --save     结果入库（默认 dry-run，不消耗幂等状态）。
 * 需先 pnpm build，并在 .env 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
 */
import { extractOnePost } from '../../dist/processing/extract.js';
import { loadEntries } from '../../dist/storage/store.js';
import { llmConfig } from '../../dist/processing/llm.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

/** 取全部 --post 值（可重复） */
const postIds = args.reduce((acc, a, i) => {
  if (a === '--post' && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);
const gameId = flag('game');
const titleLike = flag('title');
const save = has('save');
const showContext = has('context');
/** 审计用：打印送入 LLM 的 system prompt（含候选表）与原始 JSON 输出 */
const showSystem = has('system');
const showRaw = has('raw');

if (postIds.length === 0 && !(gameId && titleLike)) {
  console.error('用法：node run_one.mjs --post <postId> [--post ...] [--save] [--context]');
  console.error('   或：node run_one.mjs --game <gameId> --title <关键词> [--save] [--context]');
  process.exit(1);
}

const fmt = (u) => (u ? new Date(u * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—');
console.log(`LLM 配置: ${llmConfig() || '(未配置)'}`);
console.log(`模式: ${save ? '落库' : 'dry-run'} 目标数: ${postIds.length || 1}\n`);

const targets = postIds.length > 0 ? postIds : [undefined];
for (const postId of targets) {
  const r = await extractOnePost(postId ? { postId, save } : { gameId, titleLike, save });
  if (r.status === 'not_found') {
    console.error(`未匹配到动态${postId ? `：${postId}` : `（${gameId} / ${titleLike}）`}`);
    continue;
  }
  if (r.status === 'llm_disabled') {
    console.error('LLM 未配置：复制 .env.example 为 .env，填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。');
    process.exit(1);
  }

  console.log(`\n===== ${postId ?? `${gameId} / ${titleLike}`} [${r.status}] =====`);
  if (showContext && r.user) {
    console.log('---------- 喂给 LLM 的上下文 ----------');
    console.log(r.user);
    console.log('---------------------------------------');
  }
  if (showSystem && r.system) {
    console.log('---------- 送入 LLM 的 system prompt ----------');
    console.log(r.system);
    console.log('-----------------------------------------------');
  }
  if (showRaw && r.raw) {
    console.log('---------- LLM 原始输出 ----------');
    console.log(JSON.stringify(r.raw, null, 2));
    console.log('----------------------------------');
  }
  if (r.entries.length === 0) {
    console.log('(无条目：LLM 判定无排期信息，或正文与 OCR 均为空)');
    continue;
  }

  for (const e of r.entries) {
    const p = e.payload;
    const src = p.extra?.postIds ?? (e.postId ? [e.postId] : []);
    console.log(`[${e.type}] ${e.title}`);
    console.log(`  id=${e.id}  canonical=${p.canonicalName ?? '—'}  category=${p.category ?? '—'}`);
    console.log(`  时间=${fmt(e.startAt)} → ${fmt(e.endAt)}  estimated=${p.estimated ?? false} conf=${p.confidence ?? '—'}`);
    if (p.startRef || p.endRef) console.log(`  ref=${p.startRef?.refText ?? '—'} ~ ${p.endRef?.refText ?? '—'}`);
    if (p.phases?.length) {
      for (const ph of p.phases) {
        const ref = ph.startRef || ph.endRef ? ` [${ph.startRef?.refText ?? ''}~${ph.endRef?.refText ?? ''}]` : '';
        console.log(`    段#${ph.index} ${ph.title ?? ''}: ${fmt(ph.startAt)} → ${fmt(ph.endAt)}${ref}${ph.estimated ? ' (预估)' : ''}`);
      }
    }
    if (src.length > 1) console.log(`  postIds=${JSON.stringify(src)}`);
    const merge = p.provenance?.find((x) => x.method === 'merge-id')?.evidence;
    if (merge) console.log(`  merge=${merge}`);
    for (const prov of p.provenance ?? []) console.log(`  溯源: [${prov.method}] ${prov.fields.join(',')} ← ${(prov.evidence ?? '').slice(0, 60)}`);
  }
  console.log(`共 ${r.entries.length} 条${save ? '（已入库）' : '（dry-run 未入库，加 --save 落库）'}`);

  if (save && postId) {
    const related = (await loadEntries()).filter((e) => (e.payload.extra?.postIds ?? []).includes(postId));
    console.log(`\n库中关联本动态的条目 ${related.length} 条：`);
    for (const e of related) {
      console.log(`- ${e.id} | 来源数=${(e.payload.extra?.postIds ?? []).length} | canonical=${e.payload.canonicalName}`);
    }
  }
}
