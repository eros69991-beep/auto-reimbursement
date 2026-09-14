import { CATEGORIES, type ImageRef } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createBatch, getBatch, moveBatchGroup, poolTotals } from '../src/batches.js';
import { loadConfig } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { deleteReceipt, listReceipts } from '../src/receipts.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { sampleReceipt } from './support.js';

describe('manual batches', () => {
  it('uses integer net amounts and only manually selected ready receipts', () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt({ id: 'a', paidFen: 3633, uploadOrder: 2 }));
    store.put(
      'receipts',
      sampleReceipt({ id: 'b', paidFen: 30000, refundFen: 8000, uploadOrder: 1 }),
    );

    const batch = createBatch(
      store,
      ['a', 'b'],
      resolveOptions(getSettings(store), new Date()),
      new Date(),
    );

    expect(batch.totalFen).toBe(25633);
    expect(batch.items.map((item) => item.receiptId)).toEqual(['b', 'a']);
    expect(store.get('receipts', 'a')?.status).toBe('generated');
    expect(() => createBatch(store, ['a'], batch.options, new Date())).toThrow(
      'NOT_ELIGIBLE',
    );
    expect(store.list('batches')).toHaveLength(1);
    store.close();
  });

  it('calculates each category from eligible net amounts only', () => {
    const store = openStore(':memory:');
    for (const [index, category] of CATEGORIES.entries()) {
      store.put(
        'receipts',
        sampleReceipt({
          id: `category-${index}`,
          category,
          paidFen: 100 + index,
          refundFen: index === 0 ? 1 : 0,
          uploadOrder: index,
        }),
      );
    }
    store.put(
      'receipts',
      sampleReceipt({ id: 'fully-refunded', paidFen: 100, refundFen: 100 }),
    );
    store.put('receipts', sampleReceipt({ id: 'pending', status: 'pending' }));

    expect(poolTotals(store.list('receipts'))).toEqual({
      count: CATEGORIES.length,
      totalFen: 1044,
      byCategory: Object.fromEntries(
        CATEGORIES.map((category, index) => [
          category,
          100 + index - (index === 0 ? 1 : 0),
        ]),
      ),
    });
    store.close();
  });

  it('keeps unbatched fully refunded receipts visible in the pool and pending view clean', () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt({ id: 'ready', uploadOrder: 3 }));
    store.put(
      'receipts',
      sampleReceipt({ id: 'refunded', paidFen: 1, refundFen: 1, uploadOrder: 1 }),
    );
    store.put(
      'receipts',
      sampleReceipt({ id: 'pending', status: 'pending', uploadOrder: 2 }),
    );
    store.put(
      'receipts',
      sampleReceipt({ id: 'deleted', status: 'pending', deletedAt: '2026-09-04T00:00:00.000Z' }),
    );
    store.put(
      'receipts',
      sampleReceipt({ id: 'archived', status: 'pending', archivedAt: '2026-09-04T00:00:00.000Z' }),
    );

    expect(listReceipts(store, 'pool').map((receipt) => receipt.id)).toEqual([
      'refunded',
      'ready',
    ]);
    expect(listReceipts(store, 'pending').map((receipt) => receipt.id)).toEqual([
      'pending',
    ]);
    store.close();
  });

  it('soft deletes only mutable receipts without destroying the source image', () => {
    const store = openStore(':memory:');
    const ready = sampleReceipt({ id: 'ready' });
    store.put('receipts', ready);
    store.put('receipts', sampleReceipt({ id: 'generated', status: 'generated' }));
    store.put('receipts', sampleReceipt({ id: 'archived', status: 'archived' }));

    deleteReceipt(store, ready.id, new Date('2026-09-04T00:00:00.000Z'));

    expect(store.get('receipts', ready.id)).toMatchObject({
      deletedAt: '2026-09-04T00:00:00.000Z',
      original: ready.original,
    });
    expect(() => deleteReceipt(store, 'generated', new Date())).toThrow('IMMUTABLE_RECEIPT');
    expect(() => deleteReceipt(store, 'archived', new Date())).toThrow('IMMUTABLE_RECEIPT');
    store.close();
  });

  it('rolls back invalid selections and snapshots one-fen cross-month receipts', () => {
    const store = openStore(':memory:');
    store.put('receipts', sampleReceipt({ id: 'one', paidFen: 1, month: '2026-08' }));
    const options = resolveOptions(getSettings(store), new Date());

    expect(() => createBatch(store, ['one', 'missing'], options, new Date())).toThrow(
      'NOT_ELIGIBLE',
    );
    expect(store.list('batches')).toEqual([]);
    expect(store.get('receipts', 'one')?.status).toBe('ready');
    expect(() => createBatch(store, ['one', 'one'], options, new Date())).toThrow(
      'INVALID_SELECTION',
    );
    expect(() => createBatch(store, [], options, new Date())).toThrow(
      'INVALID_SELECTION',
    );

    const batch = createBatch(
      store,
      ['one'],
      options,
      new Date('2026-09-04T00:00:00.000Z'),
    );
    expect(batch).toMatchObject({ month: '2026-09', totalFen: 1 });
    expect(getBatch(store, batch.id)).toEqual(batch);
    expect(() => getBatch(store, 'missing')).toThrow('BATCH_NOT_FOUND');
    store.close();
  });

  it('uses indexed signature data and clears a text-mode client signature', () => {
    const store = openStore(':memory:');
    const signature: ImageRef = {
      id: 'signature', path: 'settings/signatures/signature.png', mime: 'image/png',
      sha256: 'a'.repeat(64), perceptualHash: '0000000000000000', bytes: 1,
      width: 1, height: 1, deletedAt: null,
    };
    store.put('files', {
      id: signature.id, ownerId: 'default', kind: 'signature', path: signature.path,
      sha256: signature.sha256, deletedAt: null,
    });
    store.put('settings', { ...getSettings(store), signature });
    store.put('receipts', sampleReceipt({ id: 'image' }));
    const forged = { ...signature, path: 'outside.png', sha256: 'b'.repeat(64) };

    const imageBatch = createBatch(store, ['image'], {
      department: '门店', date: '2026-09-04', signerMode: 'image', signerName: '张三', signature: forged,
    }, new Date());
    expect(imageBatch.options.signature).toEqual(signature);

    store.put('receipts', sampleReceipt({ id: 'text' }));
    const textBatch = createBatch(store, ['text'], {
      department: '', date: null, signerMode: 'text', signerName: '', signature: forged,
    }, new Date());
    expect(textBatch.options.signature).toBeNull();
    store.close();
  });

  it('uses embedded-font metrics when moving a packed category back to its form sheet', () => {
    const store = openStore(':memory:');
    try {
      for (let index = 0; index < 55; index += 1) {
        store.put('receipts', sampleReceipt({
          id: `supply-${index}`,
          category: '耗材',
          paidFen: 10000,
          uploadOrder: index + 1,
        }));
      }
      store.put('receipts', sampleReceipt({
        id: 'food', category: '食材', paidFen: 10000, uploadOrder: 56,
      }));
      const batch = createBatch(
        store,
        [...Array.from({ length: 55 }, (_, index) => `supply-${index}`), 'food'],
        resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
        new Date('2026-09-04T00:00:00.000Z'),
      );
      expect(batch.sheets).toHaveLength(1);

      expect(moveBatchGroup(store, batch.id, '食材', 1).sheets).toHaveLength(2);
      expect(moveBatchGroup(store, batch.id, '食材', -1).sheets).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('serves pool, deletion, and a first measured reimbursement sheet', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'pool', paidFen: 2 }));
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });

      expect((await request(app).get('/api/receipts?view=pool')).status).toBe(200);
      expect((await request(app).get('/api/pool/totals')).body).toMatchObject({ count: 1, totalFen: 2 });
      const created = await request(app).post('/api/batches').send({
        receiptIds: ['pool'],
        options: resolveOptions(getSettings(store), new Date()),
      });
      expect(created.status).toBe(201);
      expect(created.body.sheets).toEqual([
        {
          id: 'sheet-001',
          noteId: null,
          groups: [
            {
              category: '耗材',
              receiptIds: ['pool'],
              amountsFen: [2],
              totalFen: 2,
            },
          ],
        },
      ]);
      expect((await request(app).get(`/api/batches/${created.body.id}`)).body).toEqual(created.body);
      expect((await request(app).delete('/api/receipts/pool')).status).toBe(409);
    } finally {
      store.close();
    }
  });

  it('rejects malformed batch options without closing any receipts', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'ready' }));
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });

      const missingSignature = await request(app).post('/api/batches').send({
        receiptIds: ['ready'],
        options: {
          department: '', date: null, signerMode: 'image', signerName: '',
        },
      });
      expect(missingSignature.status).toBe(400);
      expect(missingSignature.body.code).toBe('INVALID_SIGNATURE');
      expect(store.get('receipts', 'ready')?.status).toBe('ready');
      expect(store.list('batches')).toEqual([]);

    } finally {
      store.close();
    }
  });

  it('rejects malformed batch JSON without closing any receipts', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'ready' }));
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });

      const response = await request(app)
        .post('/api/batches')
        .set('Content-Type', 'application/json')
        .send('{');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_BATCH_REQUEST');
      expect(store.get('receipts', 'ready')?.status).toBe('ready');
      expect(store.list('batches')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('moves whole categories and saves draft options with per-sheet notes', async () => {
    const store = openStore(':memory:');
    try {
      store.put(
        'receipts',
        sampleReceipt({ id: 'supply', category: '耗材', paidFen: 100 }),
      );
      store.put(
        'receipts',
        sampleReceipt({ id: 'food', category: '食材', paidFen: 200, uploadOrder: 2 }),
      );
      store.put('notes', { id: 'purchase-note', name: '采购', content: '本月采购' });
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });
      const created = await request(app).post('/api/batches').send({
        receiptIds: ['supply', 'food'],
        options: resolveOptions(getSettings(store), new Date()),
      });

      const moved = await request(app)
        .post(`/api/batches/${created.body.id}/move`)
        .send({ category: '耗材', direction: 1 });
      expect(moved.status).toBe(200);
      expect(
        moved.body.sheets.map(
          (sheet: { id: string; groups: Array<{ category: string }> }) => [
            sheet.id,
            sheet.groups.map((group) => group.category),
          ],
        ),
      ).toEqual([
        ['sheet-001', ['食材']],
        ['sheet-002', ['耗材']],
      ]);

      const saved = await request(app)
        .patch(`/api/batches/${created.body.id}/options`)
        .send({
          options: { ...created.body.options, department: '门店' },
          noteBySheet: { 'sheet-001': null, 'sheet-002': 'purchase-note' },
        });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        options: { department: '门店' },
        sheets: [
          { id: 'sheet-001', noteId: null },
          { id: 'sheet-002', noteId: 'purchase-note' },
        ],
      });

      store.put('batches', {
        ...store.get('batches', created.body.id)!,
        pdfPath: 'exports/final.pdf',
      });
      const finalized = await request(app)
        .post(`/api/batches/${created.body.id}/move`)
        .send({ category: '耗材', direction: -1 });
      expect(finalized.status).toBe(409);
      expect(finalized.body.code).toBe('BATCH_FINALIZED');
    } finally {
      store.close();
    }
  });

  it.each([{}, []])('rejects malformed image signatures %o before file lookup', async (signature) => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'ready' }));
      const app = createApp({
        store: noUndefinedFileLookupStore(store),
        config: loadConfig({}, process.cwd()),
      });

      const response = await request(app).post('/api/batches').send({
        receiptIds: ['ready'],
        options: {
          department: '', date: null, signerMode: 'image', signerName: '', signature,
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SIGNATURE');
      expect(store.get('receipts', 'ready')?.status).toBe('ready');
      expect(store.list('batches')).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function noUndefinedFileLookupStore(base: Store): Store {
  return {
    get: (table, id) => {
      if (table === 'files' && (typeof id !== 'string' || id.length === 0)) {
        throw new Error('UNDEFINED_FILE_LOOKUP');
      }
      return base.get(table, id);
    },
    list: base.list.bind(base),
    put: base.put.bind(base),
    remove: base.remove.bind(base),
    transact: base.transact.bind(base),
    nextOrder: base.nextOrder.bind(base),
    recordConfirmation: base.recordConfirmation.bind(base),
    backupTo: base.backupTo.bind(base),
    close: base.close.bind(base),
  };
}
