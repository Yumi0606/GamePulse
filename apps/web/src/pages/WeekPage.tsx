import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDateStart, fmtBound, fmtCstDate } from '../lib/format';
import { gameTheme, typeColor } from '../lib/game-theme';
import { useGameName, useGames } from '../lib/hooks';
import { Card, QueryState, btnSecondary, fieldClass } from '../components/ui';
import './week.css';

/**
 * 周视图（甘特式连续时间轴）。
 *
 * 交互约定：
 * - 精度与行高用显式分段控件切换；普通滚轮纵向滚动，Shift+滚轮横向滚动，不拦截 Ctrl/Cmd+滚轮（保留页面缩放）
 * - 按住拖动平移（5px 阈值区分点击），点击色条看详情（浮层以鼠标位置为锚点并收进视口），点击分组标题折叠
 * - 时间轴上方可输入日期定位，或一键回到今天
 * - 同组内按时间重叠分配泳道，并行活动共用行，避免分组高度膨胀
 * - 滚动到时间轴任意一端自动扩展 12 格，取数窗口随视图扩展
 *
 * 几何全部用内联像素定位，`--cell-width` / `--row-height` 作为运行时变量写在时间轴上。
 */
const DAY = 86400;
const CST_OFFSET = 8 * 3600;
/** 滚动到端点时一次扩展的格数，随精度换算成时间 */
const LOAD_CELLS = 12;
const INITIAL_WEEKS = 4;
const DRAG_THRESHOLD = 5;

const PRECISIONS = [
  { key: 'hour', cellWidth: 40, label: '小时' },
  { key: 'day', cellWidth: 80, label: '天' },
  { key: 'week', cellWidth: 120, label: '周' },
  { key: 'month', cellWidth: 200, label: '月' },
] as const;

const ROW_HEIGHTS = [
  { value: 24, label: '紧凑' },
  { value: 32, label: '标准' },
  { value: 44, label: '宽松' },
] as const;

type Precision = (typeof PRECISIONS)[number]['key'];

const PRECISION_INDEX: Record<Precision, number> = { hour: 0, day: 1, week: 2, month: 3 };

const STATE_LABEL: Record<'ended' | 'future' | 'active', string> = {
  ended: '已结束',
  future: '未开始',
  active: '进行中',
};

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

/** 沿时间轴移动指定格数；月精度按日历月移动，避免 2/30 这类月末偏移 */
function shiftCells(ts: number, cells: number, precision: Precision): number {
  if (precision === 'hour') return ts + cells * 3600;
  if (precision === 'day') return ts + cells * DAY;
  if (precision === 'week') return ts + cells * 7 * DAY;
  const d = new Date((ts + CST_OFFSET) * 1000);
  const nd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + cells, 1));
  return Math.floor(nd.getTime() / 1000) - CST_OFFSET;
}

/** 格索引 → 该格起点（北京时间）的 Unix 秒 */
function cellTs(cell: number, precision: Precision): number {
  if (precision === 'hour') return cell * 3600 - CST_OFFSET;
  if (precision === 'day') return cell * DAY - CST_OFFSET;
  if (precision === 'week') return (cell * 7 - 4) * DAY - CST_OFFSET;
  const y = Math.floor(cell / 12);
  const m = cell % 12;
  return Math.floor(Date.UTC(y, m, 1) / 1000) - CST_OFFSET;
}

/** 格内时间插值：frac ∈ [0,1) 为格内比例，用于视口中心像素与时间戳互算 */
function cellTsAt(cell: number, frac: number, precision: Precision): number {
  const a = cellTs(cell, precision);
  const b = cellTs(cell + 1, precision);
  return a + (b - a) * frac;
}

/** 时间戳在时间轴上的像素位置（相对起始格）；月格长不等，按格内比例折算 */
function pixelOf(ts: number, first: number, cellWidth: number, precision: Precision): number {
  const cell = cellIndex(ts, precision);
  const a = cellTs(cell, precision);
  const b = cellTs(cell + 1, precision);
  const frac = b > a ? Math.min(1, Math.max(0, (ts - a) / (b - a))) : 0;
  return (cell - first + frac) * cellWidth;
}

/** 格中心相对起始格的像素位置：今日指针按格中心定位，不做格内插值 */
function cellCenterPx(cell: number, first: number, cellWidth: number): number {
  return (cell - first + 0.5) * cellWidth;
}

/** 视口中心对应的时刻与当前格的时长（秒）；格内插值，避免取整到格起点 */
function readCenter(el: HTMLElement, first: number, cellWidth: number, precision: Precision) {
  const px = el.scrollLeft + el.clientWidth / 2;
  const cell = first + Math.floor(px / cellWidth);
  const frac = (px - (cell - first) * cellWidth) / cellWidth;
  return {
    ts: cellTsAt(cell, frac, precision),
    span: cellTs(cell + 1, precision) - cellTs(cell, precision),
  };
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
  // cellTs 是「北京日历时间」的 Unix 秒，读日期前必须先加回时区偏移，否则整体早一天（小时早 8 小时）
  const d = new Date((cellTs(cellIdx, precision) + CST_OFFSET) * 1000);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (precision === 'hour') {
    // 每天首格只标日期，避免 40px 格子塞不下「11/17 00」而换行
    return cellIdx % 24 === 0 ? md : `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  }
  if (precision === 'day') return md;
  if (precision === 'week') return `${md} 起`;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isWeekendCell(cellIdx: number, precision: Precision): boolean {
  if (precision !== 'hour' && precision !== 'day') return false;
  const dIdx = precision === 'hour' ? Math.floor(cellIdx / 24) : cellIdx;
  const dow = (dIdx + 4) % 7;
  // 周日为 0、周六为 6
  return dow === 0 || dow === 6;
}

/** 条目相对当前时刻的状态：ended / future / active */
function entryState(e: EntryDto, now: number): 'ended' | 'future' | 'active' {
  if (e.endAt !== undefined && e.endAt < now) return 'ended';
  if (e.startAt !== undefined && e.startAt > now) return 'future';
  return 'active';
}

interface GanttRow {
  entry: EntryDto;
  left: number;
  width: number;
  cls: string;
  name: string;
  chip: string;
  /** 起止格索引，供泳道分配判断重叠 */
  sCell: number;
  eCell: number;
}

interface PopoverState {
  entry: EntryDto;
  /** 鼠标位置（视口坐标），浮层以它为锚点，渲染后按实际尺寸收进视口 */
  px: number;
  py: number;
  /** 实际渲染位置（视口坐标） */
  x: number;
  y: number;
  /** 触发元素，关闭后焦点回到这里 */
  anchor: HTMLElement | null;
}

export function WeekPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

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
  const [jumpDate, setJumpDate] = useState(() => fmtCstDate(Math.floor(Date.now() / 1000)));

  const cellWidth = PRECISIONS[PRECISION_INDEX[precision]].cellWidth;
  const now = Math.floor(Date.now() / 1000);

  // 按可见窗口取数，避免拉全量后在前端裁剪
  const entriesQuery = useQuery({
    queryKey: ['entries-week', { gameId, type, keyword, from: view.start, to: view.end }],
    queryFn: () =>
      api.entries({ gameId, type, q: keyword, from: view.start, to: view.end, limit: 1000 }),
    placeholderData: keepPreviousData,
  });

  // 无开始时间的条目与窗口无关，单独取一次用于下方清单
  const unanchoredQuery = useQuery({
    queryKey: ['entries-unanchored', { gameId, type, keyword }],
    queryFn: () => api.entries({ gameId, type, q: keyword, status: 'unknown', limit: 100 }),
    placeholderData: keepPreviousData,
  });

  const entries = entriesQuery.data?.items ?? [];
  // status=unknown 覆盖「缺开始时间」，这里只保留起止皆空的条目，避免与时间轴上的色条重复
  const unanchored = (unanchoredQuery.data?.items ?? []).filter(
    (e) => e.startAt === undefined && e.endAt === undefined,
  );

  const startCell = cellIndex(view.start, precision);
  const endCell = cellIndex(view.end, precision);
  const cellCount = endCell - startCell + 1;

  // 时间轴不足两屏时向两侧补齐：没有滚动条就无法触发自动加载
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const minWidth = el.clientWidth * 2;
    if (cellCount * cellWidth >= minWidth) return;
    const pad = Math.ceil((minWidth / cellWidth - cellCount) / 2) + 1;
    setView((v) => ({ start: shiftCells(v.start, -pad, precision), end: shiftCells(v.end, pad, precision) }));
  }, [precision, cellCount, cellWidth]);

  // 精度切换前记录视口中心时间；窗口补齐后重新居中到同一时间。
  // 普通情况按精确时间居中，避免每次切换偏移并逐次累积；
  // snap 表示「中心就在今天附近」，此时按今日格中心对齐，保证指针落在视口正中。
  // 用 layout effect 保证在浏览器绘制前生效，并在下一帧再校正一次（补齐会改变时间轴总宽）
  const pendingCenterRef = useRef<{ ts: number; snap: boolean } | null>(null);
  const centerRafRef = useRef(0);
  /** 左扩时间轴后需要补偿的滚动量；与居中互斥，避免互相覆盖 */
  const pendingScrollRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCenterRef.current === null) return;
    const el = containerRef.current;
    if (!el) return;
    if (cellCount * cellWidth < el.clientWidth * 2) return;
    const { ts, snap } = pendingCenterRef.current;
    pendingCenterRef.current = null;
    const first = cellIndex(view.start, precision);
    const anchor = snap
      ? cellCenterPx(cellIndex(ts, precision), first, cellWidth)
      : pixelOf(ts, first, cellWidth, precision);
    const apply = () => {
      const box = containerRef.current;
      if (!box) return;
      box.scrollLeft = Math.max(0, anchor - box.clientWidth / 2);
    };
    apply();
    cancelAnimationFrame(centerRafRef.current);
    centerRafRef.current = requestAnimationFrame(apply);
  }, [cellCount, cellWidth, precision, view.start]);

  const changePrecision = (next: Precision) => {
    if (next === precision) return;
    const el = containerRef.current;
    if (el) {
      const first = cellIndex(view.start, precision);
      const { ts, span } = readCenter(el, first, cellWidth, precision);
      // 中心与「此刻」的差距小于半格时视为量化误差，直接对准今日格中心：
      // 粗精度切换后今日指针仍精确居中，而不是带着半格误差落到新精度里
      const nowTs = Math.floor(Date.now() / 1000);
      const nearNow = Math.abs(ts - nowTs) <= span / 2;
      pendingCenterRef.current = nearNow ? { ts: nowTs, snap: true } : { ts, snap: false };
    }
    // 丢弃左扩补偿，避免与居中互相覆盖
    pendingScrollRef.current = null;
    setPrecision(next);
  };

  // 容器高度：视口 70%，下限 400px
  useEffect(() => {
    const apply = () => setContainerHeight(Math.max(400, Math.floor(window.innerHeight * 0.7)));
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  // 宽度变化（窗口缩放、滚动条出现）会让「此刻」偏离视口中心；中心仍在今天附近时重新对准
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    let raf = 0;
    const recenter = () => {
      raf = 0;
      const box = containerRef.current;
      if (!box) return;
      const width = box.clientWidth;
      if (width === lastWidth) return;
      const oldWidth = lastWidth;
      lastWidth = width;
      if (cellCount * cellWidth < width * 2) return;
      const first = cellIndex(view.start, precision);
      // 宽度变化后 scrollLeft 不变，用旧宽度才能还原「变化前用户看着的中心」
      const px = box.scrollLeft + oldWidth / 2;
      const cell = first + Math.floor(px / cellWidth);
      const frac = (px - (cell - first) * cellWidth) / cellWidth;
      const ts = cellTsAt(cell, frac, precision);
      const span = cellTs(cell + 1, precision) - cellTs(cell, precision);
      const nowTs = Math.floor(Date.now() / 1000);
      if (Math.abs(ts - nowTs) > span / 2) return;
      // 指针按今日格中心定位，居中目标也用格中心，避免指针偏在视口中心一侧
      box.scrollLeft = Math.max(0, cellCenterPx(cellIndex(nowTs, precision), first, cellWidth) - width / 2);
    };
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(recenter);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cellCount, cellWidth, precision, view.start]);

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
      if (el) {
        el.style.cursor = '';
        el.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 滚轮：默认纵向滚动（条目多，纵向浏览是主路径）；Shift+滚轮横向；触控板横向手势保持横向
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY || e.deltaX;
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        el.scrollLeft += e.deltaX;
        return;
      }
      e.preventDefault();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 点击空白关闭 popover（不抢焦点）
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-entry-id]') && !target?.closest('[data-popover]')) setPopover(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // 浮层：打开时聚焦首个可交互元素，Esc 关闭并把焦点还给触发元素
  useEffect(() => {
    if (!popover) return;
    popoverRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPopover((current) => {
        if (current?.anchor && document.contains(current.anchor)) current.anchor.focus();
        return null;
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [popover]);

  // 左扩时间轴后补偿滚动位置，保持当前可视内容不动
  useEffect(() => {
    if (pendingScrollRef.current === null) return;
    const el = containerRef.current;
    if (el) el.scrollLeft += pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [view]);

  const loadEarlier = useCallback(() => {
    const newStart = shiftCells(view.start, -LOAD_CELLS, precision);
    const added = (cellIndex(view.start, precision) - cellIndex(newStart, precision)) * cellWidth;
    pendingScrollRef.current = added;
    setView((v) => ({ ...v, start: newStart }));
  }, [view.start, precision, cellWidth]);

  const loadLater = useCallback(() => {
    setView((v) => ({ ...v, end: shiftCells(v.end, LOAD_CELLS, precision) }));
  }, [precision]);

  // 初载把今日指针居中；窗口补齐后再次尝试，只执行一次
  const centeredRef = useRef(false);
  useEffect(() => {
    if (centeredRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    if (cellCount * cellWidth < el.clientWidth * 2) return;
    const ts = Math.floor(Date.now() / 1000);
    const first = cellIndex(view.start, precision);
    // 让今日指针（今日格中心）落在视口正中
    el.scrollLeft = Math.max(0, cellCenterPx(cellIndex(ts, precision), first, cellWidth) - el.clientWidth / 2);
    centeredRef.current = true;
  }, [cellCount, cellWidth, precision, view.start]);

  // 滚到两端附近自动扩展窗口，不再依赖手动按钮
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    let lastTrigger = 0;
    const check = () => {
      raf = 0;
      const threshold = cellWidth * 2;
      const maxLeft = el.scrollWidth - el.clientWidth;
      if (maxLeft <= threshold) return;
      const t = Date.now();
      if (t - lastTrigger < 300) return;
      if (el.scrollLeft <= threshold) {
        lastTrigger = t;
        loadEarlier();
      } else if (maxLeft - el.scrollLeft <= threshold) {
        lastTrigger = t;
        loadLater();
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [loadEarlier, loadLater, cellWidth]);

  // 日期定位：目标不在窗口内时先扩展窗口，再滚动到该格居中
  const jumpTargetRef = useRef<number | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  const jumpTo = (ts: number) => {
    jumpTargetRef.current = ts;
    setJumpTick((n) => n + 1);
  };
  useEffect(() => {
    const target = jumpTargetRef.current;
    if (target === null) return;
    const el = containerRef.current;
    const cell = cellIndex(target, precision);
    const first = cellIndex(view.start, precision);
    if (cell < first || cell > cellIndex(view.end, precision)) {
      const monday = weekMonday(target);
      setView({ start: monday - INITIAL_WEEKS * 7 * DAY, end: monday + INITIAL_WEEKS * 7 * DAY });
      return;
    }
    if (!el) return;
    // 目标日期的格子居中，而非精确时刻居中
    el.scrollLeft = Math.max(0, cellCenterPx(cell, first, cellWidth) - el.clientWidth / 2);
    jumpTargetRef.current = null;
  }, [jumpTick, view, precision, cellWidth]);

  // 分组与排序：已结束沉底，缺值沉底；行内按时间重叠分配泳道
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
    return ids
      .map((id) => {
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
        const rows = list
          .map((e) => renderRow(e, startCell, endCell, cellWidth, now, precision))
          .filter((r): r is GanttRow => r !== null);
        return { gameId: id, count: rows.length, lanes: packLanes(rows) };
      })
      .filter((group) => group.count > 0);
  }, [entries, gamesQuery.data, onlyActive, sort, order, now, startCell, endCell, cellWidth, precision]);

  const todayCell = cellIndex(now, precision);
  // 今日指针只表达「今天在这一格」，中轴线对准今日格中心，不反映格内精确时刻
  const todayLeft = cellCenterPx(todayCell, startCell, cellWidth);
  const todayVisible = todayCell >= startCell && todayCell <= endCell;

  const openPopover = useCallback((entry: EntryDto, e: ReactMouseEvent<HTMLElement>) => {
    // 以鼠标位置为锚点，超出视口的部分在渲染后的 layout effect 里收回
    const px = e.clientX;
    const py = e.clientY;
    setPopover({ entry, px, py, x: px, y: py, anchor: e.currentTarget });
  }, []);

  // 浮层宽高在渲染后才确定：按鼠标位置摆放，再整体收进视口（右侧不够就翻到左侧，底部不够就翻到上方）
  useLayoutEffect(() => {
    if (!popover) return;
    const el = popoverRef.current;
    if (!el) return;
    const gap = 12;
    const margin = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = popover.px + gap;
    if (x + w + margin > window.innerWidth) x = Math.max(margin, popover.px - w - gap);
    x = Math.min(x, Math.max(margin, window.innerWidth - w - margin));
    let y = popover.py + gap;
    if (y + h + margin > window.innerHeight) y = Math.max(margin, popover.py - h - gap);
    y = Math.min(y, Math.max(margin, window.innerHeight - h - margin));
    if (x !== popover.x || y !== popover.y) setPopover({ ...popover, x, y });
  }, [popover]);

  const timelineStyle = {
    '--cell-width': `${cellWidth}px`,
    '--row-height': `${rowHeight}px`,
    '--gantt-h': `${containerHeight}px`,
    // 小时精度用它画每日分隔线，其余精度不生效（由 .is-hour 限定）
    '--day-width': `${cellWidth * 24}px`,
    width: `${cellCount * cellWidth}px`,
  } as CSSProperties;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <label className="flex items-center gap-1">
            <span className="text-muted">游戏</span>
            <select className={fieldClass} value={gameId} onChange={(e) => patch({ gameId: e.target.value || null })}>
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
            <select className={fieldClass} value={type} onChange={(e) => patch({ type: e.target.value || null })}>
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
              className={`w-[170px] ${fieldClass}`}
              placeholder="活动名 / 分类 / 摘要"
              value={keyword}
              onChange={(e) => patch({ q: e.target.value || null })}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">排序</span>
            <select
              className={fieldClass}
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
            className={btnSecondary}
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
            className={btnSecondary}
            onClick={() => patch({ gameId: null, type: null, q: null, sort: null, order: null, active: null })}
          >
            重置
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <div className="flex items-center gap-1">
            <span className="text-muted">精度</span>
            <div className="flex overflow-hidden rounded border border-line">
              {PRECISIONS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={precision === p.key}
                  className={`px-2 py-1 text-[12px] ${precision === p.key ? 'bg-brand text-white' : 'bg-surface text-ink hover:bg-bg'}`}
                  onClick={() => changePrecision(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">行高</span>
            <div className="flex overflow-hidden rounded border border-line">
              {ROW_HEIGHTS.map((h) => (
                <button
                  key={h.value}
                  type="button"
                  aria-pressed={rowHeight === h.value}
                  className={`px-2 py-1 text-[12px] ${rowHeight === h.value ? 'bg-brand text-white' : 'bg-surface text-ink hover:bg-bg'}`}
                  onClick={() => setRowHeight(h.value)}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted">定位</span>
            <input
              type="date"
              className={fieldClass}
              value={jumpDate}
              aria-label="定位到日期"
              onChange={(e) => {
                setJumpDate(e.target.value);
                const ts = cstDateStart(e.target.value);
                if (ts !== undefined) jumpTo(ts);
              }}
            />
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setJumpDate(fmtCstDate(now));
                jumpTo(now);
              }}
            >
              回到今天
            </button>
          </div>
          <span className="ml-auto text-[12px] text-muted">
            滚轮纵移 · Shift+滚轮横移 · 拖动平移 · ←/→ 平移 · 到两端自动加载
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2.5 w-9 rounded-sm bg-brand" />
            进行中
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2.5 w-9 rounded-sm border border-dashed border-brand bg-brand opacity-[0.45]" />
            未开始
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2.5 w-9 rounded-sm bg-muted opacity-75" />
            <span className="line-through">已结束</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2.5 w-0.5 bg-brand" />
            今天
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-flex h-2.5 w-9 items-center justify-end rounded-sm bg-neutral-weak pr-0.5">
              <span className="h-0 w-0 border-y-[3px] border-y-transparent border-l-[5px] border-l-muted" />
            </span>
            箭头 = 延续到窗口外
          </span>
        </div>
      </Card>

      <QueryState loading={false} error={entriesQuery.error} onRetry={() => entriesQuery.refetch()} />

      <div
        ref={containerRef}
        className="gantt-container"
        style={{ height: containerHeight }}
        tabIndex={0}
        role="group"
        aria-label="活动时间轴，左右方向键平移，Home 回到今天"
        onKeyDown={(e) => {
          const el = containerRef.current;
          // 只处理容器自身获得焦点时的按键，避免劫持内部按钮
          if (!el || e.target !== e.currentTarget) return;
          const step = cellWidth * 4;
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            el.scrollLeft -= step;
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            el.scrollLeft += step;
          } else if (e.key === 'Home') {
            e.preventDefault();
            jumpTo(Math.floor(Date.now() / 1000));
          }
        }}
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
          if (containerRef.current) {
            containerRef.current.style.cursor = 'grabbing';
            // 拖动期间禁用文本选择，否则横向拖动会选中条目名
            containerRef.current.style.userSelect = 'none';
          }
        }}
      >
        <div className={`gantt-timeline${precision === 'hour' ? ' is-hour' : ''}`} style={timelineStyle}>
          <div className="gantt-header">
            {Array.from({ length: cellCount }, (_, i) => {
              const c = startCell + i;
              const cls = [
                'gantt-header-cell',
                isWeekendCell(c, precision) ? 'weekend' : '',
                precision === 'hour' && c % 24 === 0 ? 'day-start' : '',
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
              const isCollapsed = Boolean(collapsed[group.gameId]);
              return (
                <div key={group.gameId}>
                  <div
                    className="gantt-group-header"
                    style={{ '--group-bg': theme.bg, borderLeft: `4px solid ${theme.accent}` } as CSSProperties}
                    role="button"
                    tabIndex={0}
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group.gameId]: !prev[group.gameId] }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setCollapsed((prev) => ({ ...prev, [group.gameId]: !prev[group.gameId] }));
                      }
                    }}
                  >
                    <span className="gantt-fold">{isCollapsed ? '▸' : '▾'}</span>
                    {gameName(group.gameId)}
                    <span className="count">({group.count})</span>
                  </div>
                  <div className={`gantt-group-body${isCollapsed ? ' is-collapsed' : ''}`}>
                    {group.lanes.map((lane, laneIndex) => (
                      <div key={`lane-${laneIndex}`} className="gantt-row">
                        {lane.map((row) => (
                          <button
                            key={row.entry.id}
                            type="button"
                            className={row.cls}
                            data-entry-id={row.entry.id}
                            aria-label={`${row.name} · ${row.chip} · ${STATE_LABEL[entryState(row.entry, now)]}`}
                            style={{ left: row.left, width: row.width, backgroundColor: typeColor(row.entry.type) }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (movedRef.current) return;
                              openPopover(row.entry, e);
                            }}
                          >
                            <span className="gantt-label">
                              <span className="gantt-name" title={row.name}>
                                {row.name}
                              </span>
                              <span className="gantt-chip">{row.chip}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {entriesQuery.isLoading ? <div className="gantt-empty">加载中…</div> : null}
            {!entriesQuery.isLoading && groups.length === 0 ? (
              <div className="gantt-empty">当前筛选条件下无活动</div>
            ) : null}
          </div>
        </div>
      </div>

      {unanchored.length > 0 ? (
        <Card>
          <h2 className="mb-1 border-l-4 border-brand pl-2 text-[15px] font-semibold">
            时间待确认 <span className="text-[12px] font-normal text-muted">（{unanchored.length}，无起止时间）</span>
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
          ref={popoverRef}
          data-popover
          className="fixed z-50 w-[360px] rounded-lg border border-line bg-surface p-3 text-[13px] shadow-lg"
          style={{ left: popover.x, top: popover.y }}
          role="dialog"
          aria-label="活动详情"
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

/** 贪心分配泳道：起点升序，找第一条已结束的泳道复用 */
function packLanes(rows: GanttRow[]): GanttRow[][] {
  const sorted = [...rows].sort((a, b) => a.sCell - b.sCell || a.eCell - b.eCell);
  const lanes: { end: number; items: GanttRow[] }[] = [];
  for (const row of sorted) {
    const lane = lanes.find((l) => l.end < row.sCell);
    if (lane) {
      lane.end = row.eCell;
      lane.items.push(row);
    } else {
      lanes.push({ end: row.eCell, items: [row] });
    }
  }
  return lanes.map((l) => l.items);
}

/** 计算单条在渲染窗口内的色条几何；两端皆无或完全在窗口外返回 null */
function renderRow(
  e: EntryDto,
  startCell: number,
  endCell: number,
  cellWidth: number,
  now: number,
  precision: Precision,
): GanttRow | null {
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
  return { entry: e, left, width, cls: cls.join(' '), name, chip, sCell: sIdx, eCell: eIdx };
}
