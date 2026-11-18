import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cstDateEnd, cstDateStart } from '../lib/format';
import { useDebouncedQueryParam, useGameName, useGames } from '../lib/hooks';
import { PostCard } from '../components/PostCard';
import { Card, Empty, Pagination, QueryState } from '../components/ui';
import { FilterField, FilterGrid, FilterPanel, controlClass } from '../components/Filters';

/**
 * 原始动态（数据核验视图）。
 *
 * 与活动列表分离：这里展示抓取到的原文，用来核对解析结果，
 * 不参与「我最近要清什么」的主线。筛选与分页同样以 URL query 为唯一真源。
 * 图片数量与提取状态都必须由服务端过滤，前端不复刻判定。
 */
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZES = [20, 50, 100];

/** 提取状态筛选：对应 posts.entry_count 的三种取值 */
const EXTRACTED_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'never', label: '未提取过' },
  { value: 'empty', label: '提取了但没有排期' },
  { value: 'some', label: '已提取出活动' },
];

const SORT_OPTIONS = [
  { value: 'published', label: '按发布时间' },
  { value: 'images', label: '按图片数量' },
  { value: 'entries', label: '按提取条目数' },
];

/** 数量输入 → 非负整数；空串或非法值视为不限 */
function parseCount(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function PostsPage() {
  const [params, setParams] = useSearchParams();
  const gameName = useGameName();
  const gamesQuery = useGames();

  const str = (key: string, fallback = '') => params.get(key) ?? fallback;

  const patch = (values: Record<string, string | number | null>, options?: { keepPage?: boolean }) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    // 筛选变化回到第一页；翻页与改每页条数保留当前页码语义
    if (!options?.keepPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const gameId = str('gameId');
  /** 深链定位单条动态（首页来源入口）：此时忽略其余筛选，保证目标动态一定出现 */
  const postId = str('id');
  const fromDate = str('from');
  const toDate = str('to');
  /** 图片数量闭区间：留空表示该端不限，非数字一律视为未填 */
  const imagesMin = parseCount(str('imagesMin'));
  const imagesMax = parseCount(str('imagesMax'));
  const extracted = str('extracted');
  const sort = str('sort', 'published');
  const order = str('order', 'desc');
  const page = Math.max(1, Number(str('page', '1')) || 1);
  const pageSize = PAGE_SIZES.includes(Number(str('size'))) ? Number(str('size')) : DEFAULT_PAGE_SIZE;

  // 输入框即时显示，防抖后写回 URL：关键词与图片数量都不逐字符发请求。
  // 查询一律使用已写入 URL 的值（keyword），避免草稿阶段就触发请求。
  const keyword = str('q');
  const [keywordDraft, setKeywordDraft] = useDebouncedQueryParam('q');
  const [imagesMinDraft, setImagesMinDraft] = useDebouncedQueryParam('imagesMin');
  const [imagesMaxDraft, setImagesMaxDraft] = useDebouncedQueryParam('imagesMax');

  const from = cstDateStart(fromDate);
  const to = cstDateEnd(toDate);

  const postsQuery = useQuery({
    queryKey: [
      'posts',
      { postId, gameId, keyword, from, to, imagesMin, imagesMax, extracted, sort, order, page, pageSize },
    ],
    queryFn: () =>
      postId
        ? api.posts({ id: postId, limit: 1 })
        : api.posts({
            gameId,
            q: keyword,
            from,
            to,
            imagesMin,
            imagesMax,
            extracted: extracted === 'never' || extracted === 'empty' || extracted === 'some' ? extracted : undefined,
            sort: sort === 'images' || sort === 'entries' ? sort : 'published',
            order: order === 'asc' ? 'asc' : 'desc',
            limit: pageSize,
            offset: (page - 1) * pageSize,
          }),
    placeholderData: keepPreviousData,
  });

  const hasFilter = Boolean(
    gameId ||
      keyword ||
      fromDate ||
      toDate ||
      imagesMin !== undefined ||
      imagesMax !== undefined ||
      extracted ||
      params.get('sort') ||
      params.get('order'),
  );
  // 收起的次级筛选里生效的项数，供「更多筛选」提示
  const advancedCount =
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0) +
    (imagesMin !== undefined ? 1 : 0) +
    (imagesMax !== undefined ? 1 : 0) +
    (extracted ? 1 : 0) +
    (sort !== 'published' ? 1 : 0) +
    (order !== 'desc' ? 1 : 0);

  // 分页器在列表上下各渲染一次，长列表翻页不必先滚到底
  const pager = postsQuery.data && !postId ? (
    <div className="flex justify-end">
      <Pagination
        page={page}
        pageSize={pageSize}
        total={postsQuery.data.total}
        onChange={(p) => patch({ page: p === 1 ? null : p }, { keepPage: true })}
        onPageSizeChange={(size) => patch({ size: size === DEFAULT_PAGE_SIZE ? null : size })}
        pageSizeOptions={PAGE_SIZES}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[16px] font-semibold">原始动态</h1>
          <span className="text-[13px] text-muted">抓取到的原文，用于核对活动提取结果。</span>
          {postsQuery.data ? (
            <span className="ml-auto text-[12px] text-muted tabular-nums">共 {postsQuery.data.total} 条</span>
          ) : null}
        </div>
      </Card>

      {postId ? (
        <Card>
          <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
            <span>正在查看指定动态</span>
            {postsQuery.data?.items[0] ? (
              <span className="text-muted">{postsQuery.data.items[0].title}</span>
            ) : null}
            <Link className="ml-auto" to="/posts">
              查看全部动态 →
            </Link>
          </div>
        </Card>
      ) : (
        <FilterPanel
        primary={
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
            <FilterField label="关键词" hint="匹配动态标题与正文">
              <input
                type="search"
                className={controlClass}
                placeholder="标题 / 正文"
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
          </div>
        }
        advanced={
          <FilterGrid>
            <FilterField label="发布时间" className="col-span-2" hint="按动态发布时间筛选；留空表示不限">
              <span className="flex items-center gap-1">
                <input
                  type="date"
                  className={controlClass}
                  value={fromDate}
                  onChange={(e) => patch({ from: e.target.value || null })}
                  aria-label="发布时间起点"
                />
                <span className="shrink-0 text-[12px] text-muted">至</span>
                <input
                  type="date"
                  className={controlClass}
                  value={toDate}
                  onChange={(e) => patch({ to: e.target.value || null })}
                  aria-label="发布时间终点"
                />
              </span>
            </FilterField>
            <FilterField
              label="图片数"
              className="col-span-2"
              hint="按动态携带的图片数量筛选，多图动态是 OCR 核验的重点；留空表示该端不限"
            >
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  className={controlClass}
                  placeholder="不限"
                  value={imagesMinDraft}
                  onChange={(e) => setImagesMinDraft(e.target.value)}
                  aria-label="图片数量下限"
                />
                <span className="shrink-0 text-[12px] text-muted">至</span>
                <input
                  type="number"
                  min={0}
                  className={controlClass}
                  placeholder="不限"
                  value={imagesMaxDraft}
                  onChange={(e) => setImagesMaxDraft(e.target.value)}
                  aria-label="图片数量上限"
                />
              </span>
            </FilterField>
            <FilterField label="提取状态" className="col-span-2 sm:col-span-1" hint="提取状态来自最近一次成功提取的条目数">
              <select
                className={controlClass}
                aria-label="提取状态"
                value={extracted}
                onChange={(e) => patch({ extracted: e.target.value || null })}
              >
                {EXTRACTED_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="排序" className="col-span-2 sm:col-span-1">
              <span className="flex items-center gap-1">
                <select
                  className={`${controlClass} flex-1`}
                  aria-label="排序字段"
                  value={sort}
                  onChange={(e) => patch({ sort: e.target.value === 'published' ? null : e.target.value })}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="shrink-0 rounded border border-line bg-surface px-2 py-1 text-[12px] text-ink hover:bg-bg"
                  title={order === 'desc' ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序'}
                  onClick={() => patch({ order: order === 'desc' ? null : 'asc' })}
                >
                  {order === 'desc' ? '↓' : '↑'}
                </button>
              </span>
            </FilterField>
          </FilterGrid>
        }
        advancedCount={advancedCount}
        resetEnabled={hasFilter}
        onReset={() => setParams(new URLSearchParams(), { replace: true })}
      />
      )}

      {pager}

      <Card className="py-1">
        <QueryState
          loading={postsQuery.isLoading}
          error={postsQuery.error}
          rows={6}
          onRetry={() => void postsQuery.refetch()}
        />
        {postsQuery.data ? (
          postsQuery.data.items.length > 0 ? (
            <ul className="divide-y divide-line">
              {postsQuery.data.items.map((post) => (
                <PostCard key={post.id} post={post} gameName={gameName(post.gameId)} />
              ))}
            </ul>
          ) : (
            <Empty>没有符合条件的动态</Empty>
          )
        ) : null}
      </Card>

      {pager}
    </div>
  );
}
