import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 单端口开发形态：本配置同时用于两种场景。
 *
 * - 开发：由 apps/server/src/web/dev.ts 以 middlewareMode 挂进 Fastify，
 *   3000 端口同时提供 `/` 与 `/api`，不存在独立的前端端口。
 * - 生产：`pnpm build` 产出 apps/web/dist，由 nginx 在根路径托管并反代 /api。
 *
 * base 固定 `/`，保证两种场景的资源路径一致。
 */
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
