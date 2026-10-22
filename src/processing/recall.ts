import * as jieba from 'jieba-node';
import { normalizeCanonicalName } from '../core/types.js';
import { listEntriesByGame, type StoredEntry } from '../storage/store.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('recall');

/**
 * 跨动态召回（搜索机制）：从同一游戏的既有条目中挑出与本条动态最相关的候选，
 * 供 LLM 判定「是否同一现实活动」并复用其 id，避免同一活动重复生成条目。
 *
 * 链路：jieba 分词（含自举词典）→ 字段加权 BM25 打分 → 按规范名归组去重 → 截断。
 *
 * 设计约束：
 * - 召回只用确定性算法，不额外调用 LLM（额度成本）。
 * - 候选条目必须来自 entries 表本身，不引入第二份真相。
 * - 归一化只用于归组与 id 生成，展示保留 LLM 原始命名。
 */

/** 候选归组上限：多活动长图（一张前瞻图含十余个活动）需要更大候选池；每组可能含多条历史重复条目 */
const MAX_CANDIDATES = 40;
/** 字段权重：canonicalName 是活动身份的唯一稳定载体，命中它比命中描述更有判别力 */
const FIELD_WEIGHT: Record<'canonicalName' | 'title' | 'summary' | 'tags', number> = {
  canonicalName: 3,
  title: 2,
  summary: 1,
  tags: 1,
};
/** BM25 标准参数 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 通用词停用表：这些词在任何活动描述里都会出现，不参与查询 */
const STOP_WORDS = new Set([
  '活动', '限时', '版本', '开启', '期间', '说明', '奖励', '时间', '登录', '参与', '任务',
  '领取', '完成', '管理员', '明日方舟', '终末地', '方舟', '今日', '本次', '以上', '以下',
  '进行', '获得', '可获', '详情', '点击', '查看', '关注', '转发', '抽奖', '恭喜', '同学',
  '通知', '私信', '正式', '上线', '更新', '内容', '系统', '游戏', '玩家', '即日起', '敬请',
  '期待', '现已', '即将', '开始', '结束', '开放', '推出', '新增', '支持', '使用', '需要',
  '可以', '以及', '还有', '如果', '通过', '关于', '相关', '包括', '提供', '进入', '选择',
  '前往', '购买', '兑换', '累计', '每日', '指定', '阶段', '第一', '第二',
]);

/** 候选组：同一规范名的多条历史条目合并为一条候选，id 列表供 LLM 指定 */
export interface RecallCandidate {
  /** 组内得分最高条目的 id，作为匹配目标 */
  entryId: string;
  /** 同组全部条目 id（历史重复条目会归到同一组） */
  entryIds: string[];
  type: string;
  canonicalName: string;
  title: string;
  startAt?: number;
  endAt?: number;
}

let tokenizerReady = false;
let tokenizer: jieba.Tokenizer | null = null;
/** 已写入 jieba 用户词典的词，避免重复写入 */
const knownWords = new Set<string>();

/** 初始化分词器（jieba 词典加载约 0.4s，进程内只做一次） */
function ensureTokenizer(): jieba.Tokenizer {
  if (!tokenizer || !tokenizerReady) {
    jieba.setLogLevel('SILENT');
    jieba.initialize();
    tokenizer = jieba.createTokenizer();
    tokenizerReady = true;
  }
  return tokenizer;
}

/** 去标点：词典与匹配都按纯文字处理，避免「·」「，」造成的变体 */
function stripPunct(s: string | undefined): string {
  return (s ?? '').replace(/[，。！？、；：“”‘’（）《》「」『』【】·—…~#\s/\\|]+/g, '');
}

/**
 * 自举词典：把条目规范名与标题整串、及其搜索模式切出的片段写入用户词典。
 * 目的：专有名词（汉堡王、丹青渡、祀的画）不被切成泛词，保证召回时能整词命中。
 */
function syncLexicon(entries: StoredEntry[], tk: jieba.Tokenizer): void {
  const additions: string[] = [];
  for (const e of entries) {
    for (const raw of [e.payload.canonicalName, e.title]) {
      const s = stripPunct(raw);
      if (s.length >= 3) additions.push(s);
    }
  }
  // 二次切分：整串入典后仍可能因标点/措辞差异无法互相命中，补入片段词
  const fragments: string[] = [];
  for (const w of additions) {
    for (const t of tk.lcutForSearch(w)) {
      const s = t.trim();
      if (s.length >= 2) fragments.push(s);
    }
  }
  for (const w of [...additions, ...fragments]) {
    if (knownWords.has(w)) continue;
    tk.addWord(w, 100000);
    knownWords.add(w);
  }
}

/** 分词：只保留中英文数字组成的 ≥2 字词，剔除纯数字与停用词 */
function tokenize(text: string, tk: jieba.Tokenizer): string[] {
  const out: string[] = [];
  for (const raw of tk.lcutForSearch(text ?? '')) {
    const w = raw.trim();
    if (w.length < 2) continue;
    if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (STOP_WORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** 文档侧词频（字段加权后），用于 BM25 */
interface Doc {
  entry: StoredEntry;
  tf: Map<string, number>;
  len: number;
}

/**
 * 召回候选：输入游戏 id 与本条动态的全文（标题 + 正文 + OCR），返回按相关度排序的候选组。
 * 候选为空时返回空数组（调用方不带候选段），不影响新游戏首跑。
 */
export async function recallCandidates(gameId: string, text: string): Promise<RecallCandidate[]> {
  const entries = await listEntriesByGame(gameId);
  if (entries.length === 0) return [];

  const tk = ensureTokenizer();
  syncLexicon(entries, tk);

  const docs: Doc[] = entries.map((entry) => {
    const p = entry.payload;
    const tf = new Map<string, number>();
    let len = 0;
    const fields: [keyof typeof FIELD_WEIGHT, string][] = [
      ['canonicalName', p.canonicalName ?? ''],
      ['title', entry.title ?? ''],
      ['summary', p.summary ?? ''],
      ['tags', (p.tags ?? []).join(' ')],
    ];
    for (const [field, value] of fields) {
      const weight = FIELD_WEIGHT[field];
      for (const t of tokenize(value, tk)) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
        len += weight;
      }
    }
    return { entry, tf, len };
  });

  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  // 专名词表：在 ≥2 个不同条目的规范名中出现过的词，说明它是活动名的一部分
  const nameHits = new Map<string, number>();
  for (const d of docs) {
    const name = d.entry.payload.canonicalName;
    if (!name) continue;
    for (const t of new Set(tokenize(name, tk))) nameHits.set(t, (nameHits.get(t) ?? 0) + 1);
  }

  const toks = tokenize(text, tk);
  const tfText = new Map<string, number>();
  for (const t of toks) tfText.set(t, (tfText.get(t) ?? 0) + 1);
  const queryTerms = [...new Set(toks)]
    .filter((t) => df.has(t))
    .sort((a, b) => {
      const w = (t: string): number => tfText.get(t)! * idf(t) * t.length * ((nameHits.get(t) ?? 0) >= 2 ? 2 : 1);
      return w(b) - w(a);
    });
  if (queryTerms.length === 0) return [];

  const score = (d: Doc): number => {
    let s = 0;
    for (const t of queryTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / avgLen)));
    }
    return s;
  };

  const ranked = docs
    .map((d) => ({ d, s: score(d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  // 归组：规范名归一化后相同（旧条目无规范名时退回标题归一化）视为同一候选
  const groups = new Map<string, RecallCandidate>();
  for (const { d } of ranked) {
    const p = d.entry.payload;
    const key = normalizeCanonicalName(p.canonicalName || '') || normalizeCanonicalName(d.entry.title);
    const existing = groups.get(key);
    if (existing) {
      existing.entryIds.push(d.entry.id);
      continue;
    }
    if (groups.size >= MAX_CANDIDATES) break;
    groups.set(key, {
      entryId: d.entry.id,
      entryIds: [d.entry.id],
      type: d.entry.type,
      canonicalName: p.canonicalName || d.entry.title,
      title: d.entry.title,
      startAt: d.entry.startAt,
      endAt: d.entry.endAt,
    });
  }

  const out = [...groups.values()];
  log.debug('召回 gameId=%s 条目=%d 查询词=%d 候选组=%d', gameId, N, queryTerms.length, out.length);
  return out;
}

