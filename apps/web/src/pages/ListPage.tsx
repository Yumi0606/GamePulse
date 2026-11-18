import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDateEnd, cstDateStart } from '../lib/format';
import { useGameName, useGames } from '../lib/hooks';
import { EntryCard } from '../components/EntryCard';
import { Card, Empty, Pagination, QueryState, SectionTitle, btnSecondary } from '../components/ui';
import { FilterField, FilterGrid, FilterPanel, controlClass } from '../components/Filters';

/**
 * 全部活动（归档列表）。
 *
 * 筛选与分页以 URL query 为唯一真源（刷新、分享、前进后退都保持一致）；
 * 状态筛选的映射只在展示层做：「进行中」直传服务端，旧链接的 active 兼容为 ongoing。
 * 生命周期默认只显示已确定的三类，未判定需要主动筛选查看。
 * 原始动态已拆到 /app/posts，这里只保留活动，避免两类内容互相挤占。
 */
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [20, 50, 100];

const STATUS_OPTIONS = [
  { value: 'ongoing', label: '进行中（默认）' },
  { value: 'all', label: '全部状态' },
  { value: 'not-started', label: '未开始' },
  { value: 'ended', label: '已结束' },
  { value: 'unknown', label: '时间未知' },
];

/** 生命周期筛选：determined 展开为三个已确定取值，unjudged 单独查看 */
const LIFECYCLE_OPTIONS = [
  { value: 'determined', label: '已确定（默认）' },
  { value: 'all', label: '全部生命周期' },
  { value: 'limited', label: '限时' },
  { value: 'permanent', label: '常驻' },
  { value: 'event', label: '更新' },
  { value: 'unjudged', label: '未判定' },
];

export function ListPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();

  const str = (key: string, fallback = '') => params.get(key) ?? fallback;

  /**
   * 更新 URL 参数。
   * `keepPage` 用于翻页本身（页码与每页条数），其余筛选变化都回到第一页：
   * 之前统一实现会在任何不含 page 的更新里删掉 page，导致翻原始动态把条目页码打回 1。
   */
  const patch = (values: Record<string, string | number | null>, options?: { keepPage?: boolean }) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    if (!options?.keepPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const gameId = str('gameId');
  const type = str('type');
  const keyword = str('q');
  const statusParam = str('status', 'ongoing');
  const lifecycleParam = str('lifecycle', 'determined');
  const sort = str('sort', 'end');
  const order = str('order', 'asc');
  const fromDate = str('from');
  const toDate = str('to');
  // 深链定位单个条目（日历/周视图跳回）：此时忽略状态筛选，避免目标条目被默认条件隐藏
  const entryId = str('entry');
  const page = Math.max(1, Number(str('page', '1')) || 1);
  const pageSize = PAGE_SIZES.includes(Number(str('size'))) ? Number(str('size')) : DEFAULT_PAGE_SIZE;

  // 关键词用本地状态承载，防抖后再写 URL：中文输入法拼音阶段不会触发请求
  const [keywordDraft, setKeywordDraft] = useState(keyword);
  useEffect(() => setKeywordDraft(keyword), [keyword]);
  useEffect(() => {
    if (keywordDraft === keyword) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (keywordDraft) next.set('q', keywordDraft);
      else next.delete('q');
      next.delete('page');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(timer);
    // params/setParams 每次渲染都是新引用，不能作为依赖，否则会重置计时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordDraft, keyword]);

  const status = entryId
    ? undefined
    : statusParam === 'all'
      ? undefined
      : statusParam === 'active'
        ? 'ongoing'
        : statusParam;

  // 深链定位单条时忽略生命周期筛选，避免目标条目被默认口径隐藏
  const lifecycle = entryId
    ? undefined
    : lifecycleParam === 'all'
      ? undefined
      : lifecycleParam === 'determined'
        ? 'limited,permanent,event'
        : lifecycleParam;

  const from = cstDateStart(fromDate);
  const to = cstDateEnd(toDate);
  const now = Math.floor(Date.now() / 1000);

  const entriesQuery = useQuery({
    queryKey: ['entries', { gameId, type, status, lifecycle, keyword, from, to, sort, order, page, pageSize, entryId }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
        status,
        lifecycle,
        id: entryId,
        q: keyword,
        from,
        to,
        sort,
        order,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    placeholderData: keepPreviousData,
  });

  // 条目的来源动态标题：把当前页所有 postId 一次批量查回
  const sourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entriesQuery.data?.items ?? []) {
      const list = e.postIds?.length ? e.postIds : e.postId ? [e.postId] : [];
      for (const id of list) ids.add(id);
    }
    return [...ids];
  }, [entriesQuery.data]);

  const sourcePostsQuery = useQuery({
    queryKey: ['posts-by-ids', sourceIds],
    queryFn: () => api.posts({ id: sourceIds.join(','), limit: 1000 }),
    enabled: sourceIds.length > 0,
    staleTime: 60_000,
  });

  const postById = useMemo(
    () => new Map((sourcePostsQuery.data?.items ?? []).map((p) => [p.id, p])),
    [sourcePostsQuery.data],
  );

  const hasFilter = Boolean(
    gameId || type || keyword || fromDate || toDate || entryId ||
    (params.get('status') && statusParam !== 'ongoing') ||
    (params.get('lifecycle') && lifecycleParam !== 'determined') ||
    params.get('sort'),
  );
  // 收起的次级筛选里生效的项数，供「更多筛选」提示
  const advancedCount =
    (statusParam !== 'ongoing' && statusParam !== 'active' ? 1 : 0) +
    (lifecycleParam !== 'determined' ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0) +
    (sort !== 'end' ? 1 : 0) +
    (order !== 'asc' ? 1 : 0);

  // 分页器在列表上下各渲染一次，长列表翻页不必先滚到底
  const pager = entriesQuery.data ? (
    <div className="flex justify-end">
      <Pagination
        page={page}
        pageSize={pageSize}
        total={entriesQuery.data.total}
        onChange={(p) => patch({ page: p === 1 ? null : p }, { keepPage: true })}
        onPageSizeChange={(size) => patch({ size: size === DEFAULT_PAGE_SIZE ? null : size }, { keepPage: true })}
        pageSizeOptions={PAGE_SIZES}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      <FilterPanel
        primary={
          <FilterGrid>
            <FilterField label="关键词" className="col-span-2 sm:col-span-1 lg:col-span-2" hint="匹配活动名、标题与摘要">
              <input
                type="search"
                className={controlClass}
                placeholder="活动名 / 标题 / 摘要"
                aria-label="关键词"
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
              />
            </FilterField>
            <FilterField label="游戏">
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
                    {g.enabled ? '' : '（停用）'}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="分类">
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
        advanced={
          <FilterGrid>
            <FilterField label="状态" className="col-span-2 sm:col-span-1">
              <select
                className={controlClass}
                aria-label="状态"
                value={statusParam}
                onChange={(e) => patch({ status: e.target.value === 'ongoing' ? null : e.target.value })}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="生命周期" className="col-span-2 sm:col-span-1">
              <select
                className={controlClass}
                aria-label="生命周期"
                value={lifecycleParam}
                onChange={(e) => patch({ lifecycle: e.target.value === 'determined' ? null : e.target.value })}
              >
                {LIFECYCLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="活动时间" className="col-span-2" hint="筛选活动区间与所选日期范围有重叠的条目；留空表示不限">
              <span className="flex items-center gap-1">
                <input
                  type="date"
                  className={controlClass}
                  value={fromDate}
                  onChange={(e) => patch({ from: e.target.value || null })}
                  aria-label="活动时间起点"
                />
                <span className="shrink-0 text-[12px] text-muted">至</span>
                <input
                  type="date"
                  className={controlClass}
                  value={toDate}
                  onChange={(e) => patch({ to: e.target.value || null })}
                  aria-label="活动时间终点"
                />
              </span>
            </FilterField>
            <FilterField label="排序" className="col-span-2 sm:col-span-1">
              <span className="flex items-center gap-1">
                <select
                  className={`${controlClass} flex-1`}
                  aria-label="排序字段"
                  value={sort}
                  onChange={(e) => patch({ sort: e.target.value === 'end' ? null : e.target.value })}
                >
                  <option value="end">按结束时间</option>
                  <option value="start">按开始时间</option>
                  <option value="duration">按持续时间</option>
                </select>
                <button
                  type="button"
                  className={`${btnSecondary} shrink-0`}
                  title={order === 'asc' ? '当前升序（早→晚 / 短→长），点击切换为降序' : '当前降序（晚→早 / 长→短），点击切换为升序'}
                  onClick={() => patch({ order: order === 'asc' ? 'desc' : null })}
                >
                  {order === 'asc' ? '↑ 升序' : '↓ 降序'}
                </button>
              </span>
            </FilterField>
          </FilterGrid>
        }
        advancedCount={advancedCount}
        resetEnabled={hasFilter}
        onReset={() => setParams(new URLSearchParams(), { replace: true })}
      />

      {entryId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/25 bg-brand-weak px-3 py-2 text-[13px]">
          正在定位单个活动 <code className="font-mono text-[12px]">{entryId}</code>
          <button type="button" className={btnSecondary} onClick={() => patch({ entry: null })}>
            显示全部活动
          </button>
        </div>
      ) : null}

      <section>
        <SectionTitle
          extra={
            entriesQuery.data ? `筛选后 ${entriesQuery.data.items.length} / 共 ${entriesQuery.data.total} 条` : undefined
          }
        >
          活动
        </SectionTitle>
        {pager}
        <Card className="py-1">
          <QueryState
            loading={entriesQuery.isLoading}
            error={entriesQuery.error}
            rows={6}
            onRetry={() => void entriesQuery.refetch()}
          />
          {entriesQuery.data ? (
            entriesQuery.data.items.length > 0 ? (
              <ul className="divide-y divide-line">
                {entriesQuery.data.items.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    gameName={gameName(entry.gameId)}
                    postById={postById}
                    now={now}
                  />
                ))}
              </ul>
            ) : (
              <Empty>没有符合条件的活动</Empty>
            )
          ) : null}
        </Card>
      </section>

      {pager}
    </div>
  );
}
