import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

/**
 * 前端入口。
 *
 * 单端口部署：应用挂在 /app 子路径（Vite base 与 nginx location 一致），
 * 数据只经 /api/v1 获取。路由用 BrowserRouter + basename。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据由后端定时任务刷新，前端不做高频轮询；健康页单独覆盖 refetchInterval
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
