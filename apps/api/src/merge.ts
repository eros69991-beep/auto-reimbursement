import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import {
  canMergeReceipt,
  ledgerOf,
  MERGE_MAX,
  MERGE_MIN,
  type FileIndexEntry,
  type ImageRef,
  type Receipt,
} from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { liveCopyInOtherLedger } from './duplicates.js';
import { logger } from './logger.js';
import { assertMutable } from './receipts.js';
import { fileIndexSha256, readVerifiedFile, safePath, storeImage } from './storage.js';

// 同一张订单被截成几张图时，把它们左右拼成一张再识别：AI、PDF 附件、对账、查重仍然是「一单一图」。
// 不能竖着拼——PDF 附件会缩到长边 1600px，竖拼之后每张只剩很窄一条，字就看不清了。
const GAP_PX = 6;
const GAP_COLOR = '#8a8a8a';
const MAX_HEIGHT = 2800;
const MAX_WIDTH = 8400;
const MAX_INPUT_PIXELS = 40_000_000;
// PNG 拼出来太大（多半是照片）时改存 JPEG，免得超过单张 20 MB 的上限
const PNG_LIMIT_BYTES = 12 * 1024 * 1024;

export interface StitchedImage {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  /** 每张来源截图在拼图里的位置（像素，从左起，按拼接顺序）；中间的分隔线不算在任何一张里。 */
  panels: Array<{ left: number; width: number }>;
}

/**
 * 把几张图按顺序左右拼成一张：统一成同一个高度（取最高的那张，上限 2800px），
 * 中间留一条灰色分隔线，方便人和 AI 看出这是几张截图。全是 PNG（截图）时输出 PNG，否则输出 JPEG。
 */
export async function stitchImages(inputs: Buffer[]): Promise<StitchedImage> {
  const sources = await Promise.all(inputs.map(async (bytes) => {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
      throw new Error('INVALID_IMAGE');
    }
    // EXIF 方向 5–8 要转 90°：宽高对调。落盘的图已去过 EXIF，这里兜底旧数据
    const turned = (metadata.orientation ?? 1) >= 5;
    return {
      bytes,
      format: metadata.format,
      width: turned ? metadata.height : metadata.width,
      height: turned ? metadata.width : metadata.height,
    };
  }));

  const gaps = GAP_PX * (sources.length - 1);
  const widthsAt = (height: number): number[] =>
    sources.map((source) => Math.max(1, Math.round((source.width * height) / source.height)));
  let height = Math.min(Math.max(...sources.map((source) => source.height)), MAX_HEIGHT);
  let widths = widthsAt(height);
  let total = widths.reduce((sum, width) => sum + width, 0) + gaps;
  if (total > MAX_WIDTH) {
    height = Math.max(1, Math.floor((height * (MAX_WIDTH - gaps)) / (total - gaps)));
    widths = widthsAt(height);
    total = widths.reduce((sum, width) => sum + width, 0) + gaps;
  }

  let cursor = 0;
  const panels = widths.map((width) => {
    const panel = { left: cursor, width };
    cursor += width + GAP_PX;
    return panel;
  });
  const pieces = await Promise.all(sources.map(async (source, index) => {
    const { data, info } = await sharp(source.bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: widths[index]!, height, fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, info };
  }));
  const composites = pieces.map(({ data, info }, index) => ({
    input: data,
    raw: { width: info.width, height: info.height, channels: info.channels },
    left: panels[index]!.left,
    top: 0,
  }));

  const canvas = sharp({
    create: { width: total, height, channels: 3, background: GAP_COLOR },
  }).composite(composites);
  if (sources.every((source) => source.format === 'png')) {
    const png = await canvas.png().toBuffer();
    if (png.length <= PNG_LIMIT_BYTES) return { bytes: png, mime: 'image/png', panels };
    return { bytes: await sharp(png).jpeg({ quality: 92 }).toBuffer(), mime: 'image/jpeg', panels };
  }
  return { bytes: await canvas.jpeg({ quality: 92 }).toBuffer(), mime: 'image/jpeg', panels };
}

function assertMergeIds(receiptIds: string[]): void {
  if (
    receiptIds.length < MERGE_MIN ||
    receiptIds.length > MERGE_MAX ||
    new Set(receiptIds).size !== receiptIds.length
  ) {
    throw new Error('INVALID_MERGE');
  }
}

/** 取出要合并的来源凭证（按请求里的顺序），不满足条件就抛错。 */
function loadSources(store: Store, receiptIds: string[]): Receipt[] {
  const sources = receiptIds.map((id) => store.get('receipts', id));
  if (sources.some((source) => source === null)) {
    throw new Error('NOT_FOUND');
  }
  const found = sources as Receipt[];
  if (found.some((source) => source.status === 'recognizing' && source.deletedAt === null)) {
    throw new Error('MERGE_NOT_READY');
  }
  if (found.some((source) => !canMergeReceipt(source))) {
    throw new Error('MERGE_NOT_ALLOWED');
  }
  // 同一单的截图一定在同一个区里；两个区的凭证不能拼在一起
  if (new Set(found.map((source) => ledgerOf(source))).size > 1) {
    throw new Error('MERGE_MIXED_LEDGER');
  }
  return found;
}

async function readSourceImage(store: Store, config: Config, source: Receipt): Promise<Buffer> {
  const entry = store.get('files', source.original.id);
  if (
    entry === null ||
    entry.kind !== 'original' ||
    entry.ownerId !== source.id ||
    entry.path !== source.original.path ||
    entry.deletedAt !== null
  ) {
    throw new Error('MERGE_IMAGE_MISSING');
  }
  try {
    return await readVerifiedFile(config, entry);
  } catch {
    throw new Error('MERGE_IMAGE_MISSING');
  }
}

async function removeFileQuietly(config: Config, path: string): Promise<void> {
  try {
    await unlink(safePath(config.dataDir, path));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      // 残留一个文件不影响数据，记一笔就行
      logger.warn({ err: error, path }, '合并或拆开后清理图片文件失败');
    }
  }
}

/**
 * 把 2–3 张还没进报销单的凭证合并成一张：来源截图按给定顺序左右拼成新图，作为新凭证重新识别；
 * 来源凭证原样保留但隐藏（deletedAt + mergedInto），可以随时「拆开」。返回新凭证（识别中）。
 */
export async function mergeReceipts(
  store: Store,
  config: Config,
  receiptIds: string[],
  now: Date,
): Promise<Receipt> {
  assertMergeIds(receiptIds);
  const sources = loadSources(store, receiptIds);
  const inputs = await Promise.all(sources.map((source) => readSourceImage(store, config, source)));
  const stitched = await stitchImages(inputs);

  const first = sources.reduce((earliest, source) =>
    source.uploadOrder < earliest.uploadOrder ? source : earliest);
  const extension = stitched.mime === 'image/png' ? 'png' : 'jpg';
  const stored = await storeImage(config, first.month, 'originals', {
    name: `merged.${extension}`,
    mime: stitched.mime,
    bytes: stitched.bytes,
  });
  // 记下每张截图在拼图里的位置：对账时（尤其手机上）可以一张一张看，不用对着缩得很小的整张拼图
  const image: ImageRef = { ...stored, panels: stitched.panels };

  try {
    return store.transact(() => {
      // 拼图期间凭证可能已被改动（删除、进了报销单、换了图）：以事务里的最新状态为准重新核对
      const current = loadSources(store, receiptIds);
      current.forEach((source, index) => {
        if (source.original.id !== sources[index]!.original.id) {
          throw new Error('MERGE_NOT_ALLOWED');
        }
      });

      const merged: Receipt = {
        id: randomUUID(),
        // 合并出来的凭证和来源在同一个区（店内的不写这个字段）
        ...(ledgerOf(first) === 'company' ? { ledger: 'company' as const } : {}),
        original: image,
        refundImages: [],
        month: first.month,
        uploadedAt: current.reduce(
          (earliest, source) => (source.uploadedAt < earliest ? source.uploadedAt : earliest),
          first.uploadedAt,
        ),
        // 沿用最靠前的那张的上传顺序：合并后在列表里还在原来的位置
        uploadOrder: first.uploadOrder,
        analysis: null,
        recognizedFen: null,
        paidFen: null,
        refundFen: 0,
        category: null,
        merchant: null,
        date: null,
        status: 'recognizing',
        pendingReasons: [],
        duplicateIds: [],
        duplicateOverride: false,
        attempts: 0,
        nextAttemptAt: null,
        batchId: null,
        archivedAt: null,
        statusBeforeArchive: null,
        deletedAt: null,
        mergedFrom: receiptIds,
      };
      const fileIndex: FileIndexEntry = {
        id: image.id,
        ownerId: merged.id,
        kind: 'original',
        path: image.path,
        sha256: fileIndexSha256(image),
        deletedAt: null,
      };
      store.put('receipts', merged);
      store.put('files', fileIndex);
      const hiddenAt = now.toISOString();
      for (const source of current) {
        store.put('receipts', { ...source, deletedAt: hiddenAt, mergedInto: merged.id });
      }
      return merged;
    });
  } catch (error) {
    await removeFileQuietly(config, image.path);
    throw error;
  }
}

/**
 * 拆开合并出来的凭证：来源截图原样恢复（合并前是什么状态就是什么状态），合并后的凭证和拼出来的图删掉。
 * 已经进了报销单的合并凭证不能拆。返回恢复的来源凭证，按拼接顺序。
 */
export async function splitReceipt(store: Store, config: Config, id: string): Promise<Receipt[]> {
  const result = store.transact(() => {
    const merged = store.get('receipts', id);
    if (merged === null) {
      throw new Error('NOT_FOUND');
    }
    if (merged.mergedFrom === undefined) {
      throw new Error('NOT_MERGED');
    }
    assertMutable(merged);
    if (merged.refundFen > 0 || merged.refundImages.length > 0) {
      throw new Error('SPLIT_HAS_REFUND');
    }
    const sources = merged.mergedFrom.map((sourceId) => store.get('receipts', sourceId));
    if (sources.some((source) => source === null || source.mergedInto !== merged.id)) {
      throw new Error('SPLIT_SOURCES_MISSING');
    }
    const hidden = sources as Receipt[];
    if (hidden.some((source) => source.original.deletedAt !== null)) {
      throw new Error('ORIGINAL_CLEANED');
    }
    // 合并前的某张截图，之后又被传到了另一个区（那时它在这个区是隐藏的，不算重复）：不能同时在用
    if (hidden.some((source) => liveCopyInOtherLedger(store, source) !== null)) {
      throw new Error('LEDGER_DUPLICATE');
    }
    const restored = hidden.map((source) => {
      const back: Receipt = { ...source, deletedAt: null };
      delete back.mergedInto;
      return back;
    });
    for (const source of restored) {
      store.put('receipts', source);
    }
    store.remove('receipts', merged.id);
    store.remove('files', merged.original.id);
    return { restored, mergedPath: merged.original.path };
  });
  await removeFileQuietly(config, result.mergedPath);
  return result.restored;
}
