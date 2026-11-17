/**
 * 环境变量加载：启动即读取项目根 .env（Node 22 原生能力，零依赖）。
 * 已存在的系统环境变量优先，.env 不覆盖；无 .env 文件时静默跳过（全走默认值）。
 */

import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch {
  // 无 .env 属正常（如 CI/服务器用系统环境变量注入）
}

/** 读取字符串环境变量；未设置或空串返回 fallback */
export function envStr(key: string, fallback = ''): string {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

/** 读取数字环境变量；非法或缺省返回 fallback */
export function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 读取正整数环境变量；非法或小于 1 返回 fallback */
function envPositiveInt(key: string, fallback: number): number {
  const n = envNum(key, fallback);
  return n >= 1 ? Math.floor(n) : fallback;
}

/**
 * OCR 单图最大尝试次数（OCR_MAX_ATTEMPTS，默认 3）。
 * 内容类失败达该次数即放弃（死图），存储层队列与积压计数必须用同一口径。
 */
export function ocrMaxAttempts(): number {
  return envPositiveInt('OCR_MAX_ATTEMPTS', 3);
}

/**
 * LLM 单条动态最大尝试次数（EXTRACT_MAX_ATTEMPTS，默认 3）。
 * 内容类失败达该次数即放弃，存储层队列与积压计数必须用同一口径。
 */
export function extractMaxAttempts(): number {
  return envPositiveInt('EXTRACT_MAX_ATTEMPTS', 3);
}
