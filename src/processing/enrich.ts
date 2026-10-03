import { listUnrecognizedImages, saveOcrFailure, saveOcrRecord } from '../storage/store.js';
import { OcrInfraError, recognizeImage } from './ocr.js';
import { envNum } from '../core/env.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('ocr.enrich');

/**
 * OCR 富化（结构化处理链第一步，见 PRD §5.3）：
 * 扫描待识别图片（无记录 / failed 未达重试上限且已过冷却），逐张识别入库。
 * - 幂等：ocr_records 按 image_url 全局唯一，同图永不重复识别；
 * - 状态机：失败记 failed（attempts 累加），达上限（OCR_MAX_ATTEMPTS，默认 3）后放弃，防死图挤占批次；
 * - 失败分类：基础设施失败（侧车未启动/超时，OcrInfraError）不消耗 attempts，只记冷却时间，
 *   防止侧车宕机期间烧光全部图片的重试额度；连续多次基础设施失败则熔断本批剩余；
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

/** 失败重试冷却（秒）：刚失败过的图片在冷却期内不再尝试（默认 300s，0=不冷却） */
function retryCooldownSeconds(): number {
  return envNum('OCR_RETRY_COOLDOWN', 300);
}

/** 连续基础设施失败达该次数即熔断本批剩余（服务大概率挂了，继续只会白等超时） */
const INFRA_BREAK_STREAK = 3;

/** OCR 富化主流程：清一次待识别积压 */
export async function enrichOcr(): Promise<{
  imagesDone: number;
  imagesFailed: number;
  imagesInfra: number;
  skippedByLimit: number;
  aborted: boolean;
}> {
  const limit = batchLimit();
  const attempts = maxAttempts();
  const cooldown = retryCooldownSeconds();
  const pending = await listUnrecognizedImages(attempts, cooldown);
  log.info('OCR 开始 pendingImages=%d batchLimit=%d maxAttempts=%d cooldown=%ds', pending.length, limit, attempts, cooldown);

  let imagesDone = 0;
  let imagesFailed = 0;
  let imagesInfra = 0;
  let skippedByLimit = 0;
  let infraStreak = 0;
  let aborted = false;
  const t0 = Date.now();

  for (const { postId, imageUrl } of pending) {
    if (aborted) {
      skippedByLimit++;
      continue;
    }
    // 批次上限：成功+失败都占用配额，防止失败打满跑挂侧车
    if (imagesDone + imagesFailed + imagesInfra >= limit) {
      skippedByLimit++;
      continue;
    }
    try {
      const { text } = await recognizeImage(imageUrl);
      await saveOcrRecord(imageUrl, postId, text);
      imagesDone++;
      infraStreak = 0;
    } catch (e) {
      const isInfra = e instanceof OcrInfraError;
      await saveOcrFailure(imageUrl, postId, (e as Error).message, isInfra);
      log.error({ err: e }, isInfra ? 'OCR 基础设施失败(不计次数) imageUrl=%s' : 'OCR 失败 imageUrl=%s', imageUrl);
      if (isInfra) {
        imagesInfra++;
        infraStreak++;
        if (infraStreak >= INFRA_BREAK_STREAK) {
          log.warn('连续 %d 次基础设施失败，熔断本批剩余图片（下批自动重试），请检查 OCR 侧车', infraStreak);
          aborted = true;
        }
      } else {
        imagesFailed++;
        infraStreak = 0;
      }
    }
  }

  log.info(
    'OCR 完成 imagesDone=%d imagesFailed=%d imagesInfra=%d overLimit=%d aborted=%s costMs=%d',
    imagesDone, imagesFailed, imagesInfra, skippedByLimit, aborted, Date.now() - t0,
  );
  return { imagesDone, imagesFailed, imagesInfra, skippedByLimit, aborted };
}
