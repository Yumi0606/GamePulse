/**
 * OCR 客户端：对接 RapidOCR 侧车服务（见《调研报告-OCR选型.md》§5）。
 * 侧车未启动时抛错，由 enrich 决定跳过，不阻断同步；
 * 噪声过滤（单字符行、纯数字行）在客户端做，业务规则不固化进通用侧车。
 *
 * 错误分类（供 enrich 决定是否消耗重试次数）：
 * - OcrInfraError：服务不可达/超时/服务端故障 → 临时性问题，不烧 attempts；
 * - 普通错误：死图（侧车报图片下载失败）→ 图片固有问题，烧 attempts 后放弃。
 */

import { envStr } from '../core/env.js';

/** OCR 基础设施错误：服务不可达/超时/5xx 等临时故障，重试不计入内容失败次数 */
export class OcrInfraError extends Error {}

/** 单张图片的识别结果：图片 URL + 按行合并的文本 */
export interface OcrOutcome {
  imageUrl: string;
  text: string;
}

/** 单次 OCR 请求超时（毫秒）：含侧车下载图片与推理（长图约 3s，留足余量） */
const OCR_TIMEOUT_MS = 120_000;

/** OCR 服务地址：函数内惰性读取，保证 .env 加载后取到正确值 */
function ocrUrl(): string {
  return envStr('OCR_SERVICE_URL', 'http://127.0.0.1:1225');
}

/** 识别一张图片；网络/服务异常时抛错（OcrInfraError 或内容类 Error） */
export async function recognizeImage(imageUrl: string): Promise<OcrOutcome> {
  let res: Response;
  try {
    res = await fetch(`${ocrUrl()}/ocr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch (e) {
    // 连接拒绝/超时等 fetch 层异常 → 服务侧临时故障
    throw new OcrInfraError(`OCR 服务不可达：${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 侧车（ocr-service/main.py）对下载失败的死图返回 502 + "图片下载失败"，属图片固有问题
    if (body.includes('图片下载失败')) {
      throw new Error(`死图（下载失败）：HTTP ${res.status}`);
    }
    throw new OcrInfraError(`OCR 服务错误：HTTP ${res.status}`);
  }
  let data: { lines?: string[] };
  try {
    data = (await res.json()) as { lines?: string[] };
  } catch {
    throw new OcrInfraError('OCR 响应非 JSON');
  }
  const lines = data.lines ?? [];
  // 过滤噪声：单字符行（装饰图标误识）、纯数字行（页面编号）
  const kept = lines.filter((l) => l.length > 1 && !/^\d+$/.test(l.trim()));
  return { imageUrl, text: kept.join('\n') };
}

/** 侧车健康检查（当前未用于自动拉起，仅排查用） */
export async function ocrHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ocrUrl()}/docs`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
