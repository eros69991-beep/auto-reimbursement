import { unlink } from 'node:fs/promises';

import type { Batch, HistoryMonth, MaintenanceResult, Receipt } from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { safePath } from './storage.js';
import { readSavedBatchPdf } from './render/pdf.js';

type LinkedSet = { receipts: Receipt[]; batches: Batch[] };

export function archiveMonth(store: Store, month: string, now: Date): MaintenanceResult {
  const selected = linkedSet(store, month);
  if (selected.receipts.some((receipt) => receipt.status === 'recognizing' || receipt.status === 'pending') ||
      selected.batches.some((batch) => batch.pdfPath === null)) {
    throw new Error('MONTH_HAS_UNFINISHED_WORK');
  }
  const archivedAt = now.toISOString();
  store.transact(() => {
    for (const receipt of selected.receipts) {
      if (receipt.status !== 'archived') {
        store.put('receipts', { ...receipt, statusBeforeArchive: receipt.status, status: 'archived', archivedAt });
      }
    }
    for (const batch of selected.batches) store.put('batches', { ...batch, archivedAt });
  });
  return { affected: selected.receipts.length };
}

export function unarchiveMonth(store: Store, month: string): MaintenanceResult {
  const selected = linkedSet(store, month);
  store.transact(() => {
    for (const receipt of selected.receipts) {
      if (receipt.status === 'archived') {
        store.put('receipts', { ...receipt, status: receipt.statusBeforeArchive ?? 'ready', statusBeforeArchive: null, archivedAt: null });
      }
    }
    for (const batch of selected.batches) store.put('batches', { ...batch, archivedAt: null });
  });
  return { affected: selected.receipts.length };
}

export async function cleanOriginals(store: Store, config: Config, month: string, confirmation: string): Promise<MaintenanceResult> {
  if (confirmation !== `DELETE ORIGINALS ${month}`) throw new Error('INVALID_CLEANUP_CONFIRMATION');
  const selected = linkedSet(store, month);
  if (selected.receipts.length === 0 || selected.receipts.some((receipt) => receipt.status !== 'archived' || receipt.batchId === null) ||
      selected.batches.some((batch) => batch.pdfPath === null)) throw new Error('CLEANUP_NOT_ALLOWED');
  try {
    await Promise.all(selected.batches.map((batch) => readSavedBatchPdf(store, config, batch)));
  } catch {
    throw new Error('CLEANUP_NOT_ALLOWED');
  }
  let affected = 0;
  for (const receipt of selected.receipts) {
    const file = store.get('files', receipt.original.id);
    if (file === null || file.kind !== 'original' || file.ownerId !== receipt.id || file.path !== receipt.original.path) {
      throw cleanupFailure(affected, receipt.id);
    }
    if (file.deletedAt !== null) continue;
    try {
      await unlink(safePath(config.dataDir, file.path));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw cleanupFailure(affected, receipt.id);
    }
    const deletedAt = new Date().toISOString();
    store.transact(() => {
      const current = store.get('receipts', receipt.id);
      const entry = store.get('files', file.id);
      if (current === null || entry === null || entry.kind !== 'original' || entry.ownerId !== current.id || entry.path !== current.original.path) throw cleanupFailure(affected, receipt.id);
      store.put('files', { ...entry, deletedAt });
      store.put('receipts', { ...current, original: { ...current.original, deletedAt } });
      for (const batch of store.list('batches')) {
        if (!batch.items.some((item) => item.receiptId === receipt.id && item.original.id === file.id)) continue;
        store.put('batches', { ...batch, items: batch.items.map((item) => item.receiptId === receipt.id && item.original.id === file.id ? { ...item, original: { ...item.original, deletedAt } } : item) });
      }
    });
    affected += 1;
  }
  return { affected };
}

function cleanupFailure(affected: number, id: string): Error {
  return new Error(`CLEANUP_FAILED:${affected}:${/^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : 'unknown'}`);
}

export function history(store: Store): HistoryMonth[] {
  const grouped = new Map<string, Batch[]>();
  for (const batch of store.list('batches')) {
    const month = batch.month;
    grouped.set(month, [...(grouped.get(month) ?? []), batch]);
  }
  return [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, batches]) => ({ month, batches: batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
}

function linkedSet(store: Store, month: string): LinkedSet {
  const receipts = store.list('receipts').filter((receipt) => receipt.deletedAt === null);
  const batches = store.list('batches').filter((batch) => !batch.cancelledAt);
  const receiptIds = new Set(receipts
    .filter((receipt) => receipt.month === month)
    .map((receipt) => receipt.id));
  const batchIds = new Set(batches
    .filter((batch) => batch.month === month)
    .map((batch) => batch.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const receipt of receipts) {
      if (receiptIds.has(receipt.id) && receipt.batchId !== null && !batchIds.has(receipt.batchId)) { batchIds.add(receipt.batchId); changed = true; }
      if (receipt.batchId !== null && batchIds.has(receipt.batchId) && !receiptIds.has(receipt.id)) { receiptIds.add(receipt.id); changed = true; }
    }
    for (const batch of batches) {
      if (batchIds.has(batch.id)) for (const item of batch.items) if (!receiptIds.has(item.receiptId)) { receiptIds.add(item.receiptId); changed = true; }
    }
  }
  return { receipts: receipts.filter((receipt) => receiptIds.has(receipt.id)), batches: batches.filter((batch) => batchIds.has(batch.id)) };
}
