import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CalendarPage } from './pages/CalendarPage';
import { HealthPage } from './pages/HealthPage';
import { HomePage } from './pages/HomePage';
import { ListPage } from './pages/ListPage';
import { PostsPage } from './pages/PostsPage';
import { WeekPage } from './pages/WeekPage';

/**
 * 路由表。
 *
 * /            即将到期（首页）
 * /all         全部活动（归档列表）
 * /calendar    日历
 * /week        周视图
 * /posts       原始动态（数据核验）
 * /health      源健康（运维）
 * 旧展示层仍在 / /calendar /week /health 提供，过渡期两套共存。
 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="all" element={<ListPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="week" element={<WeekPage />} />
        <Route path="posts" element={<PostsPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
