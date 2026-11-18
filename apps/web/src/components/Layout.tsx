import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

/**
 * 全站外壳：标题、四项用户导航、页脚（运维与订阅入口）。
 *
 * 导航链接透传 gameId / type / q，四个页面的筛选语义保持一致；
 * 源健康与原始动态属于运维/核验入口，只放页脚，不与用户页面同级。
 */
const NAV = [
  { to: '/', label: '即将到期', end: true },
  { to: '/all', label: '全部活动' },
  { to: '/calendar', label: '日历' },
  { to: '/week', label: '周视图' },
];

/** 跨页面保持的筛选参数 */
const CARRIED_KEYS = ['gameId', 'type', 'q'] as const;

export function Layout() {
  const location = useLocation();
  const carried = new URLSearchParams();
  for (const key of CARRIED_KEYS) {
    const value = new URLSearchParams(location.search).get(key);
    if (value) carried.set(key, value);
  }
  const suffix = carried.toString() ? `?${carried}` : '';

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <span className="text-[16px] font-semibold tracking-tight">GamePulse</span>
          <nav className="flex items-center gap-1 text-[13px]">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={`${item.to}${suffix}`}
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
          <span className="ml-auto text-[12px] text-muted">
            RSS：
            <a href="/rss/entries" target="_blank" rel="noreferrer">
              活动
            </a>
            <span className="px-1">·</span>
            <a href="/rss/posts" target="_blank" rel="noreferrer">
              动态
            </a>
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4">
        <Outlet />
      </main>
      <footer className="mx-auto w-full max-w-[1440px] px-4 pb-6 pt-2 text-[12px] text-muted">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3">
          <span>GamePulse · 数据来自各游戏官方社媒</span>
          <Link to="/health">源健康</Link>
          <Link to="/posts">原始动态</Link>
        </div>
      </footer>
    </div>
  );
}
