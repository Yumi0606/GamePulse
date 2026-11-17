import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDateStart, currentCstMonth, fmtBound, fmtCstDate } from '../lib/format';
import { gameTheme } from '../lib/game-theme';
import { useGameName, useGames } from '../lib/hooks';
import { Card, Empty, Pagination, QueryState, btnSecondary, fieldClass } from '../components/ui';
import { FilterField, FilterGrid, FilterPanel, controlClass } from '../components/Filters';

/**
 * 日历视图（按月，北京时间）。
 *
 * 编码约定：
 * - 跨天活动只画一条持续条，条两端的圆点 / 三角表示开始与结束，不再进入当日列表；
 * - 当日列表只放单日活动与奖励截止，超过 3 条折叠为 +N；
 * - 持续条按周做泳道打包，同一周内互不重叠的活动复用一行；
 * - 跨月截断处用 ‹ › 标记，不误读为完整周期。
 *
 * 取数按可见月份向服务端请求区间重叠的条目，不再拉全量；
 * 无开始时间的条目单独查一次，与月份无关。
 */
const DAY = 86400;
const MAX_PER_CELL = 3;
/** 每周默认展示的跨天泳道数，超出折叠 */
const MAX_LANES = 3;
/** 「时间待确认」列表每页条数 */
const UNANCHORED_PAGE = 10;

type PointClass = 'start' | 'end' | 'reward' | 'single';

interface DayPoint {
  cls: PointClass;
  text: string;
  tip: string;
  entryId: string;
}

interface Span {
  s: number;
  e: number;
  contL: boolean;
  contR: boolean;
  title: string;
  tip: string;
  gameId: string;
  entryId: string;
}

interface Segment {
  colStart: number;
  colspan: number;
  lead: string;
  trail: string;
  title: string;
  tip: string;
  gameId: string;
  entryId: string;
  /** 本周内可见的起止端，用于画条端标记 */
  startMark: boolean;
  endMark: boolean;
}

const POINT_STYLE: Record<PointClass, string> = {
  start: 'bg-ok-weak text-ok',
  end: 'bg-danger-weak text-danger',
  reward: 'bg-warn-weak text-warn',
  single: 'bg-neutral-weak text-ink-soft',
};

/**
 * 点位图标：颜色之外的第二重编码。
 * 用显式尺寸的图形而非字符，避免不同字体下 ▶ 与 ■ 视觉大小不一致。
 */
function PointIcon({ cls }: { cls: PointClass }) {
  if (cls === 'start') {
    // 大号三角形：10px 高 × 10px 宽
    return (
      <span
        aria-hidden
        className="h-0 w-0 shrink-0 border-y-[5px] border-y-transparent border-l-[10px] border-l-current"
      />
    );
  }
  if (cls === 'end') {
    // 大号实心正方形，与三角形整体尺寸一致
    return <span aria-hidden className="h-[10px] w-[10px] shrink-0 bg-current" />;
  }
  if (cls === 'single') {
    return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-current" />;
  }
  return (
    <span aria-hidden className="shrink-0 text-[12px] leading-none">
      ⚑
    </span>
  );
}

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(new Set());
  const [unanchoredOpen, setUnanchoredOpen] = useState(false);
  const [unanchoredPage, setUnanchoredPage] = useState(1);

  const gameId = params.get('gameId') ?? '';
  const type = params.get('type') ?? '';
  const rawMonth = params.get('month');
  const month = rawMonth && /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : currentCstMonth();

  const patch = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  // 可见月份覆盖的闭区间，含跨月活动
  const monthRange = useMemo(() => {
    const [year, monthNum] = month.split('-').map(Number);
    const next = monthNum === 12 ? `${year + 1}-01` : `${year}-${String(monthNum + 1).padStart(2, '0')}`;
    return { start: cstDateStart(`${month}-01`)!, end: cstDateStart(`${next}-01`)! - 1 };
  }, [month]);

  const entriesQuery = useQuery({
    queryKey: ['entries-calendar', { gameId, type, from: monthRange.start, to: monthRange.end }],
    queryFn: () =>
      api.entries({ gameId, type, from: monthRange.start, to: monthRange.end, sort: 'start', limit: 500 }),
    placeholderData: keepPreviousData,
  });

  const unanchoredQuery = useQuery({
    queryKey: ['entries-unanchored', { gameId, type }],
    queryFn: () => api.entries({ gameId, type, status: 'unknown', limit: 100 }),
    placeholderData: keepPreviousData,
  });

  const entries = entriesQuery.data?.items ?? [];
  const model = useMemo(() => buildMonthModel(entries, month), [entries, month]);
  // status=unknown 覆盖「缺开始时间」，这里只保留起止皆空的条目，避免与网格里的结束点重复
  const unanchored = (unanchoredQuery.data?.items ?? []).filter(
    (e) => e.startAt === undefined && e.endAt === undefined,
  );
  const unanchoredPageCount = Math.max(1, Math.ceil(unanchored.length / UNANCHORED_PAGE));
  const unanchoredCurrent = Math.min(unanchoredPage, unanchoredPageCount);
  const unanchoredVisible = unanchored.slice(
    (unanchoredCurrent - 1) * UNANCHORED_PAGE,
    unanchoredCurrent * UNANCHORED_PAGE,
  );

  const [year, monthNum] = month.split('-').map(Number);
  const prevMonth = monthNum === 1 ? `${year - 1}-12` : `${year}-${String(monthNum - 1).padStart(2, '0')}`;
  const nextMonth = monthNum === 12 ? `${year + 1}-01` : `${year}-${String(monthNum + 1).padStart(2, '0')}`;

  const toggleDay = (dateStr: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  };

  const toggleWeek = (weekIndex: number) => {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(weekIndex)) next.delete(weekIndex);
      else next.add(weekIndex);
      return next;
    });
  };

  const today = fmtCstDate(Math.floor(Date.now() / 1000));

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" className={btnSecondary} aria-label="上个月" onClick={() => patch({ month: prevMonth })}>
              ‹
            </button>
            <input
              type="month"
              className={fieldClass}
              aria-label="选择月份"
              value={month}
              onChange={(e) => {
                if (/^\d{4}-\d{2}$/.test(e.target.value)) patch({ month: e.target.value });
              }}
            />
            <button type="button" className={btnSecondary} aria-label="下个月" onClick={() => patch({ month: nextMonth })}>
              ›
            </button>
            <button type="button" className={`${btnSecondary} ml-1`} onClick={() => patch({ month: null })}>
              回到今天
            </button>
          </div>
          <span className="text-[12px] text-muted">
            {entriesQuery.isFetching ? '加载中…' : `${month} · 本月 ${entries.length} 条`}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1 text-ok">
            <PointIcon cls="start" />
            开始
          </span>
          <span className="inline-flex items-center gap-1 text-danger">
            <PointIcon cls="end" />
            结束
          </span>
          <span className="inline-flex items-center gap-1 text-warn">
            <PointIcon cls="reward" />
            奖励截止
          </span>
          <span className="inline-flex items-center gap-1 text-ink-soft">
            <PointIcon cls="single" />
            单日活动
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-flex h-2.5 w-9 items-center rounded-sm bg-neutral-weak px-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-soft" />
              <span className="ml-auto h-0 w-0 border-y-[3px] border-y-transparent border-l-[5px] border-l-ink-soft" />
            </span>
            跨天持续（左圆点 = 开始，右三角 = 结束）
          </span>
        </div>

      </Card>

      <FilterPanel
        primary={
          <FilterGrid>
            <FilterField label="游戏" className="lg:col-span-2">
              <select
                className={controlClass}
                aria-label="游戏"
                value={gameId}
                onChange={(e) => patch({ gameId: e.target.value || null })}
              >
                <option value="">全部游戏</option>
                {(gamesQuery.data?.items ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="分类" className="lg:col-span-2">
              <select
                className={controlClass}
                aria-label="分类"
                value={type}
                onChange={(e) => patch({ type: e.target.value || null })}
              >
                <option value="">全部分类</option>
                {ENTRY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ENTRY_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </FilterField>
          </FilterGrid>
        }
        note="当日超过 3 条时用 +N 展开"
        actions={
          expanded.size > 0 ? (
            <button type="button" className={btnSecondary} onClick={() => setExpanded(new Set())}>
              收起全部展开日
            </button>
          ) : null
        }
        resetEnabled={Boolean(gameId || type || expanded.size > 0)}
        onReset={() => {
          setExpanded(new Set());
          patch({ gameId: null, type: null });
        }}
      />

      <QueryState loading={false} error={entriesQuery.error} onRetry={() => entriesQuery.refetch()} />

      {/* 固定渲染网格：数据到达前后高度一致，不会整块跳动 */}
      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-7 border-b border-line bg-bg text-center text-[12px] text-muted">
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>

        {model.weeks.map((week) => {
          const weekOpen = expandedWeeks.has(week.index);
          const lanes = weekOpen ? week.lanes : week.lanes.slice(0, MAX_LANES);
          return (
          <div key={week.index} className="border-b border-line last:border-b-0">
            {lanes.map((lane, laneIndex) => (
              <div key={`lane-${laneIndex}`} className="grid grid-cols-7 gap-x-1 px-1 pt-1">
                {lane.map((seg) => {
                  const theme = gameTheme(seg.gameId);
                  return (
                    <a
                      key={`${seg.entryId}-${seg.colStart}`}
                      href={`/app/all?entry=${encodeURIComponent(seg.entryId)}`}
                      className="flex min-w-0 items-center gap-1 overflow-hidden rounded px-1.5 text-[11px]"
                      style={{
                        gridColumn: `${seg.colStart + 1} / span ${seg.colspan}`,
                        background: theme.bg,
                        color: theme.fg,
                        borderLeft: `3px solid ${theme.accent}`,
                      }}
                      title={seg.tip}
                    >
                      {seg.startMark ? (
                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                      ) : null}
                      <span className="truncate">
                        {seg.lead}
                        {seg.title}
                        {seg.trail}
                      </span>
                      {seg.endMark ? (
                        <span
                          aria-hidden
                          className="ml-auto h-0 w-0 shrink-0 border-y-[3px] border-y-transparent border-l-[5px] border-l-current"
                        />
                      ) : null}
                    </a>
                  );
                })}
              </div>
            ))}

            {week.lanes.length > MAX_LANES ? (
              <div className="px-1 pt-1">
                <button
                  type="button"
                  className="text-[11px] text-muted hover:text-ink hover:underline"
                  aria-expanded={weekOpen}
                  onClick={() => toggleWeek(week.index)}
                >
                  {weekOpen ? '收起跨天活动' : `还有 ${week.lanes.length - MAX_LANES} 行跨天活动`}
                </button>
              </div>
            ) : null}

            <div className="grid grid-cols-7 gap-x-1 p-1">
              {week.days.map((day, col) => {
                if (day === null) return <div key={`pad-${week.index}-${col}`} className="min-h-[84px] rounded bg-bg-sunk" />;
                const isExpanded = expanded.has(day.dateStr);
                const visible = isExpanded ? day.points : day.points.slice(0, MAX_PER_CELL);
                const rest = day.points.length - MAX_PER_CELL;
                const weekend = day.col >= 5;
                const isToday = day.dateStr === today;
                return (
                  <div
                    key={day.dateStr}
                    className={`min-h-[84px] rounded border border-line px-1 pb-1 ${weekend ? 'bg-weekend' : 'bg-surface'} ${isToday ? 'ring-1 ring-inset ring-brand' : ''}`}
                  >
                    <div className={`text-[11px] ${isToday ? 'font-semibold text-brand' : 'text-muted'}`}>{day.index + 1}</div>
                    {visible.map((p, i) => (
                      <a
                        key={`${p.entryId}-${p.cls}-${i}`}
                        href={`/app/all?entry=${encodeURIComponent(p.entryId)}`}
                        className={`mt-0.5 flex items-center gap-1 truncate rounded px-1 text-[11px] ${POINT_STYLE[p.cls]}`}
                        title={p.tip}
                      >
                        <PointIcon cls={p.cls} />
                        <span className="truncate">{p.text}</span>
                      </a>
                    ))}
                    {rest > 0 ? (
                      <button
                        type="button"
                        className="mt-0.5 block w-full rounded text-left text-[11px] text-muted hover:text-ink hover:underline"
                        aria-expanded={isExpanded}
                        onClick={() => toggleDay(day.dateStr)}
                      >
                        {isExpanded ? '收起' : `+${rest}`}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          );
        })}
      </Card>

      {!entriesQuery.isLoading && entries.length === 0 ? <Empty>当月无任何条目</Empty> : null}

      {unanchored.length > 0 ? (
        <Card>
          <button
            type="button"
            className="flex w-full flex-wrap items-baseline gap-2 text-left"
            aria-expanded={unanchoredOpen}
            onClick={() => setUnanchoredOpen((value) => !value)}
          >
            <span className="border-l-4 border-brand pl-2 text-[15px] font-semibold">时间待确认</span>
            <span className="text-[12px] font-normal text-muted">（{unanchored.length}，只有引用型时间）</span>
            <span className="ml-auto text-[12px] text-brand">{unanchoredOpen ? '收起' : '展开'}</span>
          </button>
          {unanchoredOpen ? (
            <>
              {unanchoredPageCount > 1 ? (
                <div className="mt-1.5 border-y border-line px-1 py-1">
                  <Pagination
                    page={unanchoredCurrent}
                    pageSize={UNANCHORED_PAGE}
                    total={unanchored.length}
                    onChange={setUnanchoredPage}
                  />
                </div>
              ) : null}
              <ul className="mt-1 divide-y divide-line text-[13px]">
                {unanchoredVisible.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
                    <span className="text-muted">{gameName(e.gameId)}</span>
                    <a href={`/app/all?entry=${encodeURIComponent(e.id)}`}>{e.title}</a>
                    <span className="text-[12px] text-muted">
                      {[e.startRef?.refText, e.endRef?.refText]
                        .filter(Boolean)
                        .map((t) => `［${t as string}］`)
                        .join(' ')}
                    </span>
                  </li>
                ))}
              </ul>
              {unanchoredPageCount > 1 ? (
                <div className="mt-1 border-t border-line px-1 py-1">
                  <Pagination
                    page={unanchoredCurrent}
                    pageSize={UNANCHORED_PAGE}
                    total={unanchored.length}
                    onChange={setUnanchoredPage}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

/** 把条目铺进指定月份：返回周列表、跨天持续条泳道与待锚定条目 */
function buildMonthModel(
  entries: EntryDto[],
  month: string,
): {
  weeks: {
    index: number;
    lanes: Segment[][];
    days: ({ index: number; col: number; dateStr: string; points: DayPoint[] } | null)[];
  }[];
} {
  const monthStart = cstDateStart(`${month}-01`)!;
  const [year, monthNum] = month.split('-').map(Number);
  const next = monthNum === 12 ? `${year + 1}-01` : `${year}-${String(monthNum + 1).padStart(2, '0')}`;
  const monthEnd = cstDateStart(`${next}-01`)!;
  const days = Math.round((monthEnd - monthStart) / DAY);
  // 当月 1 号是周几（周一=0）
  const firstDow = (new Date((monthStart + 8 * 3600) * 1000).getUTCDay() + 6) % 7;
  const dayIndexOf = (ts: number): number => Math.floor((ts - monthStart) / DAY);

  const buckets: DayPoint[][] = Array.from({ length: days }, () => []);
  const spans: Span[] = [];

  for (const e of entries) {
    const estTip = e.estimated ? '（预估）' : '';
    const si = e.startAt !== undefined ? dayIndexOf(e.startAt) : undefined;
    const ei = e.endAt !== undefined ? dayIndexOf(e.endAt) : undefined;

    if (si !== undefined && ei !== undefined && ei > si) {
      // 跨天活动只保留持续条，起止日不再进当日列表
      if (ei >= 0 && si <= days - 1) {
        spans.push({
          s: Math.max(si, 0),
          e: Math.min(ei, days - 1),
          contL: si < 0,
          contR: ei > days - 1,
          title: e.title,
          tip: `持续：${e.title}${estTip}（${fmtBound(e.startAt, e.startTimeKnown)} → ${fmtBound(e.endAt, e.endTimeKnown)}）`,
          gameId: e.gameId,
          entryId: e.id,
        });
      }
    } else if (si !== undefined) {
      // 单日活动，或只有开始时间
      if (si >= 0 && si < days) {
        const single = ei === si;
        buckets[si].push({
          cls: single ? 'single' : 'start',
          text: e.title,
          tip: `${single ? '活动' : '开始'}：${e.title}${estTip}`,
          entryId: e.id,
        });
      }
    } else if (ei !== undefined && ei >= 0 && ei < days) {
      // 只有结束时间
      buckets[ei].push({ cls: 'end', text: e.title, tip: `结束：${e.title}`, entryId: e.id });
    }

    if (e.rewardEndAt !== undefined) {
      const ri = dayIndexOf(e.rewardEndAt);
      if (ri >= 0 && ri < days) {
        buckets[ri].push({
          cls: 'reward',
          text: e.title,
          tip: `奖励截止：${e.title}（${fmtCst(e.rewardEndAt)}）`,
          entryId: e.id,
        });
      }
    }
  }

  const weekCount = Math.ceil((firstDow + days) / 7);
  const weeks = Array.from({ length: weekCount }, (_, w) => {
    const weekStart = w * 7 - firstDow;
    const segments: Segment[] = spans
      .map((sp) => {
        const a = Math.max(sp.s, weekStart);
        const b = Math.min(sp.e, weekStart + 6);
        return { sp, a, b };
      })
      .filter((x) => x.b >= x.a)
      .sort((x, z) => x.a - z.a || x.b - z.b)
      .map(({ sp, a, b }) => {
        const isFirst = a === sp.s;
        const isLast = b === sp.e;
        return {
          colStart: a - weekStart,
          colspan: b - a + 1,
          lead: isFirst && sp.contL ? '‹ ' : '',
          trail: isLast && sp.contR ? ' ›' : '',
          title: sp.title,
          tip: `${sp.tip}${isFirst && sp.contL ? '（延续自上月）' : ''}${isLast && sp.contR ? '（延续至下月）' : ''}`,
          gameId: sp.gameId,
          entryId: sp.entryId,
          startMark: isFirst,
          endMark: isLast,
        };
      });

    // 贪心泳道：同列不重叠的持续条复用一行
    const laneEnd: number[] = [];
    const lanes: Segment[][] = [];
    for (const seg of segments) {
      let lane = laneEnd.findIndex((end) => end < seg.colStart);
      if (lane < 0) {
        lane = laneEnd.length;
        laneEnd.push(-1);
        lanes.push([]);
      }
      laneEnd[lane] = seg.colStart + seg.colspan - 1;
      lanes[lane].push(seg);
    }

    const cellDays = Array.from({ length: 7 }, (_, col) => {
      const d = weekStart + col;
      if (d < 0 || d >= days) return null;
      const dateStr = `${month}-${String(d + 1).padStart(2, '0')}`;
      return { index: d, col, dateStr, points: buckets[d] };
    });

    return { index: w, lanes, days: cellDays };
  });

  return { weeks };
}
