import type { EntryDto, PostDto } from '@gamepulse/shared';
import { ENTRY_TYPE_LABEL, fmtCst } from '@gamepulse/shared';
import { fmtBound } from '../lib/format';
import { OcrPanel } from './OcrPanel';
import { Badge, StatusBadge } from './ui';

/**
 * 结构化条目单行。
 *
 * 时间展示遵守 startTimeKnown/endTimeKnown：纯日期条目只显示日期。
 * 来源动态取 postIds（旧条目退回 postId），标题由列表页批量查询后传入。
 */
export function EntryCard({
  entry,
  gameName,
  postById,
}: {
  entry: EntryDto;
  gameName: string;
  postById: Map<string, PostDto>;
}) {
  const sourceIds = entry.postIds?.length ? entry.postIds : entry.postId ? [entry.postId] : [];
  const sources = sourceIds.map((id) => postById.get(id)).filter((p): p is PostDto => Boolean(p));
  const showEvidence = entry.estimated === true || entry.confidence < 0.7 || (entry.phases?.length ?? 0) > 0;

  return (
    <li id={`entry-${entry.id}`} className="px-1 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <StatusBadge status={entry.status} />
        <Badge tone="brand">{ENTRY_TYPE_LABEL[entry.type]}</Badge>
        <span className="text-[12px] text-muted">{gameName}</span>
        <span className="font-mono text-[12px] text-muted">
          {fmtBound(entry.startAt, entry.startTimeKnown)} → {fmtBound(entry.endAt, entry.endTimeKnown)}
        </span>
        {entry.estimated ? <Badge tone="warn">预估</Badge> : null}
        {entry.confidence < 0.7 ? <Badge tone="warn">置信 {entry.confidence.toFixed(1)}</Badge> : null}
        {entry.url ? (
          <a
            className="text-[14px] font-medium text-ink hover:text-brand"
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            title={entry.description}
          >
            {entry.title}
          </a>
        ) : (
          <span className="text-[14px] font-medium" title={entry.description}>
            {entry.title}
          </span>
        )}
        <a
          className="ml-auto text-[11px]"
          href={`/rss/entry?id=${encodeURIComponent(entry.id)}`}
          target="_blank"
          rel="noreferrer"
          title="该条目的单条 RSS"
        >
          RSS
        </a>
      </div>

      {entry.rewardEndAt ? (
        <div className="mt-1 text-[12px] text-warn">奖励截止 {fmtCst(entry.rewardEndAt)}</div>
      ) : null}

      {(entry.startRef || entry.endRef) && (
        <div className="mt-1 text-[12px] text-muted">
          {entry.startRef ? `始：${entry.startRef.refText}` : ''}
          {entry.startRef && entry.endRef ? '　' : ''}
          {entry.endRef ? `终：${entry.endRef.refText}` : ''}
        </div>
      )}

      {entry.phases?.length ? (
        <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
          {entry.phases.map((p) => (
            <li key={p.index}>
              #{p.index} {p.title ?? ''}：{p.startAt ? fmtCst(p.startAt) : '—'} → {p.endAt ? fmtCst(p.endAt) : '—'}
              {p.estimated ? '（预估）' : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {entry.summary ? <div className="mt-1 text-[13px] text-[#444]">{entry.summary}</div> : null}

      <details className="mt-1 text-[12px]">
        <summary className="text-muted">数据详情</summary>
        <div className="mt-1 space-y-1.5 rounded border border-line bg-bg/60 p-2">
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

          {showEvidence && entry.startRef?.semanticNote ? (
            <div>
              <span className="text-muted">语义锚定：</span>
              {entry.startRef.semanticNote}
            </div>
          ) : null}

          <div>
            <div className="text-muted">来源动态（{sourceIds.length}）</div>
            {sourceIds.length === 0 ? <div className="text-muted">无关联动态</div> : null}
            <ul className="mt-1 space-y-1">
              {sourceIds.map((id) => {
                const post = postById.get(id);
                return (
                  <li key={id} className="rounded border border-line bg-surface p-1.5">
                    {post ? (
                      <div className="flex flex-wrap items-baseline gap-2">
                        <a href={`/rss/post?id=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">
                          {post.title}
                        </a>
                        <span className="text-[11px] text-muted">发布于 {fmtCst(post.publishedAt)}</span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-[11px]">{id}</span>
                        <a className="text-[11px]" href={`/rss/post?id=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">
                          单条 RSS
                        </a>
                      </div>
                    )}
                    <OcrPanel postId={id} imageCount={post?.images?.length} />
                  </li>
                );
              })}
            </ul>
            {sourceIds.length > 0 && sources.length === 0 ? (
              <div className="text-[11px] text-muted">来源动态不在当前查询范围内</div>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}
