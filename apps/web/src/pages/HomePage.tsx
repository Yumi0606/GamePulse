import { useMemo } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EntryDto, PostDto } from '@gamepulse/shared';
import { ENTRY_TYPE_LABEL, cstStartOfDay, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDayDiff, cstWeekEnd, fmtRelative } from '../lib/format';
import { useGameName } from '../lib/hooks';
import { EntryCard } from '../components/EntryCard';
import { Card, Empty, QueryState, SectionTitle } from '../components/ui';

/**
 * 首页：即将到期。
 *
 * 只回答一个问题「我最近要清什么」：按最近的关键截止时间（活动结束或奖励领取截止）
 * 分成 今天 / 3 天内 / 本周内 / 更晚 / 未定 五组，组内按截止时间升序。
 * 管道健康度不在这里展示，异常时只在顶部留一行可点击提示。
 */
const UPCOMING_LIMIT = 200;
const REWARD_LIMIT = 100;

type BucketKey = 'today' | 'soon' | 'week' | 'later' | 'unknown';

const BUCKETS: { key: BucketKey; title: string; note?: string }[] = [
  { key: 'today', title: '今天截止', note: '今天内结束，优先处理' },
  { key: 'soon', title: '3 天内截止' },
  { key: 'week', title: '本周内截止' },
  { key: 'later', title: '更晚' },
  { key: 'unknown', title: '时间未定', note: '结束时间无法确定：常驻活动或原文未写明' },
];

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
  const [params] = useSearchParams();
  const gameName = useGameName();
  const gameId = params.get('gameId') ?? '';
  const type = params.get('type') ?? '';

  // 深链定位单个条目：老链接 /app?entry=xxx 统一转到归档列表
  const entryId = params.get('entry');

  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const now = healthQuery.data?.now ?? Math.floor(Date.now() / 1000);
  const startOfToday = cstStartOfDay(now);

  const upcomingQuery = useQuery({
    queryKey: ['entries', 'upcoming', { gameId, type, startOfToday }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
        from: startOfToday,
        sort: 'end',
        order: 'asc',
        limit: UPCOMING_LIMIT,
      }),
  });

  // 结束时间较远但奖励先截止的条目，靠这个查询补进来
  const rewardQuery = useQuery({
    queryKey: ['entries', 'reward', { gameId, type, startOfToday }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
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
  const filterLabel = [gameId ? gameName(gameId) : '', type ? ENTRY_TYPE_LABEL[type as keyof typeof ENTRY_TYPE_LABEL] : '']
    .filter(Boolean)
    .join(' · ');

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
        {filterLabel ? <div className="mt-1 text-[12px] text-muted">当前筛选：{filterLabel}</div> : null}
        {health?.scan.fetch.lastRunAt ? (
          <div className="mt-1 text-[12px] text-muted">
            数据更新于 {fmtRelative(health.scan.fetch.lastRunAt, now)}（{fmtCst(health.scan.fetch.lastRunAt)}）
          </div>
        ) : null}
      </Card>

      <QueryState loading={loading} error={error} rows={6} onRetry={() => void upcomingQuery.refetch()} />

      {!loading && !error && items.length === 0 ? (
        <Card>
          <Empty>最近没有即将截止的活动。新的官方动态发布后会自动出现在这里。</Empty>
        </Card>
      ) : null}

      {BUCKETS.map((bucket) => {
        const list = grouped.get(bucket.key) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={bucket.key}>
            <SectionTitle extra={<span className="tabular-nums">{list.length} 个</span>}>
              {bucket.title}
              {bucket.note ? <span className="ml-2 text-[12px] font-normal text-muted">{bucket.note}</span> : null}
            </SectionTitle>
            <Card className="py-1">
              <ul className="divide-y divide-line">
                {list.map((entry) => (
                  <EntryCard key={entry.id} entry={entry} gameName={gameName(entry.gameId)} postById={EMPTY_POSTS} now={now} />
                ))}
              </ul>
            </Card>
          </section>
        );
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
