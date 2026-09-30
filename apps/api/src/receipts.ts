import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import {
  CATEGORIES,
  type Category,
  type FileIndexEntry,
  type Receipt,
  type UploadResult,
} from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { findDuplicates } from './duplicates.js';
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

export async function uploadReceipts(
  store: Store,
  config: Config,
  files: InputImage[],
  now: Date,
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
      const initialMatch = findDuplicates(store, original);
      if (initialMatch.exactId !== null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({
          index,
          code: 'EXACT_DUPLICATE',
          duplicateId: initialMatch.exactId,
        });
        continue;
      }
      // P-32：原图与回收站中的凭证一致时给出单独错误码，前端提示可恢复
      if (initialMatch.deletedExactId !== null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({
          index,
          code: 'DELETED_DUPLICATE',
          duplicateId: initialMatch.deletedExactId,
        });
        continue;
      }

      const result = store.transact(() => {
        const match = findDuplicates(store, original);
        if (match.exactId !== null) {
          return { receipt: null, duplicateId: match.exactId, deletedDuplicateId: null };
        }
        if (match.deletedExactId !== null) {
          return { receipt: null, duplicateId: null, deletedDuplicateId: match.deletedExactId };
        }
        const row: Receipt = {
          id: receiptId,
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
        return { receipt: row, duplicateId: null, deletedDuplicateId: null };
      });
      if (result.receipt === null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({
          index,
          code: result.deletedDuplicateId !== null ? 'DELETED_DUPLICATE' : 'EXACT_DUPLICATE',
          duplicateId: (result.deletedDuplicateId ?? result.duplicateId) as string,
        });
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

function assertValidPatch(patch: ReceiptPatch): void {
  if (patch.paidFen !== undefined && !validFen(patch.paidFen)) {
    throw new Error('INVALID_PAID_FEN');
  }
  if (patch.category !== undefined && !CATEGORIES.includes(patch.category)) {
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
    assertValidPatch(patch);
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
    assertValidPatch(patch);
    const merged = applyPatch(receipt, patch);
    const paidFen = merged.paidFen;
    const category = merged.category;
    if (paidFen === null || category === null) {
      throw new Error('INCOMPLETE_RECEIPT');
    }
    if (!validFen(paidFen) || !CATEGORIES.includes(category)) {
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
): Receipt[] {
  return store
    .list('receipts')
    .filter((receipt) => {
      if (view === 'deleted') return receipt.deletedAt !== null;
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
    const restored = { ...receipt, deletedAt: null };
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
