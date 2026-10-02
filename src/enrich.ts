import { listUnrecognizedImages, saveOcrFailure, saveOcrRecord } from './store.js';
import { recognizeImage } from './ocr.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('ocr.enrich');

/**
 * OCR 富化（结构化处理链第一步，见 PRD §5.3）：
 * 扫描待识别图片（无记录 / failed 未达重试上限），逐张识别入库。
 * - 幂等：ocr_records 按 image_url 全局唯一，同图永不重复识别；
 * - 状态机：失败记 failed（attempts 累加），达上限（OCR_MAX_ATTEMPTS，默认 3）后放弃，防死图挤占批次；
 * - 单批限量：OCR_BATCH_LIMIT（默认 20 张）防止首轮全量跑太久，剩余留待下批；
 * - 失败兜底：单图失败仅告警不阻断，下批按状态自动重试。
 */

/** 单批最多识别的图片张数 */
function batchLimit(): number {
  const raw = Number(process.env.OCR_BATCH_LIMIT ?? 20);
  return Number.isFinite(raw) && raw >= 1 ? raw : 20;
}

/** 单图最大尝试次数，超过即放弃（死图） */
function maxAttempts(): number {
  const raw = Number(process.env.OCR_MAX_ATTEMPTS ?? 3);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
}

export async function enrichOcr(): Promise<{ imagesDone: number; imagesFailed: number; skippedByLimit: number }> {
  const limit = batchLimit();
  const attempts = maxAttempts();
  const pending = await listUnrecognizedImages(attempts);
  log.info('OCR 开始 pendingImages=%d batchLimit=%d maxAttempts=%d', pending.length, limit, attempts);

  let imagesDone = 0;
  let imagesFailed = 0;
  let skippedByLimit = 0;
  const t0 = Date.now();

  for (const { postId, imageUrl } of pending) {
    // 批次上限：成功+失败都占用配额，防止失败打满跑挂侧车
    if (imagesDone + imagesFailed >= limit) {
      skippedByLimit++;
      continue;
    }
    try {
      const { text } = await recognizeImage(imageUrl);
      await saveOcrRecord(imageUrl, postId, text);
      imagesDone++;
    } catch (e) {
      imagesFailed++;
      await saveOcrFailure(imageUrl, postId, (e as Error).message);
      log.error('OCR 失败 imageUrl=%s err=%s', imageUrl, (e as Error).message);
    }
  }

  log.info(
    'OCR 完成 imagesDone=%d imagesFailed=%d overLimit=%d costMs=%d',
    imagesDone, imagesFailed, skippedByLimit, Date.now() - t0,
  );
  return { imagesDone, imagesFailed, skippedByLimit };
}
