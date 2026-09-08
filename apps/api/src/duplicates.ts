import { createHash } from 'node:crypto';

import type { ImageRef, Receipt } from '@auto-reimbursement/contracts';
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

export function findDuplicates(
  store: Store,
  image: ImageRef,
): { exactId: string | null; suspectedIds: string[] } {
  const exactCandidates: string[] = [];
  const suspectedIds: string[] = [];
  for (const receipt of orderedReceipts(store)) {
    if (receipt.original.id === image.id) {
      continue;
    }
    if (
      validSha256(image.sha256) &&
      validSha256(receipt.original.sha256) &&
      receipt.original.sha256.toLowerCase() === image.sha256.toLowerCase()
    ) {
      exactCandidates.push(receipt.id);
      continue;
    }
    if (
      validDhash(image.perceptualHash) &&
      validDhash(receipt.original.perceptualHash) &&
      distance(image.perceptualHash, receipt.original.perceptualHash) <= 5
    ) {
      suspectedIds.push(receipt.id);
    }
  }
  return { exactId: exactCandidates[0] ?? null, suspectedIds };
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
    const updated: Receipt = {
      ...receipt,
      status: receipt.analysis === null ? 'recognizing' : receipt.status,
      pendingReasons: receipt.pendingReasons.filter(
        (reason) => reason !== 'suspected_duplicate',
      ),
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
