import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge } from './ui';

/**
 * 单条动态的 OCR 明细，默认收起，展开时才请求 /posts/:id/ocr。
 *
 * 列表接口不返回 OCR 文本：长图文本量大，按需拉取才不至于拖慢列表。
 */
export function OcrPanel({ postId, imageCount }: { postId: string; imageCount?: number }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['post-ocr', postId],
    queryFn: () => api.postOcr(postId),
    enabled: open,
  });

  return (
    <details
      className="mt-1 text-[12px]"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="text-muted">OCR 文本（{imageCount ?? 0} 张图）</summary>
      {query.isLoading ? <div className="px-2 py-1 text-muted">读取中…</div> : null}
      {query.error ? <div className="px-2 py-1 text-danger">{(query.error as Error).message}</div> : null}
      {query.data ? (
        <div className="mt-1 space-y-1.5">
          {query.data.images.length === 0 ? <div className="text-muted">该动态没有图片</div> : null}
          {query.data.images.map((img, index) => (
            // 图片级折叠：多图动态默认只展开第一张，避免整块 OCR 文本一次铺开
            <details
              key={img.imageUrl}
              open={index === 0}
              className="rounded border border-line bg-bg"
            >
              {/* summary 覆盖全局 select-none：图片地址与状态需要能被划选复制 */}
              <summary className="flex flex-wrap items-center gap-2 px-2 py-1 select-text">
                <Badge tone={img.status === 'ok' ? 'ok' : img.status === 'failed' ? 'danger' : 'neutral'}>
                  {img.status}
                </Badge>
                <span className="truncate text-[11px] text-muted">{img.imageUrl}</span>
                {img.attempts > 0 ? <span className="text-[11px] text-muted">尝试 {img.attempts} 次</span> : null}
                <span className="ml-auto shrink-0 text-[11px] text-muted">第 {index + 1} 张</span>
              </summary>
              <div className="px-2 pb-2">
                {img.lastError ? <div className="text-[11px] text-danger">{img.lastError}</div> : null}
                {img.text ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
                    {img.text}
                  </pre>
                ) : (
                  <div className="text-[11px] text-muted">无文本</div>
                )}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </details>
  );
}
