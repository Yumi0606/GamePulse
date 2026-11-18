import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { moduleLogger } from '../core/logger.js';
import { REPO_ROOT } from '../core/paths.js';

const log = moduleLogger('vite');

type Next = (err?: unknown) => void;

/** Vite 返回的中间件形态与关闭方法（只声明本文件用到的部分） */
interface ViteDevServer {
  middlewares: (req: IncomingMessage, res: ServerResponse, next: Next) => void;
  close: () => Promise<void>;
}

/** 挂载所需的 Fastify 能力子集：泛型日志类型不同，按结构声明避免把实例类型带进来 */
export interface DevHost {
  server: Server;
  get: (path: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) => unknown;
  addHook: (name: 'onClose', handler: () => Promise<void>) => unknown;
}

/**
 * 开发形态：把 Vite 以 middlewareMode 挂进同一个 Fastify 实例。
 *
 * 单端口硬约束：3000 同时提供前端页面与 `/api/v1`（数据），
 * 不另起 5173。Vite 从 apps/web 解析（依赖声明在 @gamepulse/web），
 * 服务端包不重复声明前端依赖。
 */
export async function attachViteDev(app: DevHost): Promise<void> {
  const webRoot = path.join(REPO_ROOT, 'apps/web');
  const require = createRequire(path.join(webRoot, 'package.json'));
  const viteEntry = require.resolve('vite');
  const viteModule = (await import(pathToFileURL(viteEntry).href)) as {
    createServer: (inline: Record<string, unknown>) => Promise<ViteDevServer>;
  };

  const vite = await viteModule.createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: { server: app.server },
    },
  });
  app.addHook('onClose', async () => {
    await vite.close();
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    vite.middlewares(request.raw, reply.raw, (err) => {
      if (err) {
        request.log.error(err);
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          reply.raw.end('Vite 中间件错误');
        }
        return;
      }
      // Vite 未接管（既不是 HTML 也不是静态资源）：直接 404，不落其它处理器
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        reply.raw.end('Not Found');
      }
    });
  };

  app.get('/', handler);
  app.get('/*', handler);

  log.info('Vite 开发中间件已挂载 root=%s base=/', webRoot);
}
