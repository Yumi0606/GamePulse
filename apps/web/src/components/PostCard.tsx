import type { PostDto } from '@gamepulse/shared';
import { fmtCst } from '@gamepulse/shared';
import { OcrPanel } from './OcrPanel';
import { Badge } from './ui';

/**
 * 原始动态单行：发布时间、游戏、原文链接、图片数与按需展开的 OCR。
 * 复制 ID 供重置解析结果时使用（payload 里引用的就是 posts.id）。
 */
export function PostCard({ post, gameName }: { post: PostDto; gameName: string }) {
  const copyId = () => {
    void navigator.clipboard?.writeText(post.id);
  };

  return (
    <li id={`post-${post.id}`} className="px-1 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="w-[132px] shrink-0 font-mono text-[12px] text-muted">{fmtCst(post.publishedAt)}</span>
        <Badge>{gameName}</Badge>
        {/* 状态徽标固定在标题前，标题长短不影响它的位置 */}
        {post.entryCount === null ? <Badge tone="warn">未提取</Badge> : null}
        {post.entryCount === 0 ? (
          <Badge tone="warn">
            <span title="已提取，但没有生成任何活动条目">提取 0 条</span>
          </Badge>
        ) : null}
        <a className="text-[14px]" href={post.url} target="_blank" rel="noreferrer" title={post.description}>
          {post.title}
        </a>
        {post.images?.length ? <span className="text-[12px] text-muted">[图 ×{post.images.length}]</span> : null}
        <span className="ml-auto flex items-center gap-2 text-[11px]">
          <button type="button" className="text-brand hover:underline" onClick={copyId} title="复制该动态在数据库中的 id">
            复制 ID
          </button>
          <a href={`/rss/post?id=${encodeURIComponent(post.id)}`} target="_blank" rel="noreferrer">
            RSS
          </a>
        </span>
      </div>
      {post.description ? <div className="mt-1 line-clamp-2 text-[12px] text-muted">{post.description}</div> : null}
      <OcrPanel postId={post.id} imageCount={post.images?.length} />
    </li>
  );
}
