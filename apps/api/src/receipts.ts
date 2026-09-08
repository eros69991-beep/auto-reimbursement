import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import type {
  FileIndexEntry,
  Receipt,
  UploadResult,
} from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
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
      const receipt = store.transact(() => {
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
        return row;
      });
      accepted.push(receipt);
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

export type { InputImage } from './storage.js';
