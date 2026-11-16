import { fmtCst } from '@gamepulse/shared';

/**
 * 展示层时间/文本工具。
 *
 * 时间一律北京时间；fmtCst 来自共享包（与 RSS 输出同一实现），
 * 本文件只补前端需要的日期粒度与相对时间。
 */

const CST_OFFSET_SEC = 8 * 3600;
const DAY_SEC = 86400;

const DATE_ONLY = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Unix 秒 → 北京时间 `YYYY-MM-DD` */
export function fmtCstDate(unix: number): string {
  return DATE_ONLY.format(unix * 1000);
}

/** 时间边界展示：纯日期条目（known=false）只显示日期，不显示补出来的时分 */
export function fmtBound(unix: number | undefined, known?: boolean): string {
  if (unix === undefined) return '—';
  return known === false ? fmtCstDate(unix) : fmtCst(unix);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function fmtRelative(unix: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - unix);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < DAY_SEC) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < DAY_SEC * 30) return `${Math.floor(diff / DAY_SEC)} 天前`;
  return fmtCstDate(unix);
}

/** 北京时间日期字符串（YYYY-MM-DD）→ 当日 00:00 的 Unix 秒；非法输入返回 undefined */
export function cstDateStart(date: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const ts = Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000);
  return Number.isNaN(ts) ? undefined : ts;
}

/** 北京时间日期字符串 → 当日 23:59:59 的 Unix 秒 */
export function cstDateEnd(date: string): number | undefined {
  const start = cstDateStart(date);
  return start === undefined ? undefined : start + DAY_SEC - 1;
}

/** 当前北京时间所在月（YYYY-MM） */
export function currentCstMonth(nowSec: number = Math.floor(Date.now() / 1000)): string {
  const shifted = new Date((nowSec + CST_OFFSET_SEC) * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 把秒数差格式化为「天/小时」的易读时长 */
export function fmtDuration(sec: number): string {
  const days = sec / DAY_SEC;
  if (days >= 1) return `${Math.round(days * 10) / 10} 天`;
  return `${Math.round((sec / 3600) * 10) / 10} 小时`;
}
