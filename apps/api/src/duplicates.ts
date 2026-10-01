import { createHash } from 'node:crypto';

import { ledgerOf, type ImageRef, type Ledger, type Receipt } from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import type { Store } from './db.js';

const MAX_IMAGE_PIXELS = 40_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DHASH_PATTERN = /^[0-9a-f]{16}$/i;

export async function fingerprint(
  bytes: Buffer,
): Promise<{ sha256: string; perceptualHash: string }> {
  const pixels = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      hash <<= 1n;
      const offset = row * 9 + column;
      if (pixels[offset]! > pixels[offset + 1]!) {
        hash |= 1n;
      }
    }
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    perceptualHash: hash.toString(16).padStart(16, '0'),
  };
}

/**
 * 新上传的图和已有凭证的重复情况。ledger 是这张图要进的区。
 * - 完全一样的图：在用的凭证不分区都算重复（同一张图不能入两次账），在另一个区时 exactOtherLedger 说明它在哪个区；
 *   回收站里的、被合并隐藏的，只看本区——传错区、在错的区删掉之后，要能在对的区重新传。
 * - 相似的图（疑似重复）：只和本区的比。公账区不做这一步：银行电子回单模板完全一样，
 *   相似度判断会把不同的回单当成重复；公账凭证识别之后仍会按金额、日期、收款方再判断一次（refineDuplicates）。
 */
export function findDuplicates(
  store: Store,
  image: ImageRef,
  ledger: Ledger = 'store',
): {
  exactId: string | null;
  /** exactId 那张凭证在另一个区时，它所在的区；在本区（或没有重复）时没有这一项 */
  exactOtherLedger?: Ledger;
  deletedExactId: string | null;
  /** 与某张已被合并隐藏的来源截图一致：返回合并后那张凭证的 id */
  mergedIntoId: string | null;
  suspectedIds: string[];
} {
  const exactCandidates: Receipt[] = [];
  // P-32：已删除（回收站）的精确重复单独返回，让前端提示「可从回收站恢复」；
  // 疑似重复则完全跳过已删除凭证，避免误报
  const deletedExactCandidates: string[] = [];
  const mergedCandidates: string[] = [];
  const suspectedIds: string[] = [];
  for (const receipt of orderedReceipts(store)) {
    if (receipt.original.id === image.id) {
      continue;
    }
    const sameLedger = ledgerOf(receipt) === ledger;
    if (
      validSha256(image.sha256) &&
      validSha256(receipt.original.sha256) &&
      receipt.original.sha256.toLowerCase() === image.sha256.toLowerCase()
    ) {
      if (receipt.deletedAt === null) {
        exactCandidates.push(receipt);
      } else if (!sameLedger) {
        // 另一个区回收站里的同一张：不算重复
      } else if (receipt.mergedInto !== undefined) {
        // 被合并隐藏的来源截图：指向合并后的那张凭证。那张已删除（在回收站）时按回收站里的重复处理，
        // 恢复的就是合并后的凭证；找不到它（数据异常）时退回到这张来源本身
        const target = store.get('receipts', receipt.mergedInto);
        if (target === null) {
          deletedExactCandidates.push(receipt.id);
        } else if (target.deletedAt === null) {
          mergedCandidates.push(target.id);
        } else {
          deletedExactCandidates.push(target.id);
        }
      } else {
        deletedExactCandidates.push(receipt.id);
      }
      continue;
    }
    if (
      sameLedger &&
      ledger !== 'company' &&
      receipt.deletedAt === null &&
      validDhash(image.perceptualHash) &&
      validDhash(receipt.original.perceptualHash) &&
      distance(image.perceptualHash, receipt.original.perceptualHash) <= 5
    ) {
      suspectedIds.push(receipt.id);
    }
  }
  // 本区和另一个区都有同一张时，指给本区的那张（用户在当前页面里能看到、能处理的）
  const exact = exactCandidates.find((candidate) => ledgerOf(candidate) === ledger) ?? exactCandidates[0];
  return {
    exactId: exact?.id ?? null,
    ...(exact !== undefined && ledgerOf(exact) !== ledger ? { exactOtherLedger: ledgerOf(exact) } : {}),
    deletedExactId: deletedExactCandidates[0] ?? null,
    mergedIntoId: mergedCandidates[0] ?? null,
    suspectedIds,
  };
}

/**
 * 这张凭证的图，在另一个区里有没有一张「在用」的同一张。
 * 恢复回收站里的凭证、拆开合并的凭证，都会让它重新在用；这时另一个区已经传了同一张图的话，
 * 不能让它们同时在用（同一张图不能入两次账）。同一个区里不会出现这种情况：上传时已经拦下了。
 */
export function liveCopyInOtherLedger(store: Store, receipt: Receipt): Receipt | null {
  if (!validSha256(receipt.original.sha256)) {
    return null;
  }
  const sha = receipt.original.sha256.toLowerCase();
  return (
    store
      .list('receipts')
      .find(
        (other) =>
          other.id !== receipt.id &&
          other.deletedAt === null &&
          ledgerOf(other) !== ledgerOf(receipt) &&
          validSha256(other.original.sha256) &&
          other.original.sha256.toLowerCase() === sha,
      ) ?? null
  );
}

export function refineDuplicates(store: Store, receipt: Receipt): string[] {
  if (
    receipt.duplicateOverride ||
    receipt.paidFen === null ||
    receipt.date === null ||
    !validDhash(receipt.original.perceptualHash)
  ) {
    return [];
  }
  const merchant = normalizeMerchant(receipt.merchant);
  if (merchant === '') {
    return [];
  }

  return orderedReceipts(store)
    .filter((candidate) => {
      if (
        candidate.id === receipt.id ||
        ledgerOf(candidate) !== ledgerOf(receipt) ||
        candidate.deletedAt !== null ||
        candidate.paidFen !== receipt.paidFen ||
        candidate.date === null ||
        candidate.date !== receipt.date ||
        normalizeMerchant(candidate.merchant) !== merchant ||
        !validDhash(candidate.original.perceptualHash)
      ) {
        return false;
      }
      return (
        distance(
          receipt.original.perceptualHash,
          candidate.original.perceptualHash,
        ) <= 10
      );
    })
    .map((candidate) => candidate.id);
}

export function confirmDistinct(store: Store, id: string): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('RECEIPT_NOT_FOUND');
    }
    if (receipt.status === 'generated' || receipt.status === 'archived') {
      throw new Error('IMMUTABLE_RECEIPT');
    }
    const pendingReasons = receipt.pendingReasons.filter(
      (reason) => reason !== 'suspected_duplicate',
    );
    const updated: Receipt = {
      ...receipt,
      status: receipt.analysis === null
        ? 'recognizing'
        : pendingReasons.length === 0 ? 'ready' : 'pending',
      pendingReasons,
      duplicateIds: [],
      duplicateOverride: true,
    };
    store.put('receipts', updated);
    return updated;
  });
}

function orderedReceipts(store: Store): Receipt[] {
  return store.list('receipts').sort((left, right) => {
    const order = left.uploadOrder - right.uploadOrder;
    if (order !== 0) {
      return order;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function validSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function validDhash(value: string): boolean {
  return DHASH_PATTERN.test(value);
}

function distance(left: string, right: string): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function normalizeMerchant(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
