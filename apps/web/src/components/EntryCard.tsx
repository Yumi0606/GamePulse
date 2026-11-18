import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntryDto, PostDto } from '@gamepulse/shared';
import { ENTRY_LIFECYCLE_LABEL, ENTRY_TYPE_LABEL, fmtCst } from '@gamepulse/shared';
import { fmtBound, fmtCountdown } from '../lib/format';
import { OcrPanel } from './OcrPanel';
import { Badge, StatusBadge, SubtleTag } from './ui';

/** 来源动态默认展示条数 */
const SOURCE_PREVIEW = 2;

/**
 * 结构化条目卡片。
 *
 * 信息分两层：主视图只回答「是什么、还剩多久、什么时候结束」；
 * 预估、可信度、时间引用、来源动态、单条 RSS 收进「数据详情」，供核验使用。
 * 时间展示遵守 startTimeKnown/endTimeKnown：纯日期条目只显示日期。
 */
export function EntryCard({
  entry,
  gameName,
  postById,
  now,
  rewardIsKey = false,
}: {
  entry: EntryDto;
  gameName: string;
  postById: Map<string, PostDto>;
  /** 服务端当前时间（Unix 秒），用于计算剩余时间 */
  now: number;
  /** 当前排序依据是奖励领取截止：在卡片上显式标注，避免误读成活动结束 */
  rewardIsKey?: boolean;
}) {
  const sourceIds = entry.postIds?.length ? entry.postIds : entry.postId ? [entry.postId] : [];
  const showEvidence = entry.estimated === true || entry.confidence < 0.7 || (entry.phases?.length ?? 0) > 0;
  // 合并条目可能挂十几条来源：默认只列前两条，其余折叠
  const [allSources, setAllSources] = useState(false);
  const visibleSourceIds = allSources ? sourceIds : sourceIds.slice(0, SOURCE_PREVIEW);
  const restSources = sourceIds.length - visibleSourceIds.length;

  // 剩余时间只对未结束且结束时间已知的条目有意义
  const countdown =
    entry.status !== 'ended' && entry.endAt !== undefined ? fmtCountdown(entry.endAt, now) : undefined;
  const countdownTone =
    countdown === '已截止'
      ? 'text-muted'
      : entry.endAt !== undefined && entry.endAt - now < 3 * 86400
        ? 'text-brand font-semibold'
        : 'text-ink-soft';
  const rewardPast = entry.rewardEndAt !== undefined && entry.rewardEndAt < now;

  return (
    <li id={`entry-${entry.id}`} className="px-1 py-3">
      {/* 第一行：标题是主体，游戏与分类只做定语 */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[12px] text-muted">{gameName}</span>
        <Badge tone="brand">{ENTRY_TYPE_LABEL[entry.type]}</Badge>
        {entry.url ? (
          <a
            className="text-[15px] font-medium text-ink hover:text-brand"
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            title={entry.description}
          >
            {entry.title}
          </a>
        ) : (
          <span className="text-[15px] font-medium" title={entry.description}>
            {entry.title}
          </span>
        )}
      </div>

      {/* 第二行：状态、剩余时间、起止时刻 */}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <StatusBadge status={entry.status} />
        {rewardIsKey ? <Badge tone="warn">奖励截止</Badge> : null}
        {/* 常驻与一次性更新没有结束时间，标出生命周期避免被读成「结束未知」 */}
        {entry.lifecycle && entry.lifecycle !== 'limited' ? (
          <SubtleTag
            title={entry.lifecycle === 'permanent' ? '常驻条目没有预设结束节点' : '一次性内容更新，本身没有持续期'}
          >
            {ENTRY_LIFECYCLE_LABEL[entry.lifecycle]}
          </SubtleTag>
        ) : null}
        {countdown ? <span className={`tabular-nums ${countdownTone}`}>{countdown}</span> : null}
        <span className="font-mono text-[12px] tabular-nums text-muted">
          {fmtBound(entry.startAt, entry.startTimeKnown)} → {fmtBound(entry.endAt, entry.endTimeKnown)}
          {entry.estimated ? '（预估）' : ''}
        </span>
      </div>

      {/* 奖励领取截止：独立的行动时间，用唯一的强调色 */}
      {entry.rewardEndAt !== undefined ? (
        <div className={`mt-1 text-[13px] ${rewardPast ? 'text-muted' : 'text-brand'}`}>
          奖励领取截止 <span className="font-mono tabular-nums">{fmtCst(entry.rewardEndAt)}</span>
          <span className="px-1">·</span>
          <span className="font-medium tabular-nums">{fmtCountdown(entry.rewardEndAt, now)}</span>
        </div>
      ) : null}

      {entry.summary ? <div className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{entry.summary}</div> : null}

      <details className="mt-1.5 text-[12px]">
        <summary className="text-muted">数据详情</summary>
        <div className="mt-1 space-y-1.5 rounded border border-line bg-bg-sunk p-2">
          <div className="flex flex-wrap items-center gap-2">
            <SubtleTag title="解析模型给出的可信度，低于 0.7 建议核对原文">
              可信度 {entry.confidence.toFixed(2)}
              {entry.confidence < 0.7 ? '（一般）' : '（较高）'}
            </SubtleTag>
            {entry.estimated ? <SubtleTag title="起止时间由语义推断，不是原文精确表述">时间预估</SubtleTag> : null}
            <a href={`/rss/entry?id=${encodeURIComponent(entry.id)}`} target="_blank" rel="noreferrer">
              单条 RSS
            </a>
          </div>

          {entry.publishedAt ? (
            <div>
              <span className="text-muted">发布时间：</span>
              {fmtCst(entry.publishedAt)}
            </div>
          ) : null}
          {entry.description ? (
            <div>
              <span className="text-muted">条目说明：</span>
              {entry.description}
            </div>
          ) : null}
          {entry.category ? (
            <div>
              <span className="text-muted">分类：</span>
              {entry.category}
            </div>
          ) : null}
          {entry.tags?.length ? (
            <div>
              <span className="text-muted">标签：</span>
              {entry.tags.map((t) => `#${t}`).join(' ')}
            </div>
          ) : null}
          {entry.canonicalName ? (
            <div>
              <span className="text-muted">规范名：</span>
              {entry.canonicalName}
            </div>
          ) : null}

          {entry.startRef || entry.endRef ? (
            <div>
              <span className="text-muted">时间依据：</span>
              {entry.startRef ? `开始「${entry.startRef.refText}」` : ''}
              {entry.startRef && entry.endRef ? '　' : ''}
              {entry.endRef ? `结束「${entry.endRef.refText}」` : ''}
            </div>
          ) : null}

          {showEvidence && entry.startRef?.semanticNote ? (
            <div>
              <span className="text-muted">语义锚定：</span>
              {entry.startRef.semanticNote}
            </div>
          ) : null}

          {entry.phases?.length ? (
            <div>
              <div className="text-muted">活动分段</div>
              <ul className="mt-0.5 space-y-0.5">
                {entry.phases.map((p) => (
                  <li key={p.index}>
                    #{p.index} {p.title ?? ''}：{p.startAt ? fmtCst(p.startAt) : '—'} →{' '}
                    {p.endAt ? fmtCst(p.endAt) : '—'}
                    {p.estimated ? '（预估）' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="text-muted">来源动态（{sourceIds.length}）</div>
            {sourceIds.length === 0 ? <div className="text-muted">无关联动态</div> : null}
            <ul className="mt-1 space-y-1">
              {visibleSourceIds.map((id) => {
                const post = postById.get(id);
                return (
                  <li key={id} className="rounded border border-line bg-surface p-1.5">
                    {/* 标题统一跳原始动态页并定位该条；未加载 PostDto（如首页）时用 id 作可点击文本 */}
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link
                        className={post ? 'text-ink hover:text-brand' : 'font-mono text-brand hover:underline'}
                        to={`/posts?id=${encodeURIComponent(id)}`}
                      >
                        {post ? post.title : id}
                      </Link>
                      {post ? <span className="text-muted">发布于 {fmtCst(post.publishedAt)}</span> : null}
                      {post?.url ? (
                        <a href={post.url} target="_blank" rel="noreferrer" title="打开平台原始地址">
                          原始地址
                        </a>
                      ) : null}
                    </div>
                    {post ? <OcrPanel postId={id} imageCount={post.images?.length} /> : null}
                  </li>
                );
              })}
            </ul>
            {sourceIds.length > SOURCE_PREVIEW ? (
              <button
                type="button"
                className="mt-1 text-[12px] text-brand hover:underline"
                onClick={() => setAllSources((value) => !value)}
              >
                {allSources ? '收起来源' : `还有 ${restSources} 条来源`}
              </button>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}
