import { useState } from 'react';
import type { ReactNode } from 'react';
import { Card, btnSecondary, fieldClass } from './ui';

/**
 * 筛选区外壳与字段栅格。
 *
 * 原先各页面用 flex-wrap 平铺「标签 + 控件」，窄屏会折成参差不齐的多行，
 * 标签与控件也不对齐。这里统一为固定列栅格 + 标签在上：
 * 主筛选常驻，次级筛选在窄屏收进「更多筛选」，桌面端默认展开。
 */
export function FilterPanel({
  primary,
  advanced,
  toolbar,
  note,
  actions,
  onReset,
  resetEnabled = false,
  advancedCount = 0,
}: {
  /** 常驻筛选控件 */
  primary: ReactNode;
  /** 次级筛选控件：窄屏默认收起 */
  advanced?: ReactNode;
  /** 与筛选同级的视图控制（精度、行高等），始终可见 */
  toolbar?: ReactNode;
  /** 右侧说明文字 */
  note?: ReactNode;
  /** 附加操作按钮，渲染在「更多筛选」「重置」之前 */
  actions?: ReactNode;
  onReset?: () => void;
  /** 仅在有筛选生效时显示重置按钮 */
  resetEnabled?: boolean;
  /** 收起的次级筛选中生效的项数，用于提示 */
  advancedCount?: number;
}) {
  // 初始状态按桌面断点决定；之后交给用户手动切换，窗口缩放不强制重置
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches,
  );

  return (
    <Card className="p-0">
      <div className="flex flex-col gap-2 px-3 py-2.5 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">{primary}</div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {note ? <span className="mr-auto text-[12px] text-muted lg:mr-0">{note}</span> : null}
          {actions}
          {advanced ? (
            <button type="button" className={btnSecondary} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? '收起筛选' : '更多筛选'}
              {!open && advancedCount > 0 ? (
                <span className="ml-0.5 rounded bg-brand-weak px-1 text-[11px] tabular-nums text-brand">
                  {advancedCount}
                </span>
              ) : null}
            </button>
          ) : null}
          {onReset && resetEnabled ? (
            <button type="button" className={btnSecondary} onClick={onReset}>
              重置
            </button>
          ) : null}
        </div>
      </div>
      {advanced && open ? <div className="border-t border-line px-3 py-2.5">{advanced}</div> : null}
      {toolbar ? <div className="border-t border-line px-3 py-2">{toolbar}</div> : null}
    </Card>
  );
}

/** 筛选字段栅格：手机 2 列、sm 3 列、lg 4 列，字段底部对齐 */
export function FilterGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-2 items-end gap-2 sm:grid-cols-3 lg:grid-cols-4 ${className}`}>
      {children}
    </div>
  );
}

/** 单个筛选字段：标签在上，控件占满该列宽度；hint 以 title 呈现 */
export function FilterField({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`} title={hint}>
      <span className="text-[12px] leading-none text-muted">{label}</span>
      {children}
    </label>
  );
}

/** 栅格内的控件统一宽度，避免 select 按内容撑开导致列宽不齐 */
export const controlClass = `${fieldClass} w-full min-w-0`;
