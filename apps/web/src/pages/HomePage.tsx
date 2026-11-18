import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EntryDto, PostDto } from '@gamepulse/shared';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL, cstStartOfDay, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDayDiff, fmtRelative } from '../lib/format';
import { useDebouncedQueryParam, useGameName, useGames } from '../lib/hooks';
import { EntryCard } from '../components/EntryCard';
import { FilterField, FilterGrid, FilterPanel, controlClass } from '../components/Filters';
import { Card, Empty, Pagination, QueryState } from '../components/ui';

/**
 * 首页：四个区块分别回答四类行动问题。
 *
 * - 即将到期：已开始、限时、有明确且未过的截止时间，按最近截止时间排序并分桶；
 * - 即将开始：开始时间在未来且生命周期已确定；
 * - 时间未定：已开始的限时条目，原文没有给出结束时间；
 * - 奖励待领取：活动已结束，但奖励领取截止还没过。
 *
 * 常驻、一次性更新、未判定与公告不进入任何区块（见 SPEC §9.1）。
 * 各区块独立计数，不再用一个「未结束活动」总数概括。
 */
const ACTIVE_LIMIT = 300;
const UPCOMING_LIMIT = 100;
const REWARD_LIMIT = 100;
/** 每个区块默认的分页条数：按距今天数分级，一屏内能看完一组即可 */
const DUE_PAGE_SIZE = 10;
const LIST_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

type DueBucketKey = 'today' | 'soon' | 'week' | 'fortnight' | 'later';

/** 分桶按距截止日期的自然日差划分，与周起始日无关 */
const DUE_BUCKETS: { key: DueBucketKey; title: string; note?: string }[] = [
  { key: 'today', title: '今天截止', note: '今天内结束，优先处理' },
  { key: 'soon', title: '3 天内截止' },
  { key: 'week', title: '7 天内截止' },
  { key: 'fortnight', title: '14 天内截止' },
  { key: 'later', title: '更晚' },
];

/** 默认折叠的桶：全部展开，由用户自行收起 */
const DEFAULT_COLLAPSED: Record<DueBucketKey, boolean> = {
  today: false,
  soon: false,
  week: false,
  fortnight: false,
  later: false,
};

/** 奖励截止是否尚未过去（按北京时间自然日，与状态判定口径一致） */
function rewardUsable(entry: EntryDto, now: number): number | undefined {
  return entry.rewardEndAt !== undefined && cstDayDiff(now, entry.rewardEndAt) >= 0
    ? entry.rewardEndAt
    : undefined;
}

/** 关键截止时间：活动结束与奖励领取截止取更早的一个；都没有则视为未定 */
function keyDeadline(entry: EntryDto, now: number): number | undefined {
  const reward = rewardUsable(entry, now);
  if (entry.endAt === undefined) return reward;
  if (reward === undefined) return entry.endAt;
  return Math.min(entry.endAt, reward);
}

/** 本次排序依据是否为奖励领取截止，用于在卡片上标注「奖励截止」 */
function rewardIsKey(entry: EntryDto, now: number): boolean {
  const reward = rewardUsable(entry, now);
  if (reward === undefined) return false;
  return entry.endAt === undefined || reward < entry.endAt;
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
  // 「即将到期」总栏折叠状态：只影响浏览，不写进 URL
  const [dueOpen, setDueOpen] = useState(true);

  const patch = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  // 深链定位单个条目：老链接 /?entry=xxx 统一转到归档列表
  const entryId = params.get('entry');

  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const now = healthQuery.data?.now ?? Math.floor(Date.now() / 1000);
  const startOfToday = cstStartOfDay(now);
  const filter = { gameId, type, q: keyword };

  // 已开始的限时条目：同时供「即将到期」与「时间未定」分桶
  const activeQuery = useQuery({
    queryKey: ['entries', 'home-active', { ...filter, startOfToday }],
    queryFn: () =>
      api.entries({
        ...filter,
        status: 'ongoing',
        lifecycle: 'limited',
        sort: 'end',
        order: 'asc',
        limit: ACTIVE_LIMIT,
      }),
  });

  const upcomingQuery = useQuery({
    queryKey: ['entries', 'home-upcoming', { ...filter, startOfToday }],
    queryFn: () =>
      api.entries({
        ...filter,
        status: 'not-started',
        lifecycle: 'limited,permanent,event',
        sort: 'start',
        order: 'asc',
        limit: UPCOMING_LIMIT,
      }),
  });

  const rewardQuery = useQuery({
    queryKey: ['entries', 'home-reward', { ...filter, startOfToday }],
    queryFn: () =>
      api.entries({
        ...filter,
        status: 'ended',
        lifecycle: 'limited,permanent,event',
        sort: 'end',
        order: 'asc',
        limit: REWARD_LIMIT,
      }),
  });

  const { due, undated } = useMemo(() => {
    const dueItems: EntryDto[] = [];
    const undatedItems: EntryDto[] = [];
    for (const entry of activeQuery.data?.items ?? []) {
      // 服务端已按 lifecycle=limited 过滤，这里再兜一层防止口径回退
      if (entry.lifecycle !== 'limited') continue;
      if (keyDeadline(entry, now) === undefined) undatedItems.push(entry);
      else dueItems.push(entry);
    }
    dueItems.sort(
      (a, b) =>
        (keyDeadline(a, now) ?? 0) - (keyDeadline(b, now) ?? 0) || a.title.localeCompare(b.title, 'zh-CN'),
    );
    undatedItems.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0) || a.title.localeCompare(b.title, 'zh-CN'));
    return { due: dueItems, undated: undatedItems };
  }, [activeQuery.data, now]);

  const dueBuckets = useMemo(() => {
    const buckets = new Map<DueBucketKey, EntryDto[]>(DUE_BUCKETS.map((b) => [b.key, []]));
    for (const entry of due) {
      const deadline = keyDeadline(entry, now) ?? 0;
      const diff = cstDayDiff(now, deadline);
      if (diff <= 0) buckets.get('today')!.push(entry);
      else if (diff <= 3) buckets.get('soon')!.push(entry);
      else if (diff <= 7) buckets.get('week')!.push(entry);
      else if (diff <= 14) buckets.get('fortnight')!.push(entry);
      else buckets.get('later')!.push(entry);
    }
    return buckets;
  }, [due, now]);

  const rewards = useMemo(() => {
    return (rewardQuery.data?.items ?? [])
      .filter((e) => e.lifecycle !== undefined && e.rewardEndAt !== undefined && e.rewardEndAt > now)
      .sort((a, b) => (a.rewardEndAt ?? 0) - (b.rewardEndAt ?? 0) || a.title.localeCompare(b.title, 'zh-CN'));
  }, [rewardQuery.data, now]);

  const upcoming = useMemo(() => upcomingQuery.data?.items ?? [], [upcomingQuery.data]);

  if (entryId) {
    return <Navigate to={`/all?${params.toString()}`} replace />;
  }

  const health = healthQuery.data;
  const loading = activeQuery.isLoading || upcomingQuery.isLoading || rewardQuery.isLoading;
  const error = activeQuery.error ?? upcomingQuery.error ?? rewardQuery.error;
  const total = due.length + upcoming.length + undated.length + rewards.length;
  const truncated =
    (activeQuery.data?.total ?? 0) > (activeQuery.data?.items.length ?? 0) ||
    (upcomingQuery.data?.total ?? 0) > (upcomingQuery.data?.items.length ?? 0) ||
    (rewardQuery.data?.total ?? 0) > (rewardQuery.data?.items.length ?? 0);
  const hasFilter = Boolean(gameId || type || keyword);
  const allLink = `/all${params.toString() ? `?${params}` : ''}`;

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
          <h1 className="text-[17px] font-semibold">活动概览</h1>
          <span className="text-[13px] text-ink-soft">
            {loading ? '正在统计…' : `即将到期 ${due.length} · 即将开始 ${upcoming.length} · 时间未定 ${undated.length} · 奖励待领取 ${rewards.length}`}
          </span>
          <Link className="ml-auto text-[13px]" to={allLink}>
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

      <QueryState
        loading={loading}
        error={error}
        rows={6}
        onRetry={() => {
          void activeQuery.refetch();
          void upcomingQuery.refetch();
          void rewardQuery.refetch();
        }}
      />

      {!loading && !error && total === 0 ? (
        <Card>
          <Empty>当前没有需要处理的活动。新的官方动态发布后会自动出现在这里。</Empty>
        </Card>
      ) : null}

      {due.length > 0 ? (
        <div className="space-y-3">
          <div>
            <button
              type="button"
              className="flex flex-wrap items-baseline gap-2 text-left"
              aria-expanded={dueOpen}
              onClick={() => setDueOpen((value) => !value)}
            >
              <span className="border-l-4 border-brand pl-2 text-[15px] font-semibold">即将到期</span>
              <span className="text-[12px] font-normal tabular-nums text-muted">{due.length} 个</span>
              <span className="text-[12px] font-normal text-brand">{dueOpen ? '收起' : '展开'}</span>
            </button>
          </div>
          {dueOpen
            ? DUE_BUCKETS.map((bucket) => {
                const list = dueBuckets.get(bucket.key) ?? [];
                if (list.length === 0) return null;
                return <BucketSection key={bucket.key} bucket={bucket} list={list} gameName={gameName} now={now} />;
              })
            : null}
        </div>
      ) : null}

      <ListSection
        title="奖励待领取"
        note="活动已结束，奖励领取截止还没过"
        list={rewards}
        gameName={gameName}
        now={now}
        rewardKey
      />
      
      <ListSection
        title="即将开始"
        note="开始时间在未来，按开始时间排列"
        list={upcoming}
        gameName={gameName}
        now={now}
      />

      <ListSection
        title="时间未定"
        note="已开始的限时活动，原文没有给出结束时间"
        list={undated}
        gameName={gameName}
        now={now}
        defaultOpen={true}
      />


      {truncated ? (
        <div className="text-[12px] text-muted">
          部分区块仅显示最近的条目，完整排期请到<Link to={allLink}>全部活动</Link>。
        </div>
      ) : null}
    </div>
  );
}

/** 首页不加载来源动态详情：条目卡只给跳转到原始动态的入口，不展示 OCR */
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
  bucket: { key: DueBucketKey; title: string; note?: string };
  list: EntryDto[];
  gameName: (gameId: string) => string;
  now: number;
}) {
  const [open, setOpen] = useState(!DEFAULT_COLLAPSED[bucket.key]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DUE_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const current = Math.min(page, pageCount);
  const visible = list.slice((current - 1) * pageSize, current * pageSize);
  // 条目数不超过默认每页条数时不显示分页条，直接整组展示；
  // 超过时始终保留，避免用户把每页条数调大后失去改回小值的入口
  const pager =
    list.length > Math.min(pageSize, DUE_PAGE_SIZE) ? (
      <Pagination
        page={current}
        pageSize={pageSize}
        total={list.length}
        onChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
      />
    ) : null;

  return (
    <section>
      <div className="mb-2">
        <button
          type="button"
          className="flex flex-wrap items-baseline gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="text-[14px] font-semibold">{bucket.title}</span>
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
                rewardIsKey={rewardIsKey(entry, now)}
              />
            ))}
          </ul>
          {pager ? <div className="border-t border-line px-1 py-1">{pager}</div> : null}
        </Card>
      ) : null}
    </section>
  );
}

/** 单一列表区块（即将开始 / 时间未定 / 奖励待领取），计数与折叠行为同上 */
function ListSection({
  title,
  note,
  list,
  gameName,
  now,
  defaultOpen = true,
  rewardKey = false,
}: {
  title: string;
  note: string;
  list: EntryDto[];
  gameName: (gameId: string) => string;
  now: number;
  defaultOpen?: boolean;
  /** 排序依据为奖励领取截止时，卡片标注「奖励截止」 */
  rewardKey?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(LIST_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const current = Math.min(page, pageCount);
  const visible = list.slice((current - 1) * pageSize, current * pageSize);
  // 与「即将到期」同口径：不超过默认每页条数时整组展示，不分页也不给控件
  const pager =
    list.length > Math.min(pageSize, LIST_PAGE_SIZE) ? (
      <Pagination
        page={current}
        pageSize={pageSize}
        total={list.length}
        onChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
      />
    ) : null;

  return (
    <section>
      <div className="mb-2">
        <button
          type="button"
          className="flex flex-wrap items-baseline gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="border-l-4 border-brand pl-2 text-[15px] font-semibold">{title}</span>
          <span className="text-[12px] font-normal text-muted">{note}</span>
          <span className="text-[12px] font-normal tabular-nums text-muted">{list.length} 个</span>
          <span className="text-[12px] font-normal text-brand">{open ? '收起' : '展开'}</span>
        </button>
      </div>
      {open ? (
        <Card className="py-1">
          {list.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-muted">暂无</div>
          ) : (
            <>
              {pager ? <div className="border-b border-line px-1 py-1">{pager}</div> : null}
              <ul className="divide-y divide-line">
                {visible.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    gameName={gameName(entry.gameId)}
                    postById={EMPTY_POSTS}
                    now={now}
                    rewardIsKey={rewardKey}
                  />
                ))}
              </ul>
              {pager ? <div className="border-t border-line px-1 py-1">{pager}</div> : null}
            </>
          )}
        </Card>
      ) : null}
    </section>
  );
}
