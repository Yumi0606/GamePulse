import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cstDateEnd, cstDateStart } from '../lib/format';
import { useDebouncedQueryParam, useGameName, useGames } from '../lib/hooks';
import { PostCard } from '../components/PostCard';
import { Card, Empty, Pagination, QueryState, btnSecondary, fieldClass } from '../components/ui';

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
      { gameId, keyword, from, to, imagesMin, imagesMax, extracted, sort, order, page, pageSize },
    ],
    queryFn: () =>
      api.posts({
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

  // 分页器在列表上下各渲染一次，长列表翻页不必先滚到底
  const pager = postsQuery.data ? (
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

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <label className="flex items-center gap-1">
            <span className="text-muted">游戏</span>
            <select className={fieldClass} value={gameId} onChange={(e) => patch({ gameId: e.target.value || null })}>
              <option value="">全部</option>
              {(gamesQuery.data?.items ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.enabled ? '' : '（停用）'}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1">
            <span className="text-muted">关键词</span>
            <input
              type="search"
              className={`${fieldClass} w-[200px]`}
              placeholder="标题 / 正文"
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
            />
          </label>

          <span className="flex items-center gap-1" title="按动态发布时间筛选；留空表示不限">
            <span className="text-muted">发布时间</span>
            <input
              type="date"
              className={fieldClass}
              value={fromDate}
              onChange={(e) => patch({ from: e.target.value || null })}
              aria-label="发布时间起点"
            />
            <span className="text-muted">至</span>
            <input
              type="date"
              className={fieldClass}
              value={toDate}
              onChange={(e) => patch({ to: e.target.value || null })}
              aria-label="发布时间终点"
            />
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <label
            className="flex items-center gap-1"
            title="按动态携带的图片数量筛选，多图动态是 OCR 核验的重点；留空表示该端不限"
          >
            <span className="text-muted">图片数</span>
            <input
              type="number"
              min={0}
              className={`${fieldClass} w-16`}
              placeholder="不限"
              value={imagesMinDraft}
              onChange={(e) => setImagesMinDraft(e.target.value)}
              aria-label="图片数量下限"
            />
            <span className="text-muted">至</span>
            <input
              type="number"
              min={0}
              className={`${fieldClass} w-16`}
              placeholder="不限"
              value={imagesMaxDraft}
              onChange={(e) => setImagesMaxDraft(e.target.value)}
              aria-label="图片数量上限"
            />
          </label>

          <label className="flex items-center gap-1" title="提取状态来自最近一次成功提取的条目数">
            <span className="text-muted">提取状态</span>
            <select
              className={fieldClass}
              value={extracted}
              onChange={(e) => patch({ extracted: e.target.value || null })}
            >
              {EXTRACTED_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1">
            <span className="text-muted">排序</span>
            <select
              className={fieldClass}
              value={sort}
              onChange={(e) => patch({ sort: e.target.value === 'published' ? null : e.target.value })}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={btnSecondary}
            title={order === 'desc' ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序'}
            onClick={() => patch({ order: order === 'desc' ? null : 'asc' })}
          >
            {order === 'desc' ? '↓ 降序' : '↑ 升序'}
          </button>

          {hasFilter ? (
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              重置
            </button>
          ) : null}
        </div>
      </Card>

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
