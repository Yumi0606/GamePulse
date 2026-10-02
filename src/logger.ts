/**
 * 全局结构化日志（pino）。
 * 开发默认经 pino-pretty 美化（时间 + 级别 + 模块）；设 LOG_PRETTY=0 输出纯 JSON 行（服务器采集用）。
 * 级别用 LOG_LEVEL 控制（默认 info；排查卡点时开 debug 可看到每个请求的进入点）。
 *
 * 监控约定：每个阶段进入时打 info（含关键参数），完成/失败时打带耗时的日志——
 * 进程卡住时，最后一条日志即为卡点位置。
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.LOG_PRETTY === '0'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
});

/** 创建带模块名的子 logger，如 moduleLogger('pipeline') */
export function moduleLogger(module: string): pino.Logger {
  return logger.child({ module });
}
