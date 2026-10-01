import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import {
  categoriesFor,
  ledgerOf,
  type Category,
  type FileIndexEntry,
  type Ledger,
  type Receipt,
  type UploadResult,
} from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { findDuplicates, liveCopyInOtherLedger } from './duplicates.js';
import { recordCorrectionInTransaction } from './learning.js';
import { fileIndexSha256, safePath, storeImage, type InputImage } from './storage.js';
import { businessMonth } from './time.js';

function rejectionCode(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return error.message === 'INVALID_IMAGE' || error.message === 'IMAGE_TOO_LARGE'
    ? error.message
    : null;
}

type DuplicateMatch = ReturnType<typeof findDuplicates>;

/**
 * 上传的图与已有凭证的原图完全一致时的拒绝原因：
 * 在用的凭证 → EXACT_DUPLICATE（另一个区里在用的也算，同一张图不能入两次账；那种情况带 duplicateLedger 说明在哪个区）；
 * 在回收站 → DELETED_DUPLICATE（P-32，前端提示可恢复；只看本区的回收站，另一个区回收站里的同一张不算）；
 * 已被合并隐藏的来源截图 → MERGED_DUPLICATE，duplicateId 是合并后那张凭证。
 */
function duplicateRejection(
  match: DuplicateMatch,
): {
  code: 'EXACT_DUPLICATE' | 'DELETED_DUPLICATE' | 'MERGED_DUPLICATE';
  duplicateId: string;
  duplicateLedger?: Ledger;
} | null {
  if (match.exactId !== null) {
    return match.exactOtherLedger === undefined
      ? { code: 'EXACT_DUPLICATE', duplicateId: match.exactId }
      : { code: 'EXACT_DUPLICATE', duplicateId: match.exactId, duplicateLedger: match.exactOtherLedger };
  }
  if (match.mergedIntoId !== null) return { code: 'MERGED_DUPLICATE', duplicateId: match.mergedIntoId };
  if (match.deletedExactId !== null) return { code: 'DELETED_DUPLICATE', duplicateId: match.deletedExactId };
  return null;
}

export async function uploadReceipts(
  store: Store,
  config: Config,
  files: InputImage[],
  now: Date,
  ledger: Ledger = 'store',
): Promise<UploadResult> {
  const accepted: Receipt[] = [];
  const rejected: UploadResult['rejected'] = [];
  const month = businessMonth(now);
  const uploadedAt = now.toISOString();

  for (const [index, file] of files.entries()) {
    let original;
    try {
      original = await storeImage(config, month, 'originals', file);
    } catch (error) {
      const code = rejectionCode(error);
      if (code !== null) {
        rejected.push({ index, code });
        continue;
      }
      throw error;
    }

    const receiptId = randomUUID();
    try {
      const initialRejection = duplicateRejection(findDuplicates(store, original, ledger));
      if (initialRejection !== null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({ index, ...initialRejection });
        continue;
      }

      const result = store.transact(() => {
        const match = findDuplicates(store, original, ledger);
        const rejection = duplicateRejection(match);
        if (rejection !== null) {
          return { receipt: null, rejection };
        }
        const row: Receipt = {
          id: receiptId,
          // 店内的凭证不写这个字段，存下来的数据和以前完全一样
          ...(ledger === 'company' ? { ledger } : {}),
          original,
          refundImages: [],
          month,
          uploadedAt,
          uploadOrder: store.nextOrder(),
          analysis: null,
          recognizedFen: null,
          paidFen: null,
          refundFen: 0,
          category: null,
          merchant: null,
          date: null,
          status: match.suspectedIds.length > 0 ? 'pending' : 'recognizing',
          pendingReasons:
            match.suspectedIds.length > 0 ? ['suspected_duplicate'] : [],
          duplicateIds: match.suspectedIds,
          duplicateOverride: false,
          attempts: 0,
          nextAttemptAt: null,
          batchId: null,
          archivedAt: null,
          statusBeforeArchive: null,
          deletedAt: null,
        };
        const fileIndex: FileIndexEntry = {
          id: original.id,
          ownerId: row.id,
          kind: 'original',
          path: original.path,
          // 索引记录落盘字节的哈希（去 EXIF 后），导出时按它校验
          sha256: fileIndexSha256(original),
          deletedAt: null,
        };
        store.put('receipts', row);
        store.put('files', fileIndex);
        return { receipt: row, rejection: null };
      });
      if (result.receipt === null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({ index, ...result.rejection });
      } else {
        accepted.push(result.receipt);
      }
    } catch (error) {
      try {
        await unlink(safePath(config.dataDir, original.path));
      } catch {
        // Preserve the database failure; cleanup is confined to this new path.
      }
      throw error;
    }
  }

  return { accepted, rejected };
}

// P-11：用户可修正商户（打印在报销单摘要栏）和日期（参与查重与对账）
export interface ReceiptPatch {
  paidFen?: number;
  category?: Category;
  merchant?: string;
  date?: string;
}

const MAX_MERCHANT_LENGTH = 50;

function assertValidPatch(patch: ReceiptPatch, ledger: Ledger): void {
  if (patch.paidFen !== undefined && !validFen(patch.paidFen)) {
    throw new Error('INVALID_PAID_FEN');
  }
  // 分类只能是凭证所在的区里的分类：公账凭证不能改成店内的分类，反过来也一样
  if (patch.category !== undefined && !categoriesFor(ledger).includes(patch.category)) {
    throw new Error('INVALID_CATEGORY');
  }
  if (patch.merchant !== undefined) {
    const trimmed = patch.merchant.trim();
    if (trimmed === '' || trimmed.length > MAX_MERCHANT_LENGTH) {
      throw new Error('INVALID_MERCHANT');
    }
  }
  if (patch.date !== undefined && !isCalendarDate(patch.date)) {
    throw new Error('INVALID_DATE');
  }
}

// YYYY-MM-DD 且必须是真实存在的日历日期（拒绝 2026-02-30）
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function applyPatch(receipt: Receipt, patch: ReceiptPatch): Receipt {
  const patched: Receipt = {
    ...receipt,
    paidFen: patch.paidFen ?? receipt.paidFen,
    category: patch.category ?? receipt.category,
    merchant: patch.merchant === undefined ? receipt.merchant : patch.merchant.trim(),
    date: patch.date ?? receipt.date,
  };
  // 人工改了分类，规则说明（按规则归类 / 规则建议）就不再适用
  if (patched.category !== receipt.category && receipt.ruleMatch) {
    patched.ruleMatch = null;
  }
  return patched;
}

export function updateReceipt(
  store: Store,
  id: string,
  patch: ReceiptPatch,
): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('NOT_FOUND');
    }
    assertMutable(receipt);
    assertValidPatch(patch, ledgerOf(receipt));
    if (patch.paidFen !== undefined && patch.paidFen < receipt.refundFen) {
      throw new Error('REFUND_EXCEEDS_PAID');
    }
    const updated: Receipt = {
      ...applyPatch(receipt, patch),
      status: 'pending',
    };
    store.put('receipts', updated);
    return updated;
  });
}

// P-10：修改与确认在同一个事务里完成，不再分两次请求；
// 这样确认失败时凭证不会停留在「pending 且无原因」的失踪状态。
export function confirmReceipt(
  store: Store,
  id: string,
  patch: ReceiptPatch = {},
): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('NOT_FOUND');
    }
    assertMutable(receipt);
    assertValidPatch(patch, ledgerOf(receipt));
    const merged = applyPatch(receipt, patch);
    const paidFen = merged.paidFen;
    const category = merged.category;
    if (paidFen === null || category === null) {
      throw new Error('INCOMPLETE_RECEIPT');
    }
    if (!validFen(paidFen) || !categoriesFor(ledgerOf(receipt)).includes(category)) {
      throw new Error('INCOMPLETE_RECEIPT');
    }
    if (receipt.refundFen > paidFen) {
      throw new Error('REFUND_EXCEEDS_PAID');
    }
    if (receipt.duplicateIds.length > 0 && !receipt.duplicateOverride) {
      throw new Error('UNRESOLVED_DUPLICATE');
    }
    const confirmed: Receipt = {
      ...merged,
      paidFen,
      category,
      status: 'ready',
      pendingReasons: [],
      nextAttemptAt: null,
    };
    // 人工确认即解决了规则冲突，建议不再保留
    if (confirmed.ruleMatch?.mode === 'suggested') {
      confirmed.ruleMatch = null;
    }
    store.put('receipts', confirmed);
    recordCorrectionInTransaction(store, id, category);
    return confirmed;
  });
}

export function listReceipts(
  store: Store,
  view: 'pool' | 'pending' | 'excluded' | 'deleted',
  ledger: Ledger = 'store',
): Receipt[] {
  return store
    .list('receipts')
    .filter((receipt) => {
      // 两个区互相看不到对方的凭证
      if (ledgerOf(receipt) !== ledger) return false;
      // 被合并隐藏的来源截图不算「已删除」：它们在合并后的那张上点「拆开」才会回来
      if (view === 'deleted') return receipt.deletedAt !== null && receipt.mergedInto === undefined;
      if (receipt.deletedAt !== null || receipt.archivedAt !== null) {
        return false;
      }
      if (view === 'excluded') return receipt.poolExcluded === true && receipt.batchId === null;
      return view === 'pool'
        ? receipt.status === 'ready' && receipt.batchId === null && !receipt.poolExcluded
        : receipt.status === 'pending' || receipt.status === 'recognizing';
    })
    .sort((left, right) => left.uploadOrder - right.uploadOrder);
}

export function deleteReceipt(store: Store, id: string, now: Date): void {
  store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('NOT_FOUND');
    }
    assertMutable(receipt);
    store.put('receipts', { ...receipt, deletedAt: now.toISOString() });
  });
}

export function assertMutable(receipt: Receipt): void {
  if (receipt.deletedAt !== null || receipt.batchId !== null || receipt.status === 'generated' || receipt.status === 'archived') {
    throw new Error('IMMUTABLE_RECEIPT');
  }
}

export function setPoolMembership(store: Store, id: string, included: boolean): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) throw new Error('NOT_FOUND');
    assertMutable(receipt);
    const updated = { ...receipt, poolExcluded: !included };
    store.put('receipts', updated);
    return updated;
  });
}

export function restoreReceipt(store: Store, id: string): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) throw new Error('NOT_FOUND');
    if (receipt.deletedAt === null) return receipt;
    if (receipt.original.deletedAt !== null) throw new Error('ORIGINAL_CLEANED');
    const restored: Receipt = { ...receipt, deletedAt: null };
    if (receipt.mergedInto !== undefined) {
      // 被合并隐藏的来源截图要在合并后的那张上「拆开」；那张已经不存在（数据异常）时才按普通凭证恢复
      if (store.get('receipts', receipt.mergedInto) !== null) throw new Error('MERGED_RECEIPT');
      delete restored.mergedInto;
    }
    // 先在这个区删除、又把同一张图传到了另一个区：另一个区那张在用，这张不能再恢复（同一张图不能入两次账）
    if (liveCopyInOtherLedger(store, receipt) !== null) {
      throw new Error('LEDGER_DUPLICATE');
    }
    assertMutable(restored);
    store.put('receipts', restored);
    return restored;
  });
}

function validFen(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999
  );
}

export type { InputImage } from './storage.js';
