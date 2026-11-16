import type { ReactNode } from 'react';
import type { EntryStatus } from '@gamepulse/shared';
import { ENTRY_STATUS_LABEL } from '@gamepulse/shared';

/** 通用小组件：徽标、卡片、加载/错误占位、分页。 */

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-[#f0f2f5] text-[#3d4653]',
  ok: 'bg-[#e7f5ec] text-ok',
  warn: 'bg-[#fdf1e3] text-warn',
  danger: 'bg-[#fbe9e9] text-danger',
  brand: 'bg-brand-weak text-brand',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 ${TONE_CLASS[tone]}`}>
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

export function QueryState({ loading, error }: { loading: boolean; error: unknown }) {
  if (loading) return <div className="px-1 py-6 text-[13px] text-muted">加载中…</div>;
  if (error) {
    return (
      <div className="my-2 rounded border border-[#f0c9c9] bg-[#fdf4f4] px-3 py-2 text-[13px] text-danger">
        请求失败：{(error as Error).message}
      </div>
    );
  }
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-[13px] text-muted">{children}</div>;
}

/** 分页：页码从 1 开始，越界自动收敛 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </button>
      <span>
        第 {Math.min(page, pageCount)} / {pageCount} 页 · 共 {total} 条
      </span>
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </button>
    </div>
  );
}
