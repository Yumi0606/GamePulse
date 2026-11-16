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
        <a className="text-[14px]" href={post.url} target="_blank" rel="noreferrer" title={post.description}>
          {post.title}
        </a>
        {post.images?.length ? <span className="text-[12px] text-muted">[图 ×{post.images.length}]</span> : null}
        {post.entryCount === null ? <Badge tone="warn">未提取</Badge> : null}
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
