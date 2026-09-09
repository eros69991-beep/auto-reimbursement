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
import { safePath, storeImage, type InputImage } from './storage.js';

function localMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

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
  const month = localMonth(now);
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

      const result = store.transact(() => {
        const match = findDuplicates(store, original);
        if (match.exactId !== null) {
          return { receipt: null, duplicateId: match.exactId };
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
          sha256: original.sha256,
          deletedAt: null,
        };
        store.put('receipts', row);
        store.put('files', fileIndex);
        return { receipt: row, duplicateId: null };
      });
      if (result.receipt === null) {
        await unlink(safePath(config.dataDir, original.path));
        rejected.push({
          index,
          code: 'EXACT_DUPLICATE',
          duplicateId: result.duplicateId,
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

export function updateReceipt(
  store: Store,
  id: string,
  patch: { paidFen?: number; category?: Category },
): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('NOT_FOUND');
    }
    assertMutable(receipt);
    if (patch.paidFen !== undefined && !validFen(patch.paidFen)) {
      throw new Error('INVALID_PAID_FEN');
    }
    if (patch.category !== undefined && !CATEGORIES.includes(patch.category)) {
      throw new Error('INVALID_CATEGORY');
    }
    const updated: Receipt = {
      ...receipt,
      paidFen: patch.paidFen ?? receipt.paidFen,
      category: patch.category ?? receipt.category,
      status: 'pending',
    };
    store.put('receipts', updated);
    return updated;
  });
}

export function confirmReceipt(store: Store, id: string): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('NOT_FOUND');
    }
    assertMutable(receipt);
    const category = receipt.category;
    if (receipt.paidFen === null || category === null) {
      throw new Error('INCOMPLETE_RECEIPT');
    }
    if (!validFen(receipt.paidFen) || !CATEGORIES.includes(category)) {
      throw new Error('INCOMPLETE_RECEIPT');
    }
    if (receipt.duplicateIds.length > 0 && !receipt.duplicateOverride) {
      throw new Error('UNRESOLVED_DUPLICATE');
    }
    const confirmed: Receipt = {
      ...receipt,
      status: 'ready',
      pendingReasons: [],
      nextAttemptAt: null,
    };
    store.put('receipts', confirmed);
    recordCorrectionInTransaction(store, id, category);
    return confirmed;
  });
}

function assertMutable(receipt: Receipt): void {
  if (receipt.status === 'generated' || receipt.status === 'archived') {
    throw new Error('IMMUTABLE_RECEIPT');
  }
}

function validFen(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999
  );
}

export type { InputImage } from './storage.js';
