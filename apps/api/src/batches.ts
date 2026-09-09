import { randomUUID } from 'node:crypto';

import {
  CATEGORIES,
  formatFen,
  netFen,
  type Batch,
  type FormOptions,
  type Receipt,
  type Totals,
} from '@auto-reimbursement/contracts';

import type { Store } from './db.js';
import { isEligible } from './refunds.js';
import { getSettings } from './settings.js';

export function poolTotals(receipts: Receipt[]): Totals {
  const byCategory = Object.fromEntries(
    CATEGORIES.map((category) => [category, 0]),
  ) as Totals['byCategory'];
  let totalFen = 0;
  let count = 0;
  for (const receipt of receipts) {
    if (!isEligible(receipt)) {
      continue;
    }
    const value = netFen(receipt);
    totalFen = addFen(totalFen, value);
    byCategory[receipt.category!] = addFen(byCategory[receipt.category!], value);
    count += 1;
  }
  return { count, totalFen, byCategory };
}

export function createBatch(
  store: Store,
  ids: string[],
  options: FormOptions,
  now: Date,
): Batch {
  return store.transact(() => {
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error('INVALID_SELECTION');
    }
    const rows = ids.map((id) => store.get('receipts', id));
    if (rows.some((row) => row === null || !isEligible(row))) {
      throw new Error('NOT_ELIGIBLE');
    }
    const selected = (rows as Receipt[]).sort(
      (left, right) => left.uploadOrder - right.uploadOrder,
    );
    const items = selected.map((receipt) => ({
      receiptId: receipt.id,
      uploadOrder: receipt.uploadOrder,
      category: receipt.category!,
      paidFen: receipt.paidFen!,
      refundFen: receipt.refundFen,
      netFen: netFen(receipt),
      original: structuredClone(receipt.original),
      refundImages: structuredClone(receipt.refundImages),
    }));
    const totalFen = items.reduce(
      (total, item) => addFen(total, item.netFen),
      0,
    );
    const batch: Batch = {
      id: randomUUID(),
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      createdAt: now.toISOString(),
      totalFen,
      items,
      sheets: [],
      options: canonicalOptions(store, options),
      notes: structuredClone(store.list('notes')),
      pdfPath: null,
      archivedAt: null,
    };
    store.put('batches', batch);
    for (const receipt of selected) {
      store.put('receipts', {
        ...receipt,
        status: 'generated',
        batchId: batch.id,
      });
    }
    return batch;
  });
}

export function getBatch(store: Store, id: string): Batch {
  const batch = store.get('batches', id);
  if (batch === null) {
    throw new Error('BATCH_NOT_FOUND');
  }
  return batch;
}

function addFen(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new Error('INVALID_AMOUNT');
  }
  formatFen(result);
  return result;
}

function canonicalOptions(store: Store, value: FormOptions): FormOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.department !== 'string' ||
    value.department.length > 100 ||
    (value.date !== null &&
      (typeof value.date !== 'string' || !isCalendarDate(value.date))) ||
    (value.signerMode !== 'text' && value.signerMode !== 'image') ||
    typeof value.signerName !== 'string' ||
    value.signerName.length > 100
  ) {
    throw new Error('INVALID_OPTIONS');
  }
  if (value.signerMode === 'text') {
    return {
      department: value.department,
      date: value.date,
      signerMode: 'text',
      signerName: value.signerName,
      signature: null,
    };
  }
  if (value.signature === null || typeof value.signature !== 'object') {
    throw new Error('INVALID_SIGNATURE');
  }
  const signature = getSettings(store).signature;
  const entry = store.get('files', value.signature.id);
  if (
    signature === null ||
    signature.id !== value.signature.id ||
    entry === null ||
    entry.kind !== 'signature' ||
    entry.ownerId !== 'default' ||
    entry.deletedAt !== null ||
    entry.path !== signature.path ||
    entry.sha256 !== signature.sha256
  ) {
    throw new Error('INVALID_SIGNATURE');
  }
  return {
    department: value.department,
    date: value.date,
    signerMode: 'image',
    signerName: value.signerName,
    signature: structuredClone(signature),
  };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
