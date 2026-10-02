/**
 * OCR 客户端：对接 RapidOCR 侧车服务（见《调研报告-OCR选型.md》§5）。
 * 侧车未启动时抛错，由 enrich 决定跳过，不阻断同步；
 * 噪声过滤（单字符行、纯数字行）在客户端做，业务规则不固化进通用侧车。
 */

const OCR_URL = process.env.OCR_SERVICE_URL ?? 'http://127.0.0.1:1225';

/** 单张图片的识别结果：图片 URL + 按行合并的文本 */
export interface OcrOutcome {
  imageUrl: string;
  text: string;
}

/** 单次 OCR 请求超时（毫秒）：含侧车下载图片与推理（长图约 3s，留足余量） */
const OCR_TIMEOUT_MS = 120_000;

/** 识别一张图片；网络/服务异常时抛错 */
export async function recognizeImage(imageUrl: string): Promise<OcrOutcome> {
  const res = await fetch(`${OCR_URL}/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OCR 服务错误：HTTP ${res.status}`);
  }
  const { lines } = (await res.json()) as { lines: string[] };
  // 过滤噪声：单字符行（装饰图标误识）、纯数字行（页面编号）
  const kept = lines.filter((l) => l.length > 1 && !/^\d+$/.test(l.trim()));
  return { imageUrl, text: kept.join('\n') };
}

/** 侧车健康检查（当前未用于自动拉起，仅排查用） */
export async function ocrHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${OCR_URL}/docs`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
