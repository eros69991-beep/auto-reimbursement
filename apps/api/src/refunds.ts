import { unlink } from 'node:fs/promises';

import {
  netFenOrNull,
  type FileIndexEntry,
  type Receipt,
} from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { assertMutable } from './receipts.js';
import { fileIndexSha256, safePath, storeImage, type InputImage } from './storage.js';

export function setRefund(
  store: Store,
  id: string,
  refundFen: number,
): Receipt {
  return store.transact(() => {
    const receipt = requiredMutableReceipt(store, id);
    if (
      receipt.paidFen === null ||
      !Number.isSafeInteger(refundFen) ||
      refundFen < 0 ||
      refundFen > receipt.paidFen
    ) {
      throw new Error('INVALID_REFUND');
    }
    const updated: Receipt = { ...receipt, refundFen };
    store.put('receipts', updated);
    return updated;
  });
}

export async function addRefundImage(
  store: Store,
  config: Config,
  id: string,
  input: InputImage,
): Promise<Receipt> {
  const receipt = requiredMutableReceipt(store, id);
  const image = await storeImage(config, receipt.month, 'refunds', input);

  try {
    return store.transact(() => {
      const current = requiredMutableReceipt(store, id);
      const updated: Receipt = {
        ...current,
        refundImages: [...current.refundImages, image],
      };
      const fileIndex: FileIndexEntry = {
        id: image.id,
        ownerId: current.id,
        kind: 'refund',
        path: image.path,
        // 索引记录落盘字节的哈希（去 EXIF 后），导出时按它校验
        sha256: fileIndexSha256(image),
        deletedAt: null,
      };
      store.put('receipts', updated);
      store.put('files', fileIndex);
      return updated;
    });
  } catch (error) {
    try {
      await unlink(safePath(config.dataDir, image.path));
    } catch {
      // Keep the persistence error; this path belongs only to this upload.
    }
    throw error;
  }
}

export function isEligible(receipt: Receipt): boolean {
  // 防御式：单条脏数据（如历史遗留的退款大于实付）只影响自己，不能拖垮整个接口
  const net = netFenOrNull(receipt);
  if (receipt.paidFen !== null && net === null) {
    console.warn(`[data] receipt ${receipt.id} 退款大于实付，视为不可报销，请修正数据`);
  }
  return (
    receipt.status === 'ready' &&
    !receipt.poolExcluded &&
    !receipt.deletedAt &&
    !receipt.archivedAt &&
    !receipt.batchId &&
    receipt.category !== null &&
    receipt.paidFen !== null &&
    net !== null &&
    net > 0
  );
}

function requiredMutableReceipt(store: Store, id: string): Receipt {
  const receipt = store.get('receipts', id);
  if (receipt === null) {
    throw new Error('NOT_FOUND');
  }
  assertMutable(receipt);
  return receipt;
}
