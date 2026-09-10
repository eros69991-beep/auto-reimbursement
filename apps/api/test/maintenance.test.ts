import { describe, expect, it } from 'vitest';

import { archiveMonth, cleanOriginals, unarchiveMonth } from '../src/archive.js';
import { openStore } from '../src/db.js';
import { findDuplicates } from '../src/duplicates.js';
import { sampleReceipt } from './support.js';

describe('maintenance', () => {
  it('archives without losing duplicate evidence or financial history', () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt());

    expect(archiveMonth(store, '2026-09', new Date()).affected).toBe(1);
    expect(store.get('receipts', 'receipt-1')?.status).toBe('archived');
    expect(findDuplicates(store, { ...store.get('receipts', 'receipt-1')!.original, id: 'candidate-image' }).exactId)
      .toBe('receipt-1');

    unarchiveMonth(store, '2026-09');
    expect(store.get('receipts', 'receipt-1')?.status).toBe('ready');
    store.close();
  });

  it('rejects unfinished work without changing linked rows', () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt({ status: 'pending' }));
    expect(() => archiveMonth(store, '2026-09', new Date())).toThrow('MONTH_HAS_UNFINISHED_WORK');
    expect(store.get('receipts', 'receipt-1')?.status).toBe('pending');
    store.close();
  });

  it('requires an exported batch and exact phrase before deleting originals', async () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt({ status: 'archived', archivedAt: '2026-09-04T00:00:00.000Z' }));
    await expect(cleanOriginals(store, { dataDir: process.cwd(), dbPath: ':memory:', host: '127.0.0.1', port: 3000, ai: null, concurrency: 4 }, '2026-09', 'DELETE ORIGINALS 2026-08')).rejects.toThrow('INVALID_CLEANUP_CONFIRMATION');
    await expect(cleanOriginals(store, { dataDir: process.cwd(), dbPath: ':memory:', host: '127.0.0.1', port: 3000, ai: null, concurrency: 4 }, '2026-09', 'DELETE ORIGINALS 2026-09')).rejects.toThrow('CLEANUP_NOT_ALLOWED');
    expect(store.get('receipts', 'receipt-1')?.original.deletedAt).toBeNull();
    store.close();
  });

  it('denies cleanup when an exported path lacks a live indexed PDF', async () => {
    const store = openStore(':memory:');
    const receipt = sampleReceipt({ status: 'archived', archivedAt: '2026-09-04T00:00:00.000Z', batchId: 'batch-1' });
    store.put('receipts', receipt);
    store.put('batches', { id: 'batch-1', month: '2026-09', createdAt: '2026-09-04T00:00:00.000Z', totalFen: 1000, items: [{ receiptId: receipt.id, uploadOrder: receipt.uploadOrder, category: '耗材', paidFen: 1000, refundFen: 0, netFen: 1000, original: receipt.original, refundImages: [] }], sheets: [], options: { department: '', date: null, signerMode: 'text', signerName: '', signature: null }, notes: [], pdfPath: '2026-09/exports/missing.pdf', archivedAt: receipt.archivedAt });
    await expect(cleanOriginals(store, { dataDir: process.cwd(), dbPath: ':memory:', host: '127.0.0.1', port: 3000, ai: null, concurrency: 4 }, '2026-09', 'DELETE ORIGINALS 2026-09')).rejects.toThrow('CLEANUP_NOT_ALLOWED');
    expect(store.get('receipts', receipt.id)?.original.deletedAt).toBeNull();
    store.close();
  });
});
