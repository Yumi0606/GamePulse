/** 单条动态 LLM 结构化测试（dry-run，不写库、不消耗幂等状态）。
 * 用法：
 *   node _research/llm_probe/test_one.mjs                      # 三角洲 9月30日更新公告
 *   node _research/llm_probe/test_one.mjs --save               # 结果真正入库
 *   node _research/llm_probe/test_one.mjs --game arkplots --title "联动"  # 自定义过滤
 *
 * 需先 pnpm build，并在 .env 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
 */

import { extractOnePost } from '../../dist/extract.js';
import { llmConfig } from '../../dist/llm.js';

// 解析命令行参数：--save / --game xxx / --title xxx / --post xxx
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const opts = {
  gameId: flag('game') ?? 'delta-force',
  titleLike: flag('title') ?? '9月30日更新公告',
  postId: flag('post'),
  save: args.includes('--save'),
};

console.log(`LLM 配置: ${llmConfig() || '(未配置)'}`);
console.log(`过滤条件: gameId=${opts.gameId} titleLike=${opts.titleLike} save=${opts.save}\n`);

const r = await extractOnePost(opts);

if (r.status === 'not_found') {
  console.error('未匹配到动态，先到 Web 页确认标题关键词。');
  process.exit(1);
}
if (r.status === 'llm_disabled') {
  console.error('LLM 未配置：复制 .env.example 为 .env，填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。');
  process.exit(1);
}

// 展示喂给 LLM 的完整上下文（正文 + 各图 OCR），便于人工核对输入质量
console.log('========== 喂给 LLM 的上下文 ==========');
console.log(r.user);
console.log('\n========== 规整后的条目 ==========');
if (r.entries.length === 0) {
  console.log('(无条目产出 —— 可能被预过滤跳过或 LLM 判定无排期信息)');
  console.log(`status=${r.status}`);
} else {
  for (const e of r.entries) {
    const fmt = (u) => (u ? new Date(u * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—');
    console.log(`\n[${e.type}] ${e.title}`);
    console.log(`  id: ${e.id}`);
    console.log(`  时间: ${fmt(e.startAt)} → ${fmt(e.endAt)}`);
    const p = e.payload;
    if (p.summary) console.log(`  简述: ${p.summary}`);
    if (p.description) console.log(`  详述: ${p.description}`);
    if (p.category) console.log(`  子类: ${p.category}`);
    if (p.banner) console.log(`  主图: ${p.banner.url}`);
    if (p.tags?.length) console.log(`  标签: ${p.tags.join(' / ')}`);
    if (p.startRef) console.log(`  startRef: ${p.startRef.refText} (${p.startRef.state})`);
    if (p.endRef) console.log(`  endRef: ${p.endRef.refText} (${p.endRef.state})`);
    if (p.rewardEndAt) console.log(`  奖励截止: ${fmt(p.rewardEndAt)}`);
    if (p.phases?.length) {
      console.log('  分段:');
      for (const ph of p.phases) {
        const ref = (r) => (r ? ` [${r.refText}${r.state !== 'unanchored' ? '/' + r.state : ''}]` : '');
        console.log(`    #${ph.index} ${ph.title ?? ''}: ${fmt(ph.startAt)} → ${fmt(ph.endAt)}${ref(ph.startRef)}${ref(ph.endRef)}${ph.estimated ? ' (预估)' : ''}`);
      }
    }
    console.log(`  estimated=${p.estimated ?? false} confidence=${p.confidence}`);
    for (const prov of p.provenance) console.log(`  溯源: [${prov.method}] ${prov.fields.join(',')} ← ${prov.evidence?.slice(0, 60)}`);
  }
  console.log(`\n共 ${r.entries.length} 条${opts.save ? '，已入库' : '（dry-run 未入库，加 --save 落库）'}`);
}
