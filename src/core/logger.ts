/**
 * 全局结构化日志（pino）。
 * 开发默认经 pino-pretty 美化（时间 + 级别 + 模块）；设 LOG_PRETTY=0 输出纯 JSON 行（服务器采集用）。
 * 日志落盘：默认写入 logs/app.log（pino 内置 file target，零新依赖），设 LOG_FILE='' 关闭。
 * 级别用 LOG_LEVEL 控制（默认 info；排查卡点时开 debug 可看到每个请求的进入点）。
 *
 * 监控约定：每个阶段进入时打 info（含关键参数），完成/失败时打带耗时的日志——
 * 进程卡住时，最后一条日志即为卡点位置。
 * 错误日志约定：catch 处用 log.error({ err: e }, '...') 传 Error 对象，保留堆栈。
 */
import pino from 'pino';

// 注意：本模块可能先于 env.ts 执行（ESM 依赖顺序），故直接读 process.env，
// LOG_LEVEL/LOG_PRETTY/LOG_FILE 由入口文件最先 import core/env.js 保证 .env 已加载
const LOG_FILE = process.env.LOG_FILE ?? 'logs/app.log';

/** 输出流：文件（默认 logs/app.log）+ 美化控制台；都关闭时退化为无 transport */
function buildTransport(): pino.TransportMultiOptions | undefined {
  const targets: pino.TransportTargetOptions[] = [];
  if (LOG_FILE !== '') {
    targets.push({ target: 'pino/file', options: { destination: LOG_FILE, mkdir: true } });
  }
  if (process.env.LOG_PRETTY !== '0') {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    });
  }
  return targets.length > 0 ? { targets } : undefined;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: buildTransport(),
});

/** 创建带模块名的子 logger，如 moduleLogger('pipeline') */
export function moduleLogger(module: string): pino.Logger {
  return logger.child({ module });
}

/**
 * 注册进程级兜底（常驻服务入口调用）：
 * - unhandledRejection：只记日志不退出（防一处漏 catch 静默杀进程，Node ≥15 默认 crash）；
 * - uncaughtException：记日志后退出（状态已不可信，交给托管方重启）。
 */
export function installFatalHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '未捕获异常，进程退出');
    process.exit(1);
  });
}
