import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { EntryStatus } from '@gamepulse/shared';
import { ENTRY_STATUS_LABEL } from '@gamepulse/shared';

/** 通用小组件：按钮档位、徽标、卡片、加载/错误占位、分页。 */

/** 按钮三档：主要行动用 primary，表单操作用 secondary，行内次要动作用 ghost */
export const btnPrimary =
  'inline-flex items-center gap-1 rounded bg-brand px-3 py-1 text-[13px] font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40';
export const btnSecondary =
  'inline-flex items-center gap-1 rounded border border-line bg-surface px-2.5 py-1 text-[13px] text-ink hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40';
export const btnGhost = 'inline-flex items-center gap-1 rounded px-2 py-1 text-[13px] text-brand hover:bg-brand-weak';

/** 表单控件统一外观（select / input / date） */
export const fieldClass = 'rounded border border-line bg-surface px-1.5 py-1 text-[13px]';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-neutral-weak text-ink-soft',
  ok: 'bg-ok-weak text-ok',
  warn: 'bg-warn-weak text-warn',
  danger: 'bg-danger-weak text-danger',
  brand: 'bg-brand-weak text-brand',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[12px] leading-4 ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

/** 中性虚线标签：表达「这条数据不精确」，与表达状态/紧迫度的徽标区分 */
export function SubtleTag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded border border-dashed border-line px-1.5 py-0.5 text-[12px] text-muted"
      title={title}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<EntryStatus, Tone> = {
  ongoing: 'ok',
  'not-started': 'brand',
  ended: 'neutral',
  unknown: 'warn',
};

export function StatusBadge({ status }: { status: EntryStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{ENTRY_STATUS_LABEL[status]}</Badge>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line bg-surface p-3 ${className}`}>{children}</section>;
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-2">
      <h2 className="border-l-4 border-brand pl-2 text-[15px] font-semibold">{children}</h2>
      {extra ? <span className="text-[12px] text-muted">{extra}</span> : null}
    </div>
  );
}

/** 骨架行：保持加载前后的布局高度一致，避免内容到达时页面跳动 */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-1" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="animate-pulse space-y-1.5">
          <div className="h-3.5 w-1/3 rounded bg-neutral-weak" />
          <div className="h-3 w-2/3 rounded bg-neutral-weak" />
        </div>
      ))}
    </div>
  );
}

/**
 * 查询占位：加载时给骨架行，失败时给可重试的错误条。
 * `onRetry` 缺省时只显示错误文字（用于没有查询对象的静态区块）。
 */
export function QueryState({
  loading,
  error,
  onRetry,
  rows,
}: {
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  rows?: number;
}) {
  if (loading) return <SkeletonRows rows={rows} />;
  if (error) {
    return (
      <div className="my-2 flex flex-wrap items-center gap-2 rounded border border-danger/30 bg-danger-weak px-3 py-2 text-[13px] text-danger">
        <span>加载失败：{(error as Error).message}</span>
        {onRetry ? (
          <button type="button" className={btnSecondary} onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-[13px] text-muted">{children}</div>;
}

/**
 * 分页：页码从 1 开始，越界自动收敛。
 * `onPageSizeChange` 提供时才渲染每页条数选择，避免无分页能力的列表出现死控件。
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const [jump, setJump] = useState(String(current));
  useEffect(() => setJump(String(current)), [current]);

  const go = () => {
    const n = Number(jump);
    if (!Number.isFinite(n)) {
      setJump(String(current));
      return;
    }
    onChange(Math.min(pageCount, Math.max(1, Math.trunc(n))));
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      <button type="button" className={btnSecondary} disabled={current <= 1} onClick={() => onChange(current - 1)}>
        上一页
      </button>
      <span className="tabular-nums">
        第 {current} / {pageCount} 页 · 共 {total} 条
      </span>
      <button
        type="button"
        className={btnSecondary}
        disabled={current >= pageCount}
        onClick={() => onChange(current + 1)}
      >
        下一页
      </button>
      <span className="flex items-center gap-1">
        跳到
        <input
          type="number"
          min={1}
          max={pageCount}
          className="w-14 rounded border border-line bg-surface px-1 py-0.5 text-center text-[12px] tabular-nums"
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          onBlur={go}
          aria-label="跳转到页码"
        />
        页
      </span>
      {onPageSizeChange ? (
        <label className="flex items-center gap-1">
          每页
          <select
            className="rounded border border-line bg-surface px-1 py-0.5 text-[12px]"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          条
        </label>
      ) : null}
    </div>
  );
}
