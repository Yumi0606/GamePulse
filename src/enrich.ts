import type { Item } from './types.js';
import { loadItems, updateItem } from './store.js';
import { recognizeImage } from './ocr.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('ocr.enrich');

/**
 * 库存富化（结构化处理链第一步，见 PRD §5.3）：
 * 对带图但尚无 ocrTexts 的条目补 OCR 文本。
 * - 幂等：已有 ocrTexts 的条目跳过，图片不会重复识别；
 * - 单批限量：OCR_BATCH_LIMIT（默认 20 张）防止首轮全量跑太久，剩余留待下批；
 * - 失败兜底：侧车不可用/单图失败时跳过并告警，不阻断同步，未识别的留给下批重试。
 */

/** 单批最多识别的图片张数 */
function batchLimit(): number {
  const raw = Number(process.env.OCR_BATCH_LIMIT ?? 20);
  return Number.isFinite(raw) && raw >= 1 ? raw : 20;
}

export async function enrichOcr(): Promise<{ itemsDone: number; imagesDone: number; imagesFailed: number; skippedByLimit: number }> {
  const items = await loadItems();
  // 待处理条件：任一图片尚无对应 OCR 结果（按图片级增量，已识别的永不重复）
  const pending = items.filter(
    (it) => (it.images?.length ?? 0) > 0 && (it.images ?? []).some((url) => !(it.ocrTexts ?? []).some((t) => t.imageUrl === url)),
  );
  const limit = batchLimit();
  log.info('OCR 开始 pendingItems=%d batchLimit=%d', pending.length, limit);

  let imagesDone = 0;
  let imagesFailed = 0;
  let itemsDone = 0;
  let used = 0;
  let skippedByLimit = 0;
  const t0 = Date.now();

  for (const item of pending) {
    // 批次上限：按整条为单位跳过，剩余留待下批
    if (used >= limit) {
      skippedByLimit++;
      continue;
    }

    const known = new Set((item.ocrTexts ?? []).map((t) => t.imageUrl));
    const results: NonNullable<Item['ocrTexts']> = [];
    for (const imageUrl of item.images ?? []) {
      if (used >= limit) { skippedByLimit++; break; }
      if (known.has(imageUrl)) continue; // 已有结果，跳过
      try {
        results.push(await recognizeImage(imageUrl));
        used++;
        imagesDone++;
      } catch (e) {
        used++; // 失败也占用配额，避免死循环打挂侧车
        imagesFailed++;
        log.error('OCR 失败 imageUrl=%s err=%s', imageUrl, (e as Error).message);
      }
    }

    if (results.length > 0) {
      // 旧结果 + 新识别结果按图片顺序合并写回
      const merged = [...(item.ocrTexts ?? []), ...results];
      await updateItem(item.id, { ocrTexts: merged });
      itemsDone++;
      log.debug('OCR 条目完成 id=%s ocrImages=%d', item.id, merged.length);
    }
  }

  log.info(
    'OCR 完成 items=%d imagesDone=%d imagesFailed=%d overLimit=%d costMs=%d',
    itemsDone, imagesDone, imagesFailed, skippedByLimit, Date.now() - t0,
  );
  return { itemsDone, imagesDone, imagesFailed, skippedByLimit };
}
