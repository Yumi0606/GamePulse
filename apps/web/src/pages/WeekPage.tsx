import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL } from '@gamepulse/shared';
import { api } from '../lib/api';
import { fmtBound } from '../lib/format';
import { gameTheme, typeColor } from '../lib/game-theme';
import { useGameName, useGames } from '../lib/hooks';
import { Card, QueryState } from '../components/ui';
import './week.css';

/**
 * 周视图（甘特式连续时间轴）。
 *
 * 交互约定与旧版一致：
 * - 普通滚轮横向滚动，Shift+滚轮纵向，Ctrl/Cmd+滚轮切换精度（小时/天/周/月），Alt+滚轮调整行高
 * - 按住拖动平移（5px 阈值区分点击），点击色条看详情，点击分组标题折叠
 * - 前后各可再加载 4 周；已结束条目沉底置灰，未开始半透明
 *
 * 几何全部用内联像素定位，`--cell-width` / `--row-height` 作为运行时变量写在时间轴上。
 */
const DAY = 86400;
const CST_OFFSET = 8 * 3600;
const LOAD_WEEKS = 4;
const INITIAL_WEEKS = 4;
const DRAG_THRESHOLD = 5;
const ROW_HEIGHT_MIN = 20;
const ROW_HEIGHT_MAX = 60;

const PRECISIONS = [
  { key: 'hour', cellWidth: 40, label: '小时' },
  { key: 'day', cellWidth: 80, label: '天' },
  { key: 'week', cellWidth: 120, label: '周' },
  { key: 'month', cellWidth: 200, label: '月' },
] as const;

type Precision = (typeof PRECISIONS)[number]['key'];

const PRECISION_INDEX: Record<Precision, number> = { hour: 0, day: 1, week: 2, month: 3 };

const dayIndex = (ts: number): number => Math.floor((ts + CST_OFFSET) / DAY);
const hourIndex = (ts: number): number => Math.floor((ts + CST_OFFSET) / 3600);
const weekIndex = (ts: number): number => Math.floor((dayIndex(ts) + 4) / 7);

function monthIndex(ts: number): number {
  const d = new Date((ts + CST_OFFSET) * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function cellIndex(ts: number, precision: Precision): number {
  if (precision === 'hour') return hourIndex(ts);
  if (precision === 'day') return dayIndex(ts);
  if (precision === 'week') return weekIndex(ts);
  return monthIndex(ts);
}

/** 所在周的周一 00:00（CST）的 Unix 秒 */
function weekMonday(ts: number): number {
  const dIdx = dayIndex(ts);
  return (dIdx - ((dIdx + 4) % 7)) * DAY - CST_OFFSET;
}

/** 解析 ?from=YYYY-MM-DD，非法或为空取当前时刻 */
function parseFrom(raw: string | null): number {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ts = Math.floor(Date.parse(`${raw}T00:00:00+08:00`) / 1000);
    if (!Number.isNaN(ts)) return ts;
  }
  return Math.floor(Date.now() / 1000);
}

function headerLabel(cellIdx: number, precision: Precision): string {
  if (precision === 'hour') {
    const d = new Date((cellIdx * 3600 - CST_OFFSET) * 1000);
    const h = String(d.getUTCHours()).padStart(2, '0');
    return cellIdx % 24 === 0 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} 00` : `${h}:00`;
  }
  if (precision === 'day') {
    const d = new Date((cellIdx * DAY - CST_OFFSET) * 1000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }
  if (precision === 'week') {
    const d = new Date(((cellIdx * 7 - 4) * DAY - CST_OFFSET) * 1000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} 起`;
  }
  const y = Math.floor(cellIdx / 12);
  const m = cellIdx % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function isWeekendCell(cellIdx: number, precision: Precision): boolean {
  if (precision !== 'hour' && precision !== 'day') return false;
  const dIdx = precision === 'hour' ? Math.floor(cellIdx / 24) : cellIdx;
  const dow = (dIdx + 4) % 7;
  return dow === 5 || dow === 6;
}

/** 条目相对当前时刻的状态：ended / future / active */
function entryState(e: EntryDto, now: number): 'ended' | 'future' | 'active' {
  if (e.endAt !== undefined && e.endAt < now) return 'ended';
  if (e.startAt !== undefined && e.startAt > now) return 'future';
  return 'active';
}

interface PopoverState {
  entry: EntryDto;
  x: number;
  y: number;
}

export function WeekPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const gameId = params.get('gameId') ?? '';
  const type = params.get('type') ?? '';
  const keyword = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'start';
  const order = params.get('order') === 'desc' ? 'desc' : 'asc';
  const onlyActive = params.get('active') === '1';

  const patch = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const [precision, setPrecision] = useState<Precision>('day');
  const [rowHeight, setRowHeight] = useState(32);
  const [view, setView] = useState(() => {
    const monday = weekMonday(parseFrom(params.get('from')));
    return { start: monday - INITIAL_WEEKS * 7 * DAY, end: monday + INITIAL_WEEKS * 7 * DAY };
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [containerHeight, setContainerHeight] = useState(600);

  const cellWidth = PRECISIONS[PRECISION_INDEX[precision]].cellWidth;
  const now = Math.floor(Date.now() / 1000);

  const entriesQuery = useQuery({
    queryKey: ['entries-week', { gameId, type, keyword }],
    queryFn: () => api.entries({ gameId, type, q: keyword, limit: 1000 }),
    placeholderData: keepPreviousData,
  });

  const entries = entriesQuery.data?.items ?? [];

  const startCell = cellIndex(view.start, precision);
  const endCell = cellIndex(view.end, precision);
  const cellCount = endCell - startCell + 1;

  // 容器高度：视口 70%，下限 400px
  useEffect(() => {
    const apply = () => setContainerHeight(Math.max(400, Math.floor(window.innerHeight * 0.7)));
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  // 拖动平移
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) d.moved = true;
      if (d.moved) {
        const el = containerRef.current;
        if (!el) return;
        el.scrollLeft = d.sl - dx;
        el.scrollTop = d.st - dy;
        movedRef.current = true;
      }
    };
    const onUp = () => {
      dragRef.current = null;
      const el = containerRef.current;
      if (el) el.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 滚轮：横滚 / 纵向 / 精度 / 行高
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const amount = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const idx = PRECISION_INDEX[precision];
        const next = amount < 0 ? Math.max(idx - 1, 0) : Math.min(idx + 1, PRECISIONS.length - 1);
        if (next !== idx) setPrecision(PRECISIONS[next].key);
      } else if (e.altKey) {
        e.preventDefault();
        setRowHeight((h) => Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, h + (amount < 0 ? 2 : -2))));
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollTop += amount;
      } else {
        e.preventDefault();
        el.scrollLeft += amount;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [precision]);

  // 点击空白关闭 popover
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-entry-id]') && !target?.closest('[data-popover]')) setPopover(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // 左扩时间轴后补偿滚动位置，保持当前可视内容不动
  const pendingScrollRef = useRef<number | null>(null);
  useEffect(() => {
    if (pendingScrollRef.current === null) return;
    const el = containerRef.current;
    if (el) el.scrollLeft += pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [view]);

  const loadEarlier = () => {
    const newStart = view.start - LOAD_WEEKS * 7 * DAY;
    const added = (cellIndex(view.start, precision) - cellIndex(newStart, precision)) * cellWidth;
    pendingScrollRef.current = added;
    setView((v) => ({ ...v, start: newStart }));
  };

  const loadLater = () => {
    setView((v) => ({ ...v, end: v.end + LOAD_WEEKS * 7 * DAY }));
  };

  // 分组与排序：已结束沉底，缺值沉底
  const groups = useMemo(() => {
    const gameOrder = (gamesQuery.data?.items ?? []).map((g) => g.id);
    const filtered = entries.filter((e) => {
      if (onlyActive && entryState(e, now) === 'ended') return false;
      return true;
    });
    const byGame = new Map<string, EntryDto[]>();
    for (const e of filtered) {
      const list = byGame.get(e.gameId);
      if (list) list.push(e);
      else byGame.set(e.gameId, [e]);
    }
    const sortVal = (e: EntryDto): number | null => {
      if (sort === 'start') return e.startAt ?? null;
      if (sort === 'end') return e.endAt ?? null;
      return e.startAt !== undefined && e.endAt !== undefined ? e.endAt - e.startAt : null;
    };
    const ids = [...byGame.keys()].sort((a, b) => {
      const ai = gameOrder.indexOf(a);
      const bi = gameOrder.indexOf(b);
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.localeCompare(b);
    });
    return ids.map((id) => {
      const list = [...byGame.get(id)!].sort((a, b) => {
        const ae = entryState(a, now) === 'ended';
        const be = entryState(b, now) === 'ended';
        if (ae !== be) return ae ? 1 : -1;
        const va = sortVal(a);
        const vb = sortVal(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return order === 'asc' ? va - vb : vb - va;
      });
      return { gameId: id, list };
    });
  }, [entries, gamesQuery.data, onlyActive, sort, order, now]);

  const unanchored = useMemo(() => entries.filter((e) => e.startAt === undefined && e.endAt === undefined), [entries]);

  const dataRange = useMemo(() => {
    let minStart: number | null = null;
    let maxEnd: number | null = null;
    for (const e of entries) {
      if (e.startAt !== undefined && (minStart === null || e.startAt < minStart)) minStart = e.startAt;
      if (e.endAt !== undefined && (maxEnd === null || e.endAt > maxEnd)) maxEnd = e.endAt;
    }
    return { minStart, maxEnd };
  }, [entries]);

  const noEarlier = dataRange.minStart !== null && view.start <= dataRange.minStart - LOAD_WEEKS * 7 * DAY;
  const noLater = dataRange.maxEnd !== null && view.end >= dataRange.maxEnd + LOAD_WEEKS * 7 * DAY;

  const todayCell = cellIndex(now, precision);
  const todayLeft = (todayCell - startCell) * cellWidth + cellWidth / 2;
  const todayVisible = todayCell >= startCell && todayCell <= endCell;

  const openPopover = useCallback((entry: EntryDto, x: number, y: number) => {
    const width = 360;
    const px = x + 12 + width > window.innerWidth ? Math.max(8, x - width - 12) : x + 12;
    const py = Math.min(y + 12, window.innerHeight - 180);
    setPopover({ entry, x: px, y: py });
  }, []);

  const timelineStyle = {
    '--cell-width': `${cellWidth}px`,
    '--row-height': `${rowHeight}px`,
    '--gantt-h': `${containerHeight}px`,
    width: `${cellCount * cellWidth}px`,
  } as CSSProperties;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <label className="flex items-center gap-1">
            <span className="text-muted">游戏</span>
            <select
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={gameId}
              onChange={(e) => patch({ gameId: e.target.value || null })}
            >
              <option value="">全部</option>
              {(gamesQuery.data?.items ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">分类</span>
            <select
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={type}
              onChange={(e) => patch({ type: e.target.value || null })}
            >
              <option value="">全部</option>
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ENTRY_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">关键词</span>
            <input
              type="search"
              className="w-[170px] rounded border border-line bg-surface px-1.5 py-1"
              placeholder="活动名 / 分类 / 摘要"
              value={keyword}
              onChange={(e) => patch({ q: e.target.value || null })}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">排序</span>
            <select
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={sort}
              onChange={(e) => patch({ sort: e.target.value === 'start' ? null : e.target.value })}
            >
              <option value="start">开始时间</option>
              <option value="end">结束时间</option>
              <option value="duration">持续时间</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded border border-line px-2 py-1"
            title={order === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}
            onClick={() => patch({ order: order === 'desc' ? null : 'desc' })}
          >
            {order === 'asc' ? '↑' : '↓'}
          </button>
          <label className="flex items-center gap-1" title="勾选后隐藏已结束的活动行">
            <input type="checkbox" checked={onlyActive} onChange={(e) => patch({ active: e.target.checked ? '1' : null })} />
            仅进行中
          </label>
          <button
            type="button"
            className="rounded border border-line px-2 py-1"
            onClick={() => patch({ gameId: null, type: null, q: null, sort: null, order: null, active: null })}
          >
            重置
          </button>
          <span className="ml-auto text-[12px] text-muted">
            滚轮横移 · Shift+滚轮纵移 · Ctrl+滚轮缩放精度 · Alt+滚轮行高 · 拖动平移
          </span>
        </div>
      </Card>

      <QueryState loading={entriesQuery.isLoading} error={entriesQuery.error} />

      <div
        ref={containerRef}
        className="gantt-container"
        style={{ height: containerHeight }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          movedRef.current = false;
          dragRef.current = {
            x: e.clientX,
            y: e.clientY,
            sl: containerRef.current?.scrollLeft ?? 0,
            st: containerRef.current?.scrollTop ?? 0,
            moved: false,
          };
          if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
        }}
      >
        <div className="gantt-timeline" style={timelineStyle}>
          <div className="gantt-header">
            {Array.from({ length: cellCount }, (_, i) => {
              const c = startCell + i;
              const cls = [
                'gantt-header-cell',
                isWeekendCell(c, precision) ? 'weekend' : '',
                c === todayCell ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div key={c} className={cls}>
                  {headerLabel(c, precision)}
                </div>
              );
            })}
          </div>

          {todayVisible ? <div className="gantt-today-line" style={{ marginLeft: todayLeft }} /> : null}

          <div>
            {groups.map((group) => {
              const theme = gameTheme(group.gameId);
              const rows = group.list
                .map((e) => renderRow(e, startCell, endCell, cellWidth, now, precision))
                .filter((r): r is NonNullable<typeof r> => r !== null);
              if (rows.length === 0) return null;
              const isCollapsed = Boolean(collapsed[group.gameId]);
              return (
                <div key={group.gameId}>
                  <div
                    className="gantt-group-header"
                    style={{ '--group-bg': theme.bg, borderLeft: `4px solid ${theme.accent}` } as CSSProperties}
                    role="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group.gameId]: !prev[group.gameId] }))}
                  >
                    <span className="gantt-fold">{isCollapsed ? '▸' : '▾'}</span>
                    {gameName(group.gameId)}
                    <span className="count">({rows.length})</span>
                  </div>
                  <div className={`gantt-group-body${isCollapsed ? ' is-collapsed' : ''}`}>
                    {rows.map((row) => (
                      <div
                        key={row.entry.id}
                        className="gantt-row"
                        data-entry-id={row.entry.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (movedRef.current) return;
                          openPopover(row.entry, e.clientX, e.clientY);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <div
                          className={row.cls}
                          style={{ marginLeft: row.left, width: row.width, backgroundColor: typeColor(row.entry.type) }}
                        >
                          <div className="gantt-label">
                            <span className="gantt-name" title={row.name}>
                              {row.name}
                            </span>
                            <span className="gantt-chip">{row.chip}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {groups.length === 0 ? <div className="gantt-empty">当前筛选条件下无活动</div> : null}
          </div>
        </div>
      </div>

      <div className="flex justify-center gap-3">
        <button
          type="button"
          className="rounded border border-line bg-surface px-4 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={noEarlier}
          onClick={loadEarlier}
        >
          加载更早 4 周
        </button>
        <button
          type="button"
          className="rounded border border-line bg-surface px-4 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={noLater}
          onClick={loadLater}
        >
          加载更晚 4 周
        </button>
      </div>

      {unanchored.length > 0 ? (
        <Card>
          <h2 className="mb-1 border-l-4 border-brand pl-2 text-[15px] font-semibold">
            待锚定条目 <span className="text-[12px] font-normal text-muted">（{unanchored.length}，无起止时间）</span>
          </h2>
          <ul className="divide-y divide-line text-[13px]">
            {unanchored.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
                <span className="text-muted">[{gameName(e.gameId)}]</span>
                <a href={`/app/all?entry=${encodeURIComponent(e.id)}`}>{e.title}</a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {popover ? (
        <div
          data-popover
          className="fixed z-50 w-[360px] rounded-lg border border-line bg-surface p-3 text-[13px] shadow-lg"
          style={{ left: popover.x, top: popover.y }}
        >
          <div className="font-semibold">{popover.entry.canonicalName ?? popover.entry.title}</div>
          <div className="mt-1 text-[12px] text-muted">
            {gameName(popover.entry.gameId)} · {ENTRY_TYPE_LABEL[popover.entry.type]}
            {popover.entry.category ? ` · ${popover.entry.category}` : ''}
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {fmtBound(popover.entry.startAt, popover.entry.startTimeKnown)} →{' '}
            {fmtBound(popover.entry.endAt, popover.entry.endTimeKnown)}
          </div>
          {popover.entry.summary ? <div className="mt-1.5">{popover.entry.summary}</div> : null}
          <div className="mt-2 text-[12px]">
            <a href={`/app/all?entry=${encodeURIComponent(popover.entry.id)}`}>在列表中定位 →</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 计算单条在渲染窗口内的色条几何；两端皆无或完全在窗口外返回 null */
function renderRow(
  e: EntryDto,
  startCell: number,
  endCell: number,
  cellWidth: number,
  now: number,
  precision: Precision,
): { entry: EntryDto; left: number; width: number; cls: string; name: string; chip: string } | null {
  const hasStart = e.startAt !== undefined;
  const hasEnd = e.endAt !== undefined;
  if (!hasStart && !hasEnd) return null;

  const rawS = hasStart ? cellIndex(e.startAt!, precision) : startCell;
  const rawE = hasEnd ? cellIndex(e.endAt!, precision) : endCell;
  if (rawE < startCell || rawS > endCell) return null;

  const sIdx = Math.max(rawS, startCell);
  const eIdx = Math.min(rawE, endCell);
  const left = (sIdx - startCell) * cellWidth;
  const width = (eIdx - sIdx + 1) * cellWidth;

  const cls = ['gantt-bar-fill', `state-${entryState(e, now)}`];
  if (!hasStart) cls.push('no-start');
  if (!hasEnd) cls.push('open-end');
  // 窗口截断标记：条在渲染窗口边界处断开，而非活动本身结束
  if (hasStart && rawS < startCell) cls.push('clip-start');
  if (hasEnd && rawE > endCell) cls.push('clip-end');

  const name = e.canonicalName ?? e.title;
  const chip = e.category ? `${ENTRY_TYPE_LABEL[e.type]}·${e.category}` : ENTRY_TYPE_LABEL[e.type];
  return { entry: e, left, width, cls: cls.join(' '), name, chip };
}
