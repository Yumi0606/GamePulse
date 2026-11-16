import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EntryDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { currentCstMonth, fmtBound, fmtCstDate } from '../lib/format';
import { gameTheme } from '../lib/game-theme';
import { useGameName, useGames } from '../lib/hooks';
import { Card, Empty, QueryState } from '../components/ui';

/**
 * 日历视图（按月，北京时间）。
 *
 * 表达方式与旧版一致：
 * - 起止跨越 3 格以上的活动画成横跨持续条（按周单独成行）；
 * - 其余落点（开始 / 结束 / 奖励截止）进当天单元格，超过 3 条折叠为 +N；
 * - 跨月截断处用 ‹ › 标记，不误读为完整周期。
 *
 * 条目量级小（全库数百条），一次拉全量在前端按月切分；筛选走服务端。
 */
const DAY = 86400;
const MAX_PER_CELL = 3;

type PointClass = 'start' | 'end' | 'reward';

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

const POINT_STYLE: Record<PointClass, string> = {
  start: 'bg-ok-weak text-ok',
  end: 'bg-danger-weak text-danger',
  reward: 'bg-warn-weak text-warn',
};

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const gameId = params.get('gameId') ?? '';
  const type = params.get('type') ?? '';
  const month = params.get('month') ?? currentCstMonth();

  const patch = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const entriesQuery = useQuery({
    queryKey: ['entries-calendar', { gameId, type }],
    queryFn: () => api.entries({ gameId, type, limit: 1000 }),
    placeholderData: keepPreviousData,
  });

  const model = useMemo(() => buildMonthModel(entriesQuery.data?.items ?? [], month), [entriesQuery.data, month]);

  const [year, monthNum] = month.split('-').map(Number);
  const prevMonth = monthNum === 1 ? `${year - 1}-12` : `${year}-${String(monthNum - 1).padStart(2, '0')}`;
  const nextMonth = monthNum === 12 ? `${year + 1}-01` : `${year}-${String(monthNum + 1).padStart(2, '0')}`;

  const toggleDay = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const today = fmtCstDate(Math.floor(Date.now() / 1000));

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-[13px]">
            <button type="button" className="rounded border border-line px-2 py-0.5" onClick={() => patch({ month: prevMonth })}>
              ‹ 上月
            </button>
            <button type="button" className="rounded border border-line px-2 py-0.5" onClick={() => patch({ month: nextMonth })}>
              下月 ›
            </button>
            <button type="button" className="rounded border border-line px-2 py-0.5" onClick={() => patch({ month: null })}>
              今天
            </button>
          </div>
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            {month}
            <input
              type="month"
              className="rounded border border-line px-1 py-0.5 text-[12px] font-normal"
              value={month}
              onChange={(e) => {
                if (/^\d{4}-\d{2}$/.test(e.target.value)) patch({ month: e.target.value });
              }}
            />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
          <span className="text-muted">图例：</span>
          <span className={`rounded px-1 ${POINT_STYLE.start}`}>始</span>
          <span className="text-muted">开始</span>
          <span className={`rounded px-1 ${POINT_STYLE.end}`}>终</span>
          <span className="text-muted">结束</span>
          <span className={`rounded px-1 ${POINT_STYLE.reward}`}>奖</span>
          <span className="text-muted">奖励截止</span>
          <span className="rounded bg-neutral-weak px-1 text-ink-soft">活动名</span>
          <span className="text-muted">持续中（跨天）</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
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
          <button
            type="button"
            className="rounded border border-line px-2 py-1"
            onClick={() => {
              setExpanded(new Set());
              patch({ gameId: null, type: null });
            }}
          >
            重置
          </button>
          <span className="text-[12px] text-muted">点击单元格空白或 +N 展开/收起当日全部事件</span>
        </div>
      </Card>

      <QueryState loading={entriesQuery.isLoading} error={entriesQuery.error} />

      {entriesQuery.data ? (
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-7 border-b border-line bg-bg text-center text-[12px] text-muted">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>

          {model.weeks.map((week) => (
            <div key={week.index} className="border-b border-line last:border-b-0">
              {week.segments.map((seg, i) => {
                const theme = gameTheme(seg.gameId);
                return (
                  <div key={`${seg.entryId}-${i}`} className="grid grid-cols-7 gap-x-1 px-1 pt-1">
                    <a
                      href={`/app/all?entry=${encodeURIComponent(seg.entryId)}`}
                      className="block truncate rounded px-1.5 text-[11px]"
                      style={{ gridColumn: `${seg.colStart + 1} / span ${seg.colspan}`, background: theme.bg, color: theme.fg, borderLeft: `3px solid ${theme.accent}` }}
                      title={seg.tip}
                    >
                      {seg.lead}
                      {seg.title}
                      {seg.trail}
                    </a>
                  </div>
                );
              })}

              <div className="grid grid-cols-7 gap-x-1 p-1">
                {week.days.map((day, col) => {
                  if (day === null) return <div key={`pad-${week.index}-${col}`} className="min-h-[84px] rounded bg-bg-sunk" />;
                  const isExpanded = expanded.has(day.index);
                  const visible = isExpanded ? day.points : day.points.slice(0, MAX_PER_CELL);
                  const rest = day.points.length - MAX_PER_CELL;
                  const weekend = day.col >= 5;
                  const isToday = day.dateStr === today;
                  return (
                    <div
                      key={day.index}
                      className={`min-h-[84px] cursor-pointer rounded border border-line px-1 pb-1 ${weekend ? 'bg-weekend' : 'bg-surface'} ${isToday ? 'ring-1 ring-inset ring-brand' : ''}`}
                      onClick={() => toggleDay(day.index)}
                    >
                      <div className={`text-[11px] ${isToday ? 'font-semibold text-brand' : 'text-muted'}`}>{day.index + 1}</div>
                      {visible.map((p, i) => (
                        <a
                          key={`${p.entryId}-${p.cls}-${i}`}
                          href={`/app/all?entry=${encodeURIComponent(p.entryId)}`}
                          className={`mt-0.5 block truncate rounded px-1 text-[11px] ${POINT_STYLE[p.cls]}`}
                          title={p.tip}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.text}
                        </a>
                      ))}
                      {rest > 0 ? (
                        <button
                          type="button"
                          className="mt-0.5 block w-full text-left text-[11px] text-muted hover:text-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDay(day.index);
                          }}
                        >
                          {isExpanded ? '收起' : `+${rest}`}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>
      ) : null}

      {model.unanchored.length > 0 ? (
        <Card>
          <h2 className="mb-1 border-l-4 border-brand pl-2 text-[15px] font-semibold">
            待锚定条目 <span className="text-[12px] font-normal text-muted">（{model.unanchored.length}，仅有引用型时间）</span>
          </h2>
          <ul className="divide-y divide-line text-[13px]">
            {model.unanchored.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
                <span className="text-muted">{gameName(e.gameId)}</span>
                <a href={`/app/all?entry=${encodeURIComponent(e.id)}`}>{e.title}</a>
                <span className="text-[12px] text-muted">
                  {[e.startRef?.refText, e.endRef?.refText].filter(Boolean).map((t) => `［${t as string}］`).join(' ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {entriesQuery.data && model.weeks.length === 0 ? <Empty>当月无任何条目</Empty> : null}
    </div>
  );
}

/** 把条目铺进指定月份：返回周列表、跨天持续条与待锚定条目 */
function buildMonthModel(
  entries: EntryDto[],
  month: string,
): {
  weeks: {
    index: number;
    segments: { colStart: number; colspan: number; lead: string; trail: string; title: string; tip: string; gameId: string; entryId: string }[];
    days: ({ index: number; col: number; dateStr: string; points: DayPoint[] } | null)[];
  }[];
  unanchored: EntryDto[];
} {
  const monthStart = Math.floor(Date.parse(`${month}-01T00:00:00+08:00`) / 1000);
  const [year, monthNum] = month.split('-').map(Number);
  const nextYear = monthNum === 12 ? year + 1 : year;
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  const monthEnd = Math.floor(Date.parse(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`) / 1000);
  const days = Math.round((monthEnd - monthStart) / DAY);
  // 当月 1 号是周几（周一=0）
  const firstDow = (new Date((monthStart + 8 * 3600) * 1000).getUTCDay() + 6) % 7;
  const dayIndexOf = (ts: number): number => Math.floor((ts - monthStart) / DAY);

  const buckets: DayPoint[][] = Array.from({ length: days }, () => []);
  const spans: Span[] = [];
  const unanchored: EntryDto[] = [];

  for (const e of entries) {
    if (e.startAt === undefined && e.endAt === undefined) {
      unanchored.push(e);
      continue;
    }
    const estTip = e.estimated ? '（预估）' : '';
    const si = e.startAt !== undefined ? dayIndexOf(e.startAt) : undefined;
    const ei = e.endAt !== undefined ? dayIndexOf(e.endAt) : undefined;

    if (si !== undefined && ei !== undefined && ei >= si && ei >= 0 && si <= days - 1 && ei - si + 1 >= 3) {
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
    if (si !== undefined && si >= 0 && si < days) {
      buckets[si].push({ cls: 'start', text: `始 ${e.title}`, tip: `开始：${e.title}${estTip}`, entryId: e.id });
    }
    if (ei !== undefined && ei >= 0 && ei < days) {
      buckets[ei].push({ cls: 'end', text: `终 ${e.title}`, tip: `结束：${e.title}`, entryId: e.id });
    }
    if (e.rewardEndAt !== undefined) {
      const ri = dayIndexOf(e.rewardEndAt);
      if (ri >= 0 && ri < days) {
        buckets[ri].push({
          cls: 'reward',
          text: `奖 ${e.title}`,
          tip: `奖励截止：${e.title}（${fmtCst(e.rewardEndAt)}）`,
          entryId: e.id,
        });
      }
    }
  }

  const weekCount = Math.ceil((firstDow + days) / 7);
  const weeks = Array.from({ length: weekCount }, (_, w) => {
    const weekStart = w * 7 - firstDow;
    const segments = spans
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
        };
      });

    const cellDays = Array.from({ length: 7 }, (_, col) => {
      const d = weekStart + col;
      if (d < 0 || d >= days) return null;
      const dateStr = `${month}-${String(d + 1).padStart(2, '0')}`;
      return { index: d, col, dateStr, points: buckets[d] };
    });

    return { index: w, segments, days: cellDays };
  });

  return { weeks, unanchored };
}
