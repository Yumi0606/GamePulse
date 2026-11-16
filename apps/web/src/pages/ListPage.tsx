import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ENTRY_TYPES, ENTRY_TYPE_LABEL, fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { cstDateEnd, cstDateStart, fmtRelative } from '../lib/format';
import { useGameName, useGames } from '../lib/hooks';
import { EntryCard } from '../components/EntryCard';
import { PostCard } from '../components/PostCard';
import { Card, Empty, Pagination, QueryState, SectionTitle } from '../components/ui';

/**
 * 列表视图：概览 + 源异常提示 + 筛选 + 结构化条目 + 原始动态。
 *
 * 筛选与分页以 URL query 为唯一真源（刷新、分享、前进后退都保持一致）；
 * 状态筛选的映射只在展示层做：active 展开成服务端认识的三个状态值。
 */
const ENTRY_PAGE_SIZE = 50;
const POST_PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'active', label: '未结束（默认）' },
  { value: 'all', label: '全部' },
  { value: 'ongoing', label: '进行中' },
  { value: 'not-started', label: '未开始' },
  { value: 'ended', label: '已结束' },
  { value: 'unknown', label: '时间未知' },
];

export function ListPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();

  const str = (key: string, fallback = '') => params.get(key) ?? fallback;
  const patch = (values: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    // 筛选变化时回到第一页；翻页本身单独设置 page
    if (!('page' in values)) next.delete('page');
    setParams(next, { replace: true });
  };

  const gameId = str('gameId');
  const type = str('type');
  const keyword = str('q');
  const statusParam = str('status', 'active');
  const sort = str('sort', 'end');
  const order = str('order', 'asc');
  const fromDate = str('from');
  const toDate = str('to');
  // 深链定位单个条目（日历/周视图跳回）：此时忽略状态筛选，避免目标条目被默认条件隐藏
  const entryId = str('entry');
  const page = Math.max(1, Number(str('page', '1')) || 1);
  const postPage = Math.max(1, Number(str('postPage', '1')) || 1);

  const status = entryId
    ? undefined
    : statusParam === 'active'
      ? 'not-started,ongoing,unknown'
      : statusParam === 'all'
        ? undefined
        : statusParam;

  const from = cstDateStart(fromDate);
  const to = cstDateEnd(toDate);

  const entriesQuery = useQuery({
    queryKey: ['entries', { gameId, type, status, keyword, from, to, sort, order, page, entryId }],
    queryFn: () =>
      api.entries({
        gameId,
        type,
        status,
        id: entryId,
        q: keyword,
        from,
        to,
        sort,
        order,
        limit: ENTRY_PAGE_SIZE,
        offset: (page - 1) * ENTRY_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const postsQuery = useQuery({
    queryKey: ['posts', { gameId, keyword, from, to, postPage }],
    queryFn: () =>
      api.posts({
        gameId,
        q: keyword,
        from,
        to,
        limit: POST_PAGE_SIZE,
        offset: (postPage - 1) * POST_PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health });
  const entriesTotalQuery = useQuery({ queryKey: ['entries-total'], queryFn: () => api.entries({ limit: 1 }) });
  const postsTotalQuery = useQuery({ queryKey: ['posts-total'], queryFn: () => api.posts({ limit: 1 }) });

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

  const health = healthQuery.data;
  const now = health?.now ?? Math.floor(Date.now() / 1000);

  const reset = () => setParams(new URLSearchParams(), { replace: true });

  return (
    <div className="space-y-3">
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat value={postsTotalQuery.data?.total} label="原始动态" />
          <Stat value={entriesTotalQuery.data?.total} label="结构化条目" />
          <Stat value={health?.backlog.postsToExtract} label="待结构化动态" />
          <Stat value={health?.backlog.imagesToOcr} label="待 OCR 图片" />
          <Stat value={health?.events.unresolved} label="未恢复异常" />
        </div>
        <div className="mt-2 border-t border-line pt-2 text-[12px] text-muted">
          {health?.meta ? (
            <>
              最近同步 {fmtRelative(health.meta.lastRunAt, now)}（{fmtCst(health.meta.lastRunAt)}，用时{' '}
              {(health.meta.durationMs / 1000).toFixed(1)}s）
              <br />
              本次拉取：新增 {health.meta.added} 条 · 内容更新 {health.meta.updated} 条 · 未变化{' '}
              {Math.max(0, health.meta.fetched - health.meta.added - health.meta.updated)} 条（合计{' '}
              {health.meta.fetched} 条）
              {health.meta.errors.length > 0 ? (
                <div className="text-danger">拉取失败 {health.meta.errors.length} 项：{health.meta.errors.join('；')}</div>
              ) : null}
            </>
          ) : (
            '尚未拉取，等待定时任务'
          )}
        </div>
      </Card>

      {health && health.events.unresolved > 0 ? (
        <div className="rounded-lg border border-[#f3d3ad] bg-[#fdf7ee] px-3 py-2 text-[13px] text-warn">
          <strong>源异常</strong>：{health.events.unresolved} 条未恢复
          {health.events.cookieSuspect > 0 ? `，其中 ${health.events.cookieSuspect} 条疑似 B站 cookie 失效` : ''}
          {health.events.latest
            ? `；最近异常 ${fmtRelative(health.events.latest.occurredAt, now)}（${fmtCst(health.events.latest.occurredAt)}）`
            : ''}
          <a className="ml-2" href="/app/health">
            查看源健康页
          </a>
        </div>
      ) : health ? (
        <div className="rounded-lg border border-[#cfe8d5] bg-[#f2faf4] px-3 py-2 text-[13px] text-ok">
          源状态正常，无未恢复异常。
        </div>
      ) : null}

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
                  {g.enabled ? '' : '（停用）'}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1" title="仅筛选结构化数据，原始动态不受影响">
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
              className="w-[180px] rounded border border-line bg-surface px-1.5 py-1"
              placeholder="活动名 / 标题 / 正文"
              value={keyword}
              onChange={(e) => patch({ q: e.target.value || null })}
            />
          </label>

          <label className="flex items-center gap-1">
            <span className="text-muted">起</span>
            <input
              type="date"
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={fromDate}
              onChange={(e) => patch({ from: e.target.value || null })}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted">止</span>
            <input
              type="date"
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={toDate}
              onChange={(e) => patch({ to: e.target.value || null })}
            />
          </label>

          <label className="flex items-center gap-1">
            <span className="text-muted">状态</span>
            <select
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={statusParam}
              onChange={(e) => patch({ status: e.target.value === 'active' ? null : e.target.value })}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1" title="仅对结构化条目生效">
            <span className="text-muted">排序</span>
            <select
              className="rounded border border-line bg-surface px-1.5 py-1"
              value={sort}
              onChange={(e) => patch({ sort: e.target.value === 'end' ? null : e.target.value })}
            >
              <option value="end">结束时间</option>
              <option value="start">开始时间</option>
              <option value="duration">持续时间</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded border border-line px-2 py-1"
            title={order === 'asc' ? '当前升序（早→晚 / 短→长），点击切换为降序' : '当前降序（晚→早 / 长→短），点击切换为升序'}
            onClick={() => patch({ order: order === 'asc' ? 'desc' : null })}
          >
            {order === 'asc' ? '↑' : '↓'}
          </button>
          <button type="button" className="rounded border border-line px-2 py-1" onClick={reset}>
            重置
          </button>
        </div>
      </Card>

      {entryId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#c7d8ef] bg-brand-weak px-3 py-2 text-[13px]">
          正在定位单个条目 <code className="font-mono text-[12px]">{entryId}</code>
          <button type="button" className="rounded border border-line bg-surface px-2 py-0.5" onClick={() => patch({ entry: null })}>
            显示全部条目
          </button>
        </div>
      ) : null}

      <section>
        <SectionTitle extra={entriesQuery.data ? `筛选后 ${entriesQuery.data.items.length} / 共 ${entriesQuery.data.total} 条` : undefined}>
          结构化数据
        </SectionTitle>
        <Card>
          <QueryState loading={entriesQuery.isLoading} error={entriesQuery.error} />
          {entriesQuery.data ? (
            entriesQuery.data.items.length > 0 ? (
              <>
                <ul className="divide-y divide-line">
                  {entriesQuery.data.items.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} gameName={gameName(entry.gameId)} postById={postById} />
                  ))}
                </ul>
                <div className="mt-2 flex justify-end">
                  <Pagination
                    page={page}
                    pageSize={ENTRY_PAGE_SIZE}
                    total={entriesQuery.data.total}
                    onChange={(p) => patch({ page: p === 1 ? null : p })}
                  />
                </div>
              </>
            ) : (
              <Empty>暂无符合条件的条目</Empty>
            )
          ) : null}
        </Card>
      </section>

      <section>
        <SectionTitle extra={postsQuery.data ? `按发布时间倒序 · 共 ${postsQuery.data.total} 条` : undefined}>
          原始动态
        </SectionTitle>
        <Card>
          <QueryState loading={postsQuery.isLoading} error={postsQuery.error} />
          {postsQuery.data ? (
            postsQuery.data.items.length > 0 ? (
              <>
                <ul className="divide-y divide-line">
                  {postsQuery.data.items.map((post) => (
                    <PostCard key={post.id} post={post} gameName={gameName(post.gameId)} />
                  ))}
                </ul>
                <div className="mt-2 flex justify-end">
                  <Pagination
                    page={postPage}
                    pageSize={POST_PAGE_SIZE}
                    total={postsQuery.data.total}
                    onChange={(p) => patch({ postPage: p === 1 ? null : p })}
                  />
                </div>
              </>
            ) : (
              <Empty>暂无动态</Empty>
            )
          ) : null}
        </Card>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="text-center">
      <div className="text-[20px] font-semibold tabular-nums">{value ?? '—'}</div>
      <div className="text-[12px] text-muted">{label}</div>
    </div>
  );
}
