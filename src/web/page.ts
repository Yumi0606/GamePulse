import { GAMES } from '../core/games.js';
import { ENTRY_TYPE_LABEL, type EntryType } from '../core/types.js';
import type { FetchMeta, StoredPost, StoredEntry, StoredEvent, UnresolvedEventCount, OcrRecordView } from '../storage/store.js';

/**
 * 展示层页面渲染（纯函数，无 IO）：
 * - renderPage     列表视图：概览卡片 + 异常报告区 + 筛选行 + 结构化数据 + 原始动态（两个可折叠大类）
 * - renderCalendar 日历视图：按北京时间铺当月日历（开始/结束/奖励截止/进行中四态）
 * - renderHealth   源健康视图：源健康事件列表（拉取异常记录 + 自动恢复状态）
 *
 * 列表筛选用内联原生 JS 就地过滤（行上挂 data-* 属性，切换可见性），不刷新页面、不嵌入 JSON；
 * 每行标题右上方固定一个单条 RSS 链接，行内 <details> 原地展开"数据详情"（OCR 文本），无需额外 JS。
 */

/** 首页渲染所需的全部数据（server 装配后整体传入） */
export interface PageData {
  posts: StoredPost[];
  meta: FetchMeta | null;
  entries: StoredEntry[];
  unresolved: UnresolvedEventCount;
  /** 待结构化动态数（extracted_at 为空或落后于 updated_at） */
  pendingExtract: number;
  /** 尚未成功识别的图片数（去重图片 URL 中无 status='ok' 记录） */
  unrecognizedImages: number;
  /** 最近一条未恢复异常；无则为 null */
  latestEvent: StoredEvent | null;
  /** OCR 记录（按规范化图片 URL 索引） */
  ocr: Map<string, OcrRecordView>;
}

/** HTML 转义 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 格式化 Unix 秒为北京时间 "YYYY-MM-DD HH:mm"（游戏服务器时间=北京时间，固定时区不受部署环境影响） */
export function fmtCst(unix: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unix * 1000)).replace(/\//g, '-');
}

/** 北京时间 "YYYY-MM-DD"（日历月定位用） */
function fmtCstDate(unix: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unix * 1000));
}

/** 相对时间（几分钟前/几小时前/几天前）；超过 7 天回退绝对时间，未来时间同样回退绝对时间 */
export function fmtRelative(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 0) return fmtCst(unix);
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return fmtCst(unix);
}

/** 属性值文本：折叠空白并截断（避免正文过长撑爆 HTML），再转义 */
function attr(text: string | undefined, max = 500): string {
  if (!text) return '';
  return escapeHtml(text.slice(0, max).replace(/\s+/g, ' '));
}

/** 当前北京时间所在月 "YYYY-MM"（日历缺省月） */
function currentYm(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
}

/** 页面共享样式 */
const STYLE = `
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; border-left: 4px solid #f5712c; padding-left: 8px; margin-top: 28px; }
  h2 small { color: #888; font-weight: normal; }
  nav { margin: 8px 0 4px; font-size: 14px; }
  nav a { margin-right: 4px; }
  ul { list-style: none; padding: 0; }
  li { padding: 6px 0; border-bottom: 1px solid #f0f0f0; line-height: 1.6; }
  .date { display: inline-block; width: 250px; color: #888; font-size: 13px; font-variant-numeric: tabular-nums; }
  a { color: #1a5fb4; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .err { color: #c01c28; font-size: 13px; }
  .imgs { color: #888; font-size: 12px; }
  .tag { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 3px; background: #eef3fa; color: #1a5fb4; font-size: 12px; }
  .low-conf { color: #c01c28; font-size: 12px; }
  .est { color: #b58100; font-size: 12px; }
  .phases { margin: 2px 0 0 0; padding-left: 18px; font-size: 13px; color: #555; }
  .reward { color: #8a5a00; font-size: 13px; }
  .desc { margin-top: 2px; color: #444; font-size: 13px; }
  /* 日历视图 */
  table.cal { border-collapse: collapse; width: 100%; table-layout: fixed; }
  table.cal th { padding: 4px 0; font-size: 12px; color: #888; border-bottom: 1px solid #ddd; }
  table.cal td { border: 1px solid #eee; vertical-align: top; height: 84px; padding: 2px 4px; font-size: 12px; }
  td.today { background: #fff8ec; }
  td.pad { background: #fafafa; }
  .dnum { color: #888; font-size: 11px; }
  .ev { border-radius: 3px; padding: 0 4px; margin-top: 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ev.start { background: #e5f0e2; color: #1d6f2c; }
  .ev.end { background: #fbe7e9; color: #b0233a; }
  .ev.reward { background: #fff1d6; color: #8a5a00; }
  .ev.ongoing { background: #f0f0f0; color: #666; }
  .more { color: #888; }
  .calnav { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; }
  .calnav .cur { font-size: 16px; font-weight: 600; }
  .unanchored { color: #666; font-size: 13px; }
  /* 源异常通知与异常页 */
  .alert { background: #fbe7e9; color: #b0233a; padding: 8px 12px; border-radius: 4px; }
  .badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 3px; font-size: 12px; }
  .badge.bad { background: #fbe7e9; color: #b0233a; }
  .badge.ok { background: #e5f0e2; color: #1d6f2c; }
  .badge.cookie { background: #fff1d6; color: #8a5a00; }
  .detail { margin-top: 2px; padding: 6px 8px; background: #f6f6f6; border-radius: 4px; font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  /* 概览卡片 */
  .card { background: #f8f9fb; border: 1px solid #eceef2; border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
  .stats { display: flex; flex-wrap: wrap; gap: 28px; }
  .stat .num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .lbl { font-size: 12px; color: #888; }
  .sync { margin-top: 8px; font-size: 13px; color: #555; }
  .muted { color: #888; }
  /* 异常报告区 */
  .health { border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .health.bad { background: #fbe7e9; color: #b0233a; }
  .health.good { background: #eef7ee; color: #1d6f2c; }
  /* 筛选行 */
  .filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 10px 14px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; margin: 12px 0; }
  .filters label { font-size: 13px; color: #555; display: inline-flex; align-items: center; gap: 4px; }
  .filters select, .filters input { padding: 4px 6px; font-size: 13px; border: 1px solid #ccc; border-radius: 3px; }
  .filters input[type="search"] { width: 200px; }
  .filters button { padding: 4px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 3px; background: #fff; cursor: pointer; }
  .count-line { font-size: 13px; color: #666; margin: 6px 0; }
  /* 行内详情：原地展开；标题行右上角固定单条 RSS 链接 */
  li.hidden { display: none; }
  li[data-game] { position: relative; padding-right: 60px; }
  .rss-link { position: absolute; top: 6px; right: 0; font-size: 12px; }
  details { margin-top: 4px; }
  summary { cursor: pointer; font-size: 12px; color: #1a5fb4; }
  .sub { font-size: 12px; color: #888; margin: 6px 0 2px; }
  ul.ocrs { margin: 2px 0; }
  ul.ocrs li { border-bottom: 1px dashed #eee; }
  .ocr { margin-top: 2px; font-size: 12px; color: #444; white-space: pre-wrap; word-break: break-word; }
  /* 大类区块：可折叠（结构化数据 / 原始动态），summary 冒充标题 */
  details.section { margin-top: 26px; }
  details.section > summary { cursor: pointer; font-size: 16px; font-weight: bold; color: #222; border-left: 4px solid #f5712c; padding-left: 8px; }
  details.section > summary small { color: #888; font-weight: normal; }
`;

/** 页面骨架：导航（视图切换 + 源健康页 + 两类 RSS 入口）+ 正文 */
function layout(active: 'list' | 'calendar' | 'health', body: string): string {
  const navItem = (href: string, label: string, key: 'list' | 'calendar' | 'health') =>
    `<a href="${href}"${active === key ? ' style="font-weight:600"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>GamePulse · 游戏活动排期</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>GamePulse · 游戏活动排期</h1>
  <nav>
    ${navItem('/', '列表', 'list')} · ${navItem('/calendar', '日历', 'calendar')} · ${navItem('/health', '源健康', 'health')}
    ｜ RSS 订阅：<a href="/rss/posts">原始动态</a> · <a href="/rss/entries">结构化条目</a>
  </nav>
${body}
</body>
</html>
`;
}

/** OCR 区块：按动态图片顺序列出每张图的识别状态与文本（未识别 / 失败 / 已识别） */
function ocrBlock(images: string[] | undefined, ocr: Map<string, OcrRecordView>): string {
  if (!images || images.length === 0) return '<p class="muted">该动态无图片，无 OCR 文本。</p>';
  const rows = images.map((url, i) => {
    const rec = ocr.get(url);
    const badge = !rec
      ? '<span class="badge">未识别</span>'
      : rec.status === 'ok'
        ? '<span class="badge ok">已识别</span>'
        : '<span class="badge bad">识别失败</span>';
    const text = rec?.text ? `<div class="ocr">${escapeHtml(rec.text)}</div>` : '';
    return `<li><span class="tag">图 ${i + 1}</span>${badge}${text}</li>`;
  }).join('');
  return `<ul class="ocrs">${rows}</ul>`;
}

/**
 * 结构化条目单行：时间 + 大类标签 + 标题 + 置信/预估标注 + 引用型时间。
 * 行上挂 data-* 供内联脚本筛选；标题行右上角固定单条 RSS 链接；
 * <details> 原地展开"数据详情"（来源动态的 OCR 文本）。
 */
function entryRow(e: StoredEntry, postById: Map<string, StoredPost>, ocr: Map<string, OcrRecordView>): string {
  const fmt = (unix?: number): string => (unix ? fmtCst(unix) : '—');
  const gameName = GAMES.find((g) => g.id === e.gameId)?.name ?? e.gameId;
  const label = ENTRY_TYPE_LABEL[e.type as EntryType] ?? e.type;
  const est = e.payload.estimated ? ' <span class="est">预估</span>' : '';
  const conf = e.payload.confidence < 0.7 ? ` <span class="low-conf">置信 ${e.payload.confidence.toFixed(1)}</span>` : '';
  const startRef = e.payload.startRef ? `（始：${escapeHtml(e.payload.startRef.refText)}）` : '';
  const endRef = e.payload.endRef ? `（${escapeHtml(e.payload.endRef.refText)}）` : '';
  const reward = e.payload.rewardEndAt ? `<div class="reward">奖励截止 ${fmtCst(e.payload.rewardEndAt)}</div>` : '';
  // 活动说明：优先详情，缺失回退简述；此前仅进搜索文本未渲染，导致页面看不到描述
  const descText = e.payload.description ?? e.payload.summary;
  const desc = descText ? `<div class="desc">${escapeHtml(descText)}</div>` : '';
  const phases = e.payload.phases?.length
    ? `<ul class="phases">${e.payload.phases.map((p) => {
        const pf = (u?: number) => (u ? fmtCst(u) : '—');
        const ref = p.startRef ? `［${escapeHtml(p.startRef.refText)}］` : '';
        const refEnd = p.endRef ? `［${escapeHtml(p.endRef.refText)}］` : '';
        return `<li>#${p.index} ${escapeHtml(p.title ?? '')}：${pf(p.startAt)} → ${pf(p.endAt)}${ref}${refEnd}${p.estimated ? ' <span class="est">预估</span>' : ''}</li>`;
      }).join('')}</ul>`
    : '';

  // 筛选属性：游戏、关键词文本（游戏名+类型+标题+摘要+正文+分类）、起止日期（CST）
  const searchText = attr([gameName, label, e.title, e.payload.summary, e.payload.description, e.payload.category].filter(Boolean).join(' '), 600);
  const dStart = e.startAt !== undefined ? fmtCstDate(e.startAt) : '';
  const dEnd = e.endAt !== undefined ? fmtCstDate(e.endAt) : '';

  // 数据详情：来源动态的 OCR 文本；单条 RSS 链接固定在标题行右上角
  const srcPost = e.postId ? postById.get(e.postId) : undefined;
  const rssHref = `/rss/entry?id=${encodeURIComponent(e.id)}`;
  const detail = `<details><summary>数据详情</summary>
        <div class="sub">来源动态${srcPost ? `：${escapeHtml(srcPost.title)}` : '（无关联动态）'}</div>
        ${srcPost ? ocrBlock(srcPost.images, ocr) : '<p class="muted">无来源动态，无 OCR 文本。</p>'}
      </details>`;

  return `      <li data-game="${escapeHtml(e.gameId)}" data-type="${escapeHtml(e.type)}" data-start="${dStart}" data-end="${dEnd}" data-text="${searchText}"><a class="rss-link" href="${rssHref}">RSS</a><span class="date">${fmt(e.startAt)} → ${fmt(e.endAt)}${endRef}${startRef}</span><span class="tag">${label}</span>${escapeHtml(gameName)}：<a href="${escapeHtml(e.url ?? '#')}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>${est}${conf}${reward}${phases}${desc}${detail}</li>`;
}

/**
 * 原始动态单行：发布时间 + 标题（原文链接）+ 图片数。
 * 行上挂 data-* 供内联脚本筛选（时间口径为发布时间，起止同值）；
 * 标题行右上角固定单条 RSS 链接；<details> 原地展开"数据详情"（该动态全部图片的 OCR 文本）。
 */
function postRow(it: StoredPost, ocr: Map<string, OcrRecordView>): string {
  const gameName = GAMES.find((g) => g.id === it.gameId)?.name ?? it.gameId;
  const d = fmtCstDate(it.publishedAt);
  const searchText = attr([gameName, it.title, it.description, it.author].filter(Boolean).join(' '), 600);
  const tip = it.description ? escapeHtml(it.description.slice(0, 200)) : '';
  const imgs = it.images ? ` <span class="imgs">[图 x${it.images.length}]</span>` : '';
  const rssHref = `/rss/post?id=${encodeURIComponent(it.id)}`;
  const detail = `<details><summary>数据详情</summary>
        <div class="sub">OCR 文本</div>
        ${ocrBlock(it.images, ocr)}
      </details>`;
  return `      <li data-game="${escapeHtml(it.gameId)}" data-start="${d}" data-end="${d}" data-text="${searchText}"><a class="rss-link" href="${rssHref}">RSS</a><span class="date" style="width:130px">${fmtCst(it.publishedAt)}</span><span class="tag">${escapeHtml(gameName)}</span><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" title="${tip}">${escapeHtml(it.title)}</a>${imgs}${detail}</li>`;
}

/** 内联筛选脚本：按游戏 / 分类（条目类型）/ 关键词 / 时间范围就地切换行可见性（不刷新、不发请求） */
const FILTER_SCRIPT = `<script>
(function () {
  var game = document.getElementById('f-game');
  var type = document.getElementById('f-type');
  var kw = document.getElementById('f-kw');
  var from = document.getElementById('f-from');
  var to = document.getElementById('f-to');
  var reset = document.getElementById('f-reset');
  var shown = document.getElementById('rows-shown');
  var entriesShown = document.getElementById('entries-shown');
  var postsShown = document.getElementById('posts-shown');
  // 参与筛选的行：结构化条目与原始动态的 li（均带 data-game；OCR/分段等嵌套 li 不带）
  var rows = Array.prototype.slice.call(document.querySelectorAll('li[data-game]'));
  function apply() {
    var g = game.value, ty = type.value, k = kw.value.trim().toLowerCase(), f = from.value, t = to.value;
    var timeOn = !!(f || t);
    var n = 0, ne = 0, np = 0;
    rows.forEach(function (row) {
      var ok = true;
      if (g && row.dataset.game !== g) ok = false;
      // 分类 = 条目类型，仅作用于结构化条目；原始动态无 data-type，不受该筛选项约束
      if (ok && ty && row.dataset.type && row.dataset.type !== ty) ok = false;
      if (ok && k && (row.dataset.text || '').toLowerCase().indexOf(k) === -1) ok = false;
      if (ok && timeOn) {
        var s = row.dataset.start, e = row.dataset.end;
        // 无起点且无终点：启用时间筛选时排除；只有单边时视为另一端无穷（常驻/未锚定）
        if (!s && !e) ok = false;
        else {
          if (f && e && e < f) ok = false;
          if (ok && t && s && s > t) ok = false;
        }
      }
      // 两个大类的可见数分别统计（ul.entries 内为结构化条目，ul.posts 内为原始动态）
      if (ok) {
        row.classList.remove('hidden'); n++;
        if (row.closest('ul.entries')) ne++;
        else if (row.closest('ul.posts')) np++;
      } else { row.classList.add('hidden'); }
    });
    shown.textContent = String(n);
    entriesShown.textContent = String(ne);
    postsShown.textContent = String(np);
  }
  [game, type, kw, from, to].forEach(function (el) {
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  reset.addEventListener('click', function () { game.value = ''; type.value = ''; kw.value = ''; from.value = ''; to.value = ''; apply(); });
  apply();
})();
</script>`;

/**
 * 列表视图：概览卡片 + 异常报告区 + 筛选行 + 结构化数据 + 原始动态（两个可折叠大类）。
 * 概览把统计口径写进标签：新增/更新指拉取层原始动态（posts），非结构化条目。
 */
export function renderPage(data: PageData): string {
  const { posts, meta, entries, unresolved, pendingExtract, unrecognizedImages, latestEvent, ocr } = data;

  // 概览卡片：上次拉取结果（相对时间 + 绝对时间 + 口径说明）
  const syncLine = meta
    ? `最近同步 ${fmtRelative(meta.lastRunAt)} <span class="muted">（${fmtCst(meta.lastRunAt)}，用时 ${(meta.durationMs / 1000).toFixed(1)}s）</span><br>
      本次拉取：新增原始动态 ${meta.added} 条 · 内容更新 ${meta.updated} 条（口径为拉取层去重后 fetched=${meta.fetched} 条）${
        meta.errors.length > 0 ? `<br><span class="err">拉取失败 ${meta.errors.length} 项：${meta.errors.map(escapeHtml).join('；')}</span>` : ''
      }`
    : '尚未拉取，等待定时任务';
  const overview = `  <div class="card">
    <div class="stats">
      <div class="stat"><div class="num">${posts.length}</div><div class="lbl">原始动态</div></div>
      <div class="stat"><div class="num">${entries.length}</div><div class="lbl">结构化条目</div></div>
      <div class="stat"><div class="num">${pendingExtract}</div><div class="lbl">待结构化动态</div></div>
      <div class="stat"><div class="num">${unrecognizedImages}</div><div class="lbl">待 OCR 图片</div></div>
      <div class="stat"><div class="num">${unresolved.total}</div><div class="lbl">未恢复异常</div></div>
    </div>
    <div class="sync">${syncLine}</div>
  </div>`;

  // 异常报告区：有未恢复异常时高亮并给最近异常相对时间；否则提示源状态正常
  const health = unresolved.total > 0
    ? `  <div class="health bad"><strong>源异常</strong>：${unresolved.total} 条未恢复${unresolved.cookieSuspect > 0 ? `，其中 ${unresolved.cookieSuspect} 条疑似 B站 cookie 失效` : ''}${latestEvent ? `；最近异常 ${fmtRelative(latestEvent.occurredAt)}（${fmtCst(latestEvent.occurredAt)}）` : ''}　<a href="/health">查看源健康页</a></div>`
    : `  <div class="health good">源状态正常，无未恢复异常。</div>`;

  // 筛选行：游戏 / 分类（条目类型）/ 关键词 / 时间范围（北京时间日期）；由页面底部内联脚本就地过滤
  const gameOptions = GAMES.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  const typeOptions = Object.entries(ENTRY_TYPE_LABEL).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('');
  const filters = `  <div class="filters">
    <label>游戏 <select id="f-game"><option value="">全部</option>${gameOptions}</select></label>
    <label title="仅筛选结构化数据，原始动态不受影响">分类 <select id="f-type"><option value="">全部</option>${typeOptions}</select></label>
    <label>关键词 <input id="f-kw" type="search" placeholder="活动名 / 标题 / 正文"></label>
    <label>起 <input id="f-from" type="date"></label>
    <label>止 <input id="f-to" type="date"></label>
    <button id="f-reset" type="button">重置</button>
  </div>`;

  // 结构化数据大类（loadEntries 已按 endAt 升序、NULL 最后）
  const postById = new Map(posts.map((p) => [p.id, p]));
  const entryRows = entries.length > 0
    ? entries.map((e) => entryRow(e, postById, ocr)).join('\n')
    : '      <li class="unanchored">暂无条目，等待 LLM 处理动态</li>';
  const entrySection = `  <details class="section" open><summary>结构化数据 <small>（筛选后 <span id="entries-shown">0</span> / ${entries.length}）</small></summary>
  <ul class="entries">
${entryRows}
  </ul>
  </details>`;

  // 原始动态大类（单一列表，发布时间倒序；行内 tag 显示游戏名，故不再按游戏拆成多个大类）
  const allPosts = posts.slice().sort((a, b) => b.publishedAt - a.publishedAt);
  const postRows = allPosts.length > 0
    ? allPosts.map((it) => postRow(it, ocr)).join('\n')
    : '      <li class="unanchored">暂无动态</li>';
  const postSection = `  <details class="section" open><summary>原始动态 <small>（筛选后 <span id="posts-shown">0</span> / ${posts.length}）</small></summary>
  <ul class="posts">
${postRows}
  </ul>
  </details>`;

  return layout('list', `${overview}
${health}
${filters}
  <p class="count-line">共 ${posts.length} 条原始动态、${entries.length} 条结构化条目；筛选后显示 <span id="rows-shown">0</span> 行。</p>
${entrySection}
${postSection}
  ${FILTER_SCRIPT}`);
}

/** 异常事件类型中文标签（展示用） */
const KIND_LABEL: Record<string, string> = {
  http: '上游 HTTP 错误',
  network: '网络异常',
  parse: 'RSS 解析失败',
  empty: '空数据',
};

/** 源健康视图：源健康事件列表（时间倒序），未恢复事件高亮，同一游戏后续拉取成功自动标记恢复 */
export function renderHealth(events: StoredEvent[]): string {
  const rows = events.length > 0
    ? events.map((ev) => {
        const game = GAMES.find((g) => g.id === ev.gameId);
        const status = ev.resolvedAt === null
          ? '<span class="badge bad">未恢复</span>'
          : `<span class="badge ok">已恢复 ${fmtCst(ev.resolvedAt)}</span>`;
        const cookie = ev.isCookieSuspect ? '<span class="badge cookie">疑似 cookie 失效</span>' : '';
        const detail = ev.detail ? `\n        <div class="detail">${escapeHtml(ev.detail)}</div>` : '';
        return `      <li><span class="date" style="width:150px">${fmtCst(ev.occurredAt)}</span><span class="tag">${KIND_LABEL[ev.kind] ?? ev.kind}</span>${escapeHtml(game?.name ?? ev.gameId ?? '系统')} ${status}${cookie}<br>${escapeHtml(ev.summary)}${detail}</li>`;
      }).join('\n')
    : '      <li>暂无异常记录</li>';
  return layout('health', `  <p>共 ${events.length} 条记录（时间倒序，最多保留最近 200 条）。<a href="/">返回列表</a></p>
  <h2>源健康事件 <small>（同一游戏后续拉取成功且返回数据时，未恢复异常自动标记恢复）</small></h2>
  <ul class="events">
${rows}
  </ul>`);
}

/** 单条目在某天的展示形态（日历单元格用） */
interface DayEvent {
  /** 展示样式类：start=开始 end=结束 reward=奖励截止 ongoing=进行中 */
  cls: 'start' | 'end' | 'reward' | 'ongoing';
  /** 单元格内短文本 */
  text: string;
  /** 悬停完整说明 */
  tip: string;
}

/** 日历视图：按北京时间把条目铺进 ym（"YYYY-MM"）当月日历 */
export function renderCalendar(entries: StoredEntry[], ym: string): string {
  const monthStart = Math.floor(Date.parse(`${ym}-01T00:00:00+08:00`) / 1000);
  // 下月 1 号（北京时间）→ 当月天数
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const nym = `${ny}-${String(nm).padStart(2, '0')}`;
  const monthEnd = Math.floor(Date.parse(`${nym}-01T00:00:00+08:00`) / 1000);
  const days = Math.round((monthEnd - monthStart) / 86400);
  const DAY = 86400;
  // 当月 1 号是周几（北京时间；周一=0，用于周一起始网格）
  const firstDow = (new Date((monthStart + 8 * 3600) * 1000).getUTCDay() + 6) % 7;

  // 每天事件桶：条目时间落点（开始/结束/奖励截止）+ 跨越当天的"进行中"
  const buckets: DayEvent[][] = Array.from({ length: days }, () => []);
  for (const e of entries) {
    const label = ENTRY_TYPE_LABEL[e.type as EntryType] ?? e.type;
    const game = GAMES.find((g) => g.id === e.gameId);
    const prefix = `${game?.name ?? e.gameId}·${label}`;
    const estTip = e.payload.estimated ? '（预估）' : '';
    for (let d = 0; d < days; d++) {
      const dayStart = monthStart + d * DAY;
      const dayEnd = dayStart + DAY;
      const cell = buckets[d];
      if (e.startAt !== undefined && e.startAt >= dayStart && e.startAt < dayEnd) {
        cell.push({ cls: 'start', text: `始 ${e.title}`, tip: `${prefix} 开始：${e.title}${estTip}` });
      }
      if (e.endAt !== undefined && e.endAt >= dayStart && e.endAt < dayEnd) {
        cell.push({ cls: 'end', text: `终 ${e.title}`, tip: `${prefix} 结束：${e.title}` });
      }
      if (e.payload.rewardEndAt !== undefined && e.payload.rewardEndAt >= dayStart && e.payload.rewardEndAt < dayEnd) {
        cell.push({ cls: 'reward', text: `奖 ${e.title}`, tip: `${prefix} 奖励截止：${e.title}` });
      }
      // 进行中：起止都存在且当天被完整跨越（开始/结束当天已单独标注，不重复显示）
      if (e.startAt !== undefined && e.endAt !== undefined && e.startAt < dayStart && e.endAt >= dayEnd) {
        cell.push({ cls: 'ongoing', text: e.title, tip: `${prefix} 进行中：${e.title}` });
      }
    }
  }

  // 单元格上限：优先显示落点事件（start/end/reward 已先入桶），进行中排最后，超出折叠
  const MAX_PER_CELL = 3;
  const todayDate = fmtCstDate(Math.floor(Date.now() / 1000));
  const cells: string[] = [];
  for (let i = 0; i < firstDow; i++) cells.push('      <td class="pad"></td>');
  for (let d = 0; d < days; d++) {
    const dateStr = `${ym}-${String(d + 1).padStart(2, '0')}`;
    const evs = buckets[d];
    const shown = evs.slice(0, MAX_PER_CELL)
      .map((ev) => `<div class="ev ${ev.cls}" title="${escapeHtml(ev.tip)}">${escapeHtml(ev.text)}</div>`)
      .join('');
    const more = evs.length > MAX_PER_CELL ? `<div class="more">+${evs.length - MAX_PER_CELL}</div>` : '';
    cells.push(`      <td${dateStr === todayDate ? ' class="today"' : ''}><div class="dnum">${d + 1}</div>${shown}${more}</td>`);
  }
  while (cells.length % 7 !== 0) cells.push('      <td class="pad"></td>');
  // 每 7 个包一行
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`    <tr>\n${cells.slice(i, i + 7).join('\n')}\n    </tr>`);

  // 月导航（北京时间）
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const pym = `${py}-${String(pm).padStart(2, '0')}`;
  const calNav = `<div class="calnav"><a href="/calendar?month=${pym}">‹ 上月</a><span class="cur">${ym}</span><a href="/calendar?month=${nym}">下月 ›</a></div>`;

  // 无锚定时间的条目（仅引用型时间，回填扫描尚未锚定）→ 底部待办列表
  const unanchored = entries.filter((e) => e.startAt === undefined && e.endAt === undefined);
  const unanchoredSection = unanchored.length > 0
    ? `  <h2>待锚定条目 <small>（${unanchored.length}，仅有引用型时间，等待回填扫描）</small></h2>
  <ul>
${unanchored.map((e) => {
  const game = GAMES.find((g) => g.id === e.gameId);
  const refs = [e.payload.startRef?.refText, e.payload.endRef?.refText].filter((s): s is string => Boolean(s)).map(escapeHtml).join(' / ');
  return `      <li><span class="tag">${ENTRY_TYPE_LABEL[e.type as EntryType] ?? e.type}</span>${escapeHtml(game?.name ?? e.gameId)}：<a href="${escapeHtml(e.url ?? '')}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a> <span class="unanchored">［${refs}］</span></li>`;
}).join('\n')}
  </ul>`
    : '';

  return layout('calendar', `${calNav}
  <table class="cal">
    <tr><th>一</th><th>二</th><th>三</th><th>四</th><th>五</th><th>六</th><th>日</th></tr>
${rows.join('\n')}
  </table>
${unanchoredSection}`);
}

/** 日历缺省月：当前北京时间所在月 */
export function defaultMonth(): string {
  return currentYm();
}

/** 校验 month 参数（"YYYY-MM"），非法回退当前月 */
export function parseMonth(raw: string | null): string {
  return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : defaultMonth();
}
