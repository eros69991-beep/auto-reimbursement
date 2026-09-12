import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { archiveMonth, cleanOriginals, history, unarchiveMonth } from '../src/archive.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { findDuplicates } from '../src/duplicates.js';
import { safePath } from '../src/storage.js';
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

  it.each(['2026-07', '2026-08'])(
    'selects a July upload in an August batch by either linked month (%s)',
    async (selectedMonth) => {
    const temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-local-month-'));
    const store = openStore(':memory:');
    const config = loadConfig({ DATA_DIR: temp }, temp);
    const originalBytes = Buffer.from('original receipt bytes');
    const pdfBytes = Buffer.from('%PDF-1.7 saved batch');
    const receipt = sampleReceipt({
      id: 'cross-month-receipt',
      month: '2026-07',
      status: 'generated',
      batchId: 'cross-month-batch',
      original: {
        ...sampleReceipt().original,
        id: 'cross-month-image',
        path: '2026-07/originals/cross-month-image.png',
        sha256: createHash('sha256').update(originalBytes).digest('hex'),
        bytes: originalBytes.length,
      },
    });
    const pdfPath = '2026-08/exports/cross-month.pdf';
    const batch = {
      id: 'cross-month-batch',
      month: '2026-08',
      createdAt: '2026-09-01T00:30:00.000Z',
      totalFen: 1000,
      items: [{
        receiptId: receipt.id,
        uploadOrder: receipt.uploadOrder,
        category: '耗材' as const,
        paidFen: 1000,
        refundFen: 0,
        netFen: 1000,
        original: receipt.original,
        refundImages: [],
      }],
      sheets: [],
      options: { department: '', date: null, signerMode: 'text' as const, signerName: '', signature: null },
      notes: [],
      pdfPath,
      archivedAt: null,
    };

    try {
      await mkdir(join(temp, '2026-07', 'originals'), { recursive: true });
      await mkdir(join(temp, '2026-08', 'exports'), { recursive: true });
      await writeFile(safePath(temp, receipt.original.path), originalBytes);
      await writeFile(safePath(temp, pdfPath), pdfBytes);
      store.put('receipts', receipt);
      store.put('batches', batch);
      store.put('files', {
        id: receipt.original.id,
        ownerId: receipt.id,
        kind: 'original',
        path: receipt.original.path,
        sha256: receipt.original.sha256,
        deletedAt: null,
      });
      store.put('files', {
        id: 'cross-month-pdf',
        ownerId: batch.id,
        kind: 'pdf',
        path: pdfPath,
        sha256: createHash('sha256').update(pdfBytes).digest('hex'),
        deletedAt: null,
      });

      expect(history(store).map((group) => group.month)).toEqual(['2026-08']);
      expect(archiveMonth(store, selectedMonth, new Date('2026-09-02T00:00:00.000Z')).affected).toBe(1);
      expect(store.get('receipts', receipt.id)?.status).toBe('archived');
      expect(store.get('batches', batch.id)?.archivedAt).not.toBeNull();
      expect((await cleanOriginals(store, config, selectedMonth, `DELETE ORIGINALS ${selectedMonth}`)).affected).toBe(1);
      await expect(readFile(safePath(temp, receipt.original.path))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(safePath(temp, pdfPath))).toEqual(pdfBytes);
      expect(unarchiveMonth(store, selectedMonth).affected).toBe(1);
      expect(store.get('receipts', receipt.id)?.status).toBe('generated');
    } finally {
      store.close();
      await rm(temp, { recursive: true, force: true });
    }
    },
  );
});
