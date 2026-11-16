import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CalendarPage } from './pages/CalendarPage';
import { HealthPage } from './pages/HealthPage';
import { ListPage } from './pages/ListPage';
import { WeekPage } from './pages/WeekPage';

/**
 * 路由表。
 *
 * 四个页面与旧展示层一一对应：列表 / 日历 / 周视图 / 源健康。
 * 旧页面仍在 / /calendar /week /health 提供，过渡期两套共存。
 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ListPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="week" element={<WeekPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
