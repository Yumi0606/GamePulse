import { NavLink, Outlet } from 'react-router-dom';

/**
 * 全站外壳：标题、四页导航、RSS 入口与旧版入口。
 *
 * 旧版页面仍在根路径提供（过渡期共存）；这里只放链接，不做重定向。
 */
const NAV = [
  { to: '/', label: '列表', end: true },
  { to: '/calendar', label: '日历' },
  { to: '/week', label: '周视图' },
  { to: '/health', label: '源健康' },
];

export function Layout() {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <span className="text-[16px] font-semibold tracking-tight">GamePulse</span>
          <nav className="flex items-center gap-1 text-[13px]">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded px-2.5 py-1 ${
                    isActive ? 'bg-brand-weak font-medium text-brand' : 'text-ink hover:bg-bg'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto flex items-center gap-3 text-[12px] text-muted">
            <span>
              RSS：
              <a href="/rss/entries" target="_blank" rel="noreferrer">
                结构化条目
              </a>
              <span className="px-1">·</span>
              <a href="/rss/posts" target="_blank" rel="noreferrer">
                原始动态
              </a>
            </span>
            <span className="text-line">|</span>
            <a href="/" title="旧版列表页（重构过渡期保留）">
              旧版
            </a>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
