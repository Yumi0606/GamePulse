import { GAMES } from '../core/games.js';
import { ENTRY_TYPE_LABEL, type EntryType } from '../core/types.js';
import type { FetchMeta, StoredPost, StoredEntry } from '../storage/store.js';

/**
 * 展示层页面渲染（纯函数，无 IO）：
 * - renderPage    列表视图：结构化条目（按结束时间升序）+ 原始动态（按游戏分组）
 * - renderCalendar 日历视图：按北京时间铺当月日历（开始/结束/奖励截止/进行中四态）
 */

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
`;

/** 页面骨架：导航（视图切换 + 两类 RSS 入口）+ 正文 */
function layout(active: 'list' | 'calendar', body: string): string {
  const navItem = (href: string, label: string, key: 'list' | 'calendar') =>
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
    ${navItem('/', '列表', 'list')} · ${navItem('/calendar', '日历', 'calendar')}
    ｜ RSS 订阅：<a href="/rss/posts">原始动态</a> · <a href="/rss/entries">结构化条目</a>
  </nav>
${body}
</body>
</html>
`;
}

/** 结构化条目单行（列表视图用）：时间 + 大类标签 + 标题 + 置信/预估标注 + 引用型时间 */
function entryRow(e: StoredEntry): string {
  const fmt = (unix?: number): string => (unix ? fmtCst(unix) : '—');
  const game = GAMES.find((g) => g.id === e.gameId);
  const est = e.payload.estimated ? ' <span class="est">预估</span>' : '';
  const conf = e.payload.confidence < 0.7 ? ` <span class="low-conf">置信 ${e.payload.confidence.toFixed(1)}</span>` : '';
  const startRef = e.payload.startRef ? `（始：${escapeHtml(e.payload.startRef.refText)}）` : '';
  const endRef = e.payload.endRef ? `（${escapeHtml(e.payload.endRef.refText)}）` : '';
  const reward = e.payload.rewardEndAt ? `<div class="reward">奖励截止 ${fmtCst(e.payload.rewardEndAt)}</div>` : '';
  const phases = e.payload.phases?.length
    ? `<ul class="phases">${e.payload.phases.map((p) => {
        const pf = (u?: number) => (u ? fmtCst(u) : '—');
        const ref = p.startRef ? `［${escapeHtml(p.startRef.refText)}］` : '';
        const refEnd = p.endRef ? `［${escapeHtml(p.endRef.refText)}］` : '';
        return `<li>#${p.index} ${escapeHtml(p.title ?? '')}：${pf(p.startAt)} → ${pf(p.endAt)}${ref}${refEnd}${p.estimated ? ' <span class="est">预估</span>' : ''}</li>`;
      }).join('')}</ul>`
    : '';
  const label = ENTRY_TYPE_LABEL[e.type as EntryType] ?? e.type;
  return `      <li><span class="date">${fmt(e.startAt)} → ${fmt(e.endAt)}${endRef}${startRef}</span><span class="tag">${label}</span>${escapeHtml(game?.name ?? e.gameId)}：<a href="${escapeHtml(e.url ?? '')}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>${est}${conf}${reward}${phases}</li>`;
}

/** 列表视图：结构化条目（排期视角，结束时间升序）+ 原始动态（按游戏分组） */
export function renderPage(posts: StoredPost[], meta: FetchMeta | null, entries: StoredEntry[]): string {
  let metaLine = '';
  if (meta) {
    const time = fmtCst(meta.lastRunAt);
    metaLine = ` · 最近拉取 ${time}（新增 ${meta.added} / 更新 ${meta.updated}，用时 ${(meta.durationMs / 1000).toFixed(1)}s）`;
  } else {
    metaLine = ' · 尚未拉取，等待定时任务';
  }
  const errorLine = meta && meta.errors.length > 0
    ? `\n  <p class="err">上次拉取失败：${meta.errors.map(escapeHtml).join('；')}</p>`
    : '';

  // 结构化条目区块（loadEntries 已按 endAt 升序、NULL 最后）
  const entryRows = entries.length > 0
    ? entries.map(entryRow).join('\n')
    : '      <li class="unanchored">暂无条目，等待 LLM 处理动态</li>';
  const entrySection = `  <h2>结构化条目 <small>（${entries.length}，排期视角）</small></h2>
  <ul class="entries">
${entryRows}
  </ul>`;

  // 原始动态区块（按游戏分组，发布时间倒序）
  const sections = GAMES.map((game) => {
    const list = posts
      .filter((i) => i.gameId === game.id)
      .sort((a, b) => b.publishedAt - a.publishedAt);
    const rows = list
      .map((it) => {
        const date = fmtCst(it.publishedAt);
        // 悬停显示正文前 200 字；有图时标注数量
        const tip = it.description ? escapeHtml(it.description.slice(0, 200)) : '';
        const imgs = it.images ? ` <span class="imgs">[图 x${it.images.length}]</span>` : '';
        return `      <li><span class="date" style="width:130px">${date}</span><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" title="${tip}">${escapeHtml(it.title)}</a>${imgs}</li>`;
      })
      .join('\n');
    return `    <section>
      <h2>${escapeHtml(game.name)} <small>（${list.length}）</small></h2>
      <ul>
${rows}
      </ul>
    </section>`;
  }).join('\n');

  return layout('list', `  <p>共 ${posts.length} 条动态 · ${entries.length} 条结构化条目${metaLine}</p>${errorLine}
${entrySection}
${sections}`);
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
