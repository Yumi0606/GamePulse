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
