import { randomUUID } from 'node:crypto';

import {
  CATEGORIES,
  formatFen,
  netFen,
  type Batch,
  type Category,
  type FormOptions,
  type FormSheet,
  type Receipt,
  type Totals,
} from '@auto-reimbursement/contracts';

import type { Store } from './db.js';
import {
  groupItems,
  moveGroup,
  packGroups,
  sheetFits,
  type LayoutMetrics,
} from './render/layout.js';
import { createFormDocument, formMetrics } from './render/form.js';
import { isEligible } from './refunds.js';
import { getSettings, validateNote } from './settings.js';

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
      merchant: receipt.merchant ?? null,
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
    const sheets = withPdfMetrics((metrics) => packGroups(groupItems(items), metrics));
    const batch: Batch = {
      id: randomUUID(),
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      createdAt: now.toISOString(),
      totalFen,
      items,
      sheets,
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

export function moveBatchGroup(
  store: Store,
  id: string,
  category: Category,
  direction: -1 | 1,
): Batch {
  const batch = getBatch(store, id);
  assertDraft(batch);
  return updateBatchLayout(
    store,
    id,
    withPdfMetrics((metrics) => moveGroup(batch.sheets, category, direction, metrics)),
  );
}

export function updateBatchLayout(
  store: Store,
  id: string,
  sheets: FormSheet[],
): Batch {
  return store.transact(() => {
    const batch = getBatch(store, id);
    assertDraft(batch);
    assertLayout(batch, sheets);
    const updated: Batch = { ...batch, sheets: structuredClone(sheets) };
    store.put('batches', updated);
    return updated;
  });
}

export function updateBatchOptions(
  store: Store,
  id: string,
  options: FormOptions,
  noteBySheet: Record<string, string | null>,
): Batch {
  return store.transact(() => {
    const batch = getBatch(store, id);
    assertDraft(batch);
    if (
      noteBySheet === null ||
      typeof noteBySheet !== 'object' ||
      Array.isArray(noteBySheet) ||
      !hasExactKeys(noteBySheet, batch.sheets.map((sheet) => sheet.id))
    ) {
      throw new Error('INVALID_NOTE_BY_SHEET');
    }
    const validNoteIds = new Set(batch.notes.map((note) => note.id));
    const sheets = batch.sheets.map((sheet) => {
      const noteId = noteBySheet[sheet.id];
      if (noteId !== null && (typeof noteId !== 'string' || !validNoteIds.has(noteId))) {
        throw new Error('INVALID_NOTE_BY_SHEET');
      }
      return { ...sheet, noteId };
    });
    const updated: Batch = {
      ...batch,
      options: canonicalOptions(store, options),
      sheets,
    };
    store.put('batches', updated);
    return updated;
  });
}

// 批次内备注：只改当前批次的快照（batch.notes），不触碰全局模板，
// 因此 A/B 批次与设置页模板天然隔离。定稿后随 BATCH_FINALIZED 锁定。
export function createBatchNote(
  store: Store,
  id: string,
  input: { name: unknown; content: unknown },
): Batch {
  return store.transact(() => {
    const batch = getBatch(store, id);
    assertDraft(batch);
    const note = {
      id: randomUUID(),
      name: input.name,
      content: input.content,
    } as Parameters<typeof validateNote>[0];
    validateNote(note);
    const updated: Batch = { ...batch, notes: [...batch.notes, note] };
    store.put('batches', updated);
    return updated;
  });
}

export function updateBatchNote(
  store: Store,
  id: string,
  noteId: string,
  input: { name?: unknown; content: unknown },
): Batch {
  return store.transact(() => {
    const batch = getBatch(store, id);
    assertDraft(batch);
    const existing = batch.notes.find((note) => note.id === noteId);
    if (existing === undefined) {
      throw new Error('NOTE_NOT_FOUND');
    }
    const note = {
      id: noteId,
      name: input.name === undefined ? existing.name : input.name,
      content: input.content,
    } as Parameters<typeof validateNote>[0];
    validateNote(note);
    const updated: Batch = {
      ...batch,
      notes: batch.notes.map((item) => (item.id === noteId ? note : item)),
    };
    store.put('batches', updated);
    return updated;
  });
}

function addFen(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new Error('INVALID_AMOUNT');
  }
  formatFen(result);
  return result;
}

function withPdfMetrics<T>(operation: (metrics: LayoutMetrics) => T): T {
  const doc = createFormDocument();
  try {
    return operation(formMetrics(doc));
  } finally {
    doc.destroy();
  }
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
  if (
    value.signature === null ||
    typeof value.signature !== 'object' ||
    Array.isArray(value.signature) ||
    typeof value.signature.id !== 'string' ||
    value.signature.id.length === 0
  ) {
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

function assertLayout(batch: Batch, sheets: FormSheet[]): void {
  withPdfMetrics((metrics) => assertLayoutWithMetrics(batch, sheets, metrics));
}

function assertLayoutWithMetrics(
  batch: Batch,
  sheets: FormSheet[],
  metrics: LayoutMetrics,
): void {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('INVALID_LAYOUT');
  }
  const expected = new Map(
    groupItems(batch.items).map((group) => [group.category, group]),
  );
  const existingNotes = new Map(batch.sheets.map((sheet) => [sheet.id, sheet.noteId]));
  const seenSheetIds = new Set<string>();
  const seenCategories = new Set<Category>();
  for (const [index, sheet] of sheets.entries()) {
    if (
      sheet === null ||
      typeof sheet !== 'object' ||
      typeof sheet.id !== 'string' ||
      sheet.id.length === 0 ||
      seenSheetIds.has(sheet.id) ||
      !Array.isArray(sheet.groups) ||
      sheet.groups.length === 0 ||
      !sheet.groups.every(isFormGroup) ||
      (sheet.noteId !== null && typeof sheet.noteId !== 'string')
    ) {
      throw new Error('INVALID_LAYOUT');
    }
    seenSheetIds.add(sheet.id);
    const priorNote = existingNotes.get(sheet.id);
    if (priorNote !== undefined && priorNote !== sheet.noteId) {
      throw new Error('INVALID_LAYOUT');
    }
    if (
      priorNote === undefined &&
      (sheet.id !== nextSheetId(batch.sheets) || index !== sheets.length - 1 || sheet.noteId !== null)
    ) {
      throw new Error('INVALID_LAYOUT');
    }
    if (!sheetFits(sheet.groups, metrics)) {
      throw new Error('CATEGORY_TOO_LARGE');
    }
    for (const group of sheet.groups) {
      const original = expected.get(group.category);
      if (original === undefined || seenCategories.has(group.category) || !sameGroup(group, original)) {
        throw new Error('INVALID_LAYOUT');
      }
      seenCategories.add(group.category);
    }
  }
  if (seenCategories.size !== expected.size) {
    throw new Error('INVALID_LAYOUT');
  }
}

function sameGroup(left: FormSheet['groups'][number], right: FormSheet['groups'][number]): boolean {
  return (
    left.totalFen === right.totalFen &&
    left.receiptIds.length === right.receiptIds.length &&
    left.amountsFen.length === right.amountsFen.length &&
    left.receiptIds.every((id, index) => id === right.receiptIds[index]) &&
    left.amountsFen.every((amount, index) => amount === right.amountsFen[index])
  );
}

function isFormGroup(value: unknown): value is FormSheet['groups'][number] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const group = value as Record<string, unknown>;
  return (
    typeof group.category === 'string' &&
    typeof group.totalFen === 'number' &&
    Number.isSafeInteger(group.totalFen) &&
    Array.isArray(group.receiptIds) &&
    group.receiptIds.every((id) => typeof id === 'string') &&
    Array.isArray(group.amountsFen) &&
    group.amountsFen.every((amount) => typeof amount === 'number' && Number.isSafeInteger(amount))
  );
}

function nextSheetId(sheets: FormSheet[]): string {
  const largest = sheets.reduce((largestId, sheet) => {
    const match = /^sheet-(\d+)$/.exec(sheet.id);
    return match === null ? largestId : Math.max(largestId, Number(match[1]));
  }, 0);
  return `sheet-${String(largest + 1).padStart(3, '0')}`;
}

function assertDraft(batch: Batch): void {
  assertActiveBatch(batch);
  if (batch.pdfPath !== null) {
    throw new Error('BATCH_FINALIZED');
  }
}

export function assertActiveBatch(batch: Batch): void {
  if (batch.cancelledAt) throw new Error('BATCH_CANCELLED');
}

export function cancelBatch(store: Store, id: string, now: Date): Batch {
  return store.transact(() => {
    const batch = getBatch(store, id);
    if (batch.cancelledAt) return batch;
    const receipts = batch.items.map((item) => store.get('receipts', item.receiptId));
    if (receipts.some((receipt) => receipt === null || receipt.batchId !== id || receipt.deletedAt !== null)) {
      throw new Error('BATCH_RECEIPT_CONFLICT');
    }
    if (receipts.some((receipt) => receipt!.original.deletedAt !== null)) throw new Error('ORIGINAL_CLEANED');
    for (const receipt of receipts) {
      store.put('receipts', { ...receipt!, status: 'ready', batchId: null, archivedAt: null, statusBeforeArchive: null, poolExcluded: false });
    }
    const cancelled = { ...batch, cancelledAt: now.toISOString() };
    store.put('batches', cancelled);
    return cancelled;
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
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
