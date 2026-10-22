import { GAMES } from '../core/games.js';
import { ENTRY_TYPE_LABEL, type EntryType } from '../core/types.js';
import type { StoredEntry, StoredPost } from '../storage/store.js';
import { escapeHtml, fmtCst } from './page.js';

/**
 * 周视图渲染（甘特式横向时间轴）。
 *
 * 服务端仅把条目数据序列化为 JSON 嵌入页面；甘特条渲染、精度缩放、
 * 平移、加载更多、筛选排序均由前端 /assets/week.js 处理。
 *
 * 设计决策见会话 grill 记录，核心：
 * - 横轴连续日期，精度四级（小时/天/周/月），Shift+滚轮切换
 * - 行按游戏分组，组内排序（开始/结束/持续时间升降序）
 * - 活动名 sticky left 固定可见，条上不显示文字
 * - 已结束活动灰色置底，未开始半透明，进行中不透明
 */

/** 解析 ?from=YYYY-MM-DD，非法或为空取今天（CST） */
function parseFrom(raw: string | null): number {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ts = Math.floor(Date.parse(`${raw}T00:00:00+08:00`) / 1000);
    if (!Number.isNaN(ts)) return ts;
  }
  return Math.floor(Date.now() / 1000);
}

/** 周视图嵌入的条目数据（前端渲染所需最小字段集） */
interface WeekEntry {
  id: string;
  gameId: string;
  type: EntryType;
  title: string;
  canonicalName?: string;
  category?: string;
  summary?: string;
  startAt: number | null;
  endAt: number | null;
  url: string | null;
  postTitle: string | null;
  postUrl: string | null;
}

export function renderWeek(entries: StoredEntry[], posts: StoredPost[], fromRaw: string | null): string {
  const fromTs = parseFrom(fromRaw);
  const postById = new Map(posts.map((p) => [p.id, p]));

  const data: WeekEntry[] = entries.map((e) => {
    const post = e.postId ? postById.get(e.postId) : undefined;
    return {
      id: e.id,
      gameId: e.gameId,
      type: e.type,
      title: e.title,
      canonicalName: e.payload.canonicalName,
      category: e.payload.category,
      summary: e.payload.summary,
      startAt: e.startAt ?? null,
      endAt: e.endAt ?? null,
      url: e.url ?? null,
      postTitle: post?.title ?? null,
      postUrl: post?.url ?? null,
    };
  });

  // 游戏选项（按 GAMES 顺序，字典序）
  const gameOptions = GAMES.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('');
  const typeOptions = Object.entries(ENTRY_TYPE_LABEL).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('');

  return layoutWeek(`
  <div class="week-filters" id="week-filters">
    <label>游戏 <select id="w-game"><option value="">全部</option>${gameOptions}</select></label>
    <label>分类 <select id="w-type"><option value="">全部</option>${typeOptions}</select></label>
    <label>关键词 <input id="w-kw" type="search" placeholder="活动名 / 分类 / 摘要"></label>
    <label>排序
      <select id="w-sort">
        <option value="start">开始时间</option>
        <option value="end">结束时间</option>
        <option value="duration">持续时间</option>
      </select>
    </label>
    <button id="w-dir" type="button" title="切换升降序">↑</button>
    <label title="勾选后隐藏已结束的活动行"><input id="w-ended" type="checkbox">仅进行中</label>
    <button id="w-reset" type="button">重置</button>
    <span class="week-hint">滚轮横向滚动 · Shift+滚轮缩放精度 · Ctrl+滚轮缩放行高 · 拖动平移</span>
  </div>
  <div class="gantt-container" id="gantt-container">
    <div class="gantt-timeline" id="gantt-timeline">
      <div class="gantt-header" id="gantt-header"></div>
      <div class="gantt-today-line" id="gantt-today" hidden></div>
      <div class="gantt-body" id="gantt-body"></div>
    </div>
  </div>
  <div class="week-load" id="week-load" hidden>
    <button id="load-earlier" type="button">加载更早 4 周</button>
    <button id="load-later" type="button">加载更晚 4 周</button>
  </div>
  <div class="week-unanchored" id="week-unanchored"></div>
  <div class="gantt-popover" id="gantt-popover" hidden></div>
  <script type="application/json" id="week-data">${JSON.stringify(data)}</script>
  <script>window.__WEEK_FROM__ = ${fromTs};</script>
`);
}

/** 周视图独立 HTML 骨架（不复用列表视图 layout，因为导航与样式独立） */
function layoutWeek(body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GamePulse · 周视图</title>
<style>${WEEK_STYLE}</style>
<link rel="stylesheet" href="/assets/week.css">
</head>
<body>
  <h1>GamePulse · 游戏活动排期</h1>
  <nav>
    <a href="/">列表</a> · <a href="/calendar">日历</a> · <a href="/week" style="font-weight:600">周</a> · <a href="/health">源健康</a>
    ｜ RSS：<a href="/rss/posts">原始动态</a> · <a href="/rss/entries">结构化条目</a>
  </nav>
${body}
<script src="/assets/week.js" defer></script>
</body>
</html>
`;
}

/** 周视图内联样式：筛选区 sticky、甘特容器尺寸、popover 基础定位 */
const WEEK_STYLE = `
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; max-width: 1280px; margin: 16px auto; padding: 0 12px calc(50vh + 80px); color: #222; }
  h1 { font-size: 20px; }
  nav { margin: 8px 0 12px; font-size: 14px; }
  nav a { margin-right: 4px; color: #1a5fb4; text-decoration: none; }
  nav a:hover { text-decoration: underline; }
  .week-filters {
    position: sticky; top: 0; z-index: 100;
    display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center;
    padding: 8px 12px; background: #fff; border: 1px solid #eee; border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .week-filters label { font-size: 13px; color: #555; display: inline-flex; align-items: center; gap: 4px; }
  .week-filters select, .week-filters input { padding: 4px 6px; font-size: 13px; border: 1px solid #ccc; border-radius: 3px; }
  .week-filters input[type="search"] { width: 180px; }
  .week-filters button { padding: 4px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 3px; background: #fff; cursor: pointer; }
  .week-hint { font-size: 12px; color: #999; margin-left: auto; }
  .week-load { display: flex; gap: 12px; justify-content: center; margin: 12px 0; }
  .week-load button { padding: 6px 16px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; }
  .week-unanchored { margin-top: 16px; }
  .week-unanchored h2 { font-size: 15px; border-left: 4px solid #f5712c; padding-left: 8px; }
  .week-unanchored ul { list-style: none; padding: 0; }
  .week-unanchored li { padding: 4px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .gantt-popover {
    position: fixed; z-index: 200; background: #fff; border: 1px solid #ccc; border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15); padding: 10px 14px; max-width: 360px; font-size: 13px; line-height: 1.6;
  }
  .gantt-popover .pv-title { font-weight: 600; margin-bottom: 4px; }
  .gantt-popover .pv-meta { color: #666; font-size: 12px; }
  .gantt-popover a { color: #1a5fb4; }
`;
