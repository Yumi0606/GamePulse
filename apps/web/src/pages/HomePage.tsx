import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EntryDto, PostDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL, cstStartOfDay, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDayDiff, cstWeekEnd, fmtRelative } from '../lib/format';
import { useDebouncedQueryParam, useGameName, useGames } from '../lib/hooks';
import { EntryCard } from '../components/EntryCard';
import { FilterField, FilterGrid, FilterPanel, controlClass } from '../components/Filters';
import { Card, Empty, Pagination, QueryState } from '../components/ui';

/**
 * 首页：即将到期。
 *
 * 只回答一个问题「我最近要清什么」：按最近的关键截止时间（活动结束或奖励领取截止）
 * 分成 今天 / 3 天内 / 本周内 / 更晚 / 未定 五组，组内按截止时间升序。
 * 管道健康度不在这里展示，异常时只在顶部留一行可点击提示。
 */
const UPCOMING_LIMIT = 200;
const REWARD_LIMIT = 100;
/** 桶内分页条数：首页是概览，一屏内能看完一组即可 */
const PAGE_SIZE = 10;

type BucketKey = 'today' | 'soon' | 'week' | 'later' | 'unknown';

const BUCKETS: { key: BucketKey; title: string; note?: string }[] = [
  { key: 'today', title: '今天截止', note: '今天内结束，优先处理' },
  { key: 'soon', title: '3 天内截止' },
  { key: 'week', title: '本周内截止' },
  { key: 'later', title: '更晚' },
  { key: 'unknown', title: '时间未定', note: '结束时间无法确定：常驻活动或原文未写明' },
];

/** 默认折叠的桶：近期要处理的展开，远期与未定的先收起 */
const DEFAULT_COLLAPSED: Record<BucketKey, boolean> = {
  today: false,
  soon: false,
  week: false,
  later: true,
  unknown: true,
};

/** 关键截止时间：活动结束与奖励领取截止取更早的一个；都没有则视为未定 */
function keyDeadline(entry: EntryDto, now: number): number | undefined {
  const end = entry.status === 'ended' ? undefined : entry.endAt;
  const reward =
    entry.rewardEndAt !== undefined && cstDayDiff(now, entry.rewardEndAt) >= 0 ? entry.rewardEndAt : undefined;
  if (end === undefined) return reward;
  if (reward === undefined) return end;
  return Math.min(end, reward);
}

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();
  const gameId = params.get('gameId') ?? '';
  const type = params.get('type') ?? '';
  const keyword = params.get('q') ?? '';
  // 关键词输入防抖后写回 URL，与其余页面保持同一套筛选参数
  const [keywordDraft, setKeywordDraft] = useDebouncedQueryParam('q');

  const patch = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  // 深链定位单个条目：老链接 /app?entry=xxx 统一转到归档列表
  const entryId = params.get('entry');

  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const now = healthQuery.data?.now ?? Math.floor(Date.now() / 1000);
  const startOfToday = cstStartOfDay(now);

  const upcomingQuery = useQuery({
    queryKey: ['entries', 'upcoming', { gameId, type, keyword, startOfToday }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
        q: keyword,
        from: startOfToday,
        sort: 'end',
        order: 'asc',
        limit: UPCOMING_LIMIT,
      }),
  });

  // 结束时间较远但奖励先截止的条目，靠这个查询补进来
  const rewardQuery = useQuery({
    queryKey: ['entries', 'reward', { gameId, type, keyword, startOfToday }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
        q: keyword,
        rewardFrom: startOfToday,
        sort: 'end',
        order: 'asc',
        limit: REWARD_LIMIT,
      }),
  });

  const items = useMemo(() => {
    const map = new Map<string, EntryDto>();
    for (const entry of upcomingQuery.data?.items ?? []) map.set(entry.id, entry);
    for (const entry of rewardQuery.data?.items ?? []) if (!map.has(entry.id)) map.set(entry.id, entry);
    return [...map.values()];
  }, [upcomingQuery.data, rewardQuery.data]);

  const grouped = useMemo(() => {
    const weekEnd = cstWeekEnd(now);
    const buckets = new Map<BucketKey, EntryDto[]>(BUCKETS.map((b) => [b.key, []]));
    const sortKey = new Map<EntryDto, number>();

    for (const entry of items) {
      const deadline = keyDeadline(entry, now);
      sortKey.set(entry, deadline ?? Number.POSITIVE_INFINITY);
      if (deadline === undefined) {
        buckets.get('unknown')!.push(entry);
        continue;
      }
      const diff = cstDayDiff(now, deadline);
      if (diff <= 0) buckets.get('today')!.push(entry);
      else if (diff <= 3) buckets.get('soon')!.push(entry);
      else if (deadline <= weekEnd) buckets.get('week')!.push(entry);
      else buckets.get('later')!.push(entry);
    }

    for (const list of buckets.values()) {
      list.sort((a, b) => (sortKey.get(a) ?? 0) - (sortKey.get(b) ?? 0) || a.title.localeCompare(b.title, 'zh-CN'));
    }
    return buckets;
  }, [items, now]);

  if (entryId) {
    return <Navigate to={`/all?${params.toString()}`} replace />;
  }

  const health = healthQuery.data;
  const truncated =
    (upcomingQuery.data?.total ?? 0) > (upcomingQuery.data?.items.length ?? 0) ||
    (rewardQuery.data?.total ?? 0) > (rewardQuery.data?.items.length ?? 0);
  const loading = upcomingQuery.isLoading || rewardQuery.isLoading;
  const error = upcomingQuery.error ?? rewardQuery.error;
  const hasFilter = Boolean(gameId || type || keyword);

  return (
    <div className="space-y-4">
      {health && health.events.unresolved > 0 ? (
        <Link
          to="/health"
          className="block rounded-lg border border-warn/30 bg-warn-weak px-3 py-2 text-[13px] text-warn hover:underline"
        >
          数据源有 {health.events.unresolved} 条未恢复异常
          {health.events.latest ? `，最近一次 ${fmtRelative(health.events.latest.occurredAt, now)}` : ''}
          ，可能影响活动收录 →
        </Link>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[17px] font-semibold">即将到期</h1>
          <span className="text-[13px] text-ink-soft">
            {loading ? '正在统计…' : `${items.length} 个未结束活动，按最近的截止时间排列`}
          </span>
          <Link className="ml-auto text-[13px]" to={`/all${params.toString() ? `?${params}` : ''}`}>
            查看全部活动 →
          </Link>
        </div>
        {health?.scan.fetch.lastRunAt ? (
          <div className="mt-1 text-[12px] text-muted">
            数据更新于 {fmtRelative(health.scan.fetch.lastRunAt, now)}（{fmtCst(health.scan.fetch.lastRunAt)}）
          </div>
        ) : null}
      </Card>

      <FilterPanel
        primary={
          <FilterGrid>
            <FilterField label="关键词" className="col-span-2 sm:col-span-1 lg:col-span-2" hint="匹配活动名、标题与摘要">
              <input
                type="search"
                className={controlClass}
                placeholder="活动名 / 摘要"
                aria-label="关键词"
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
              />
            </FilterField>
            <FilterField label="游戏">
              <select className={controlClass} aria-label="游戏" value={gameId} onChange={(e) => patch({ gameId: e.target.value || null })}>
                <option value="">全部游戏</option>
                {(gamesQuery.data?.items ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="分类">
              <select className={controlClass} aria-label="分类" value={type} onChange={(e) => patch({ type: e.target.value || null })}>
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
        resetEnabled={hasFilter}
        onReset={() => setParams(new URLSearchParams(), { replace: true })}
      />

      <QueryState loading={loading} error={error} rows={6} onRetry={() => void upcomingQuery.refetch()} />

      {!loading && !error && items.length === 0 ? (
        <Card>
          <Empty>最近没有即将截止的活动。新的官方动态发布后会自动出现在这里。</Empty>
        </Card>
      ) : null}

      {BUCKETS.map((bucket) => {
        const list = grouped.get(bucket.key) ?? [];
        if (list.length === 0) return null;
        return <BucketSection key={bucket.key} bucket={bucket} list={list} gameName={gameName} now={now} />;
      })}

      {truncated ? (
        <div className="text-[12px] text-muted">
          仅显示最近 {UPCOMING_LIMIT} 个活动，完整排期请到
          <Link to={`/all${params.toString() ? `?${params}` : ''}`}>全部活动</Link>。
        </div>
      ) : null}
    </div>
  );
}

/** 首页不加载来源动态详情，传空表：条目卡只显示「来源动态标题未加载」 */
const EMPTY_POSTS = new Map<string, PostDto>();

/**
 * 单个分桶：标题可折叠，展开后按固定条数分页。
 * 折叠状态与页码都留在组件内：首页是概览页，不把浏览位置写进 URL。
 */
function BucketSection({
  bucket,
  list,
  gameName,
  now,
}: {
  bucket: (typeof BUCKETS)[number];
  list: EntryDto[];
  gameName: (gameId: string) => string;
  now: number;
}) {
  const [open, setOpen] = useState(!DEFAULT_COLLAPSED[bucket.key]);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = list.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const pager =
    pageCount > 1 ? <Pagination page={current} pageSize={PAGE_SIZE} total={list.length} onChange={setPage} /> : null;

  return (
    <section>
      <div className="mb-2">
        <button
          type="button"
          className="flex flex-wrap items-baseline gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="border-l-4 border-brand pl-2 text-[15px] font-semibold">{bucket.title}</span>
          {bucket.note ? <span className="text-[12px] font-normal text-muted">{bucket.note}</span> : null}
          <span className="text-[12px] font-normal tabular-nums text-muted">{list.length} 个</span>
          <span className="text-[12px] font-normal text-brand">{open ? '收起' : '展开'}</span>
        </button>
      </div>
      {open ? (
        <Card className="py-1">
          {pager ? <div className="border-b border-line px-1 py-1">{pager}</div> : null}
          <ul className="divide-y divide-line">
            {visible.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                gameName={gameName(entry.gameId)}
                postById={EMPTY_POSTS}
                now={now}
              />
            ))}
          </ul>
          {pager ? <div className="border-t border-line px-1 py-1">{pager}</div> : null}
        </Card>
      ) : null}
    </section>
  );
}
