import { CATEGORIES, type Batch, type Category, type FormSheet, type ImageRef } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createBatch, getBatch, moveBatchGroup, poolTotals, updateBatchLayout } from '../src/batches.js';
import { loadConfig } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { deleteReceipt, listReceipts } from '../src/receipts.js';
import { groupItems } from '../src/render/layout.js';
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
      for (let index = 0; index < 8; index += 1) {
        store.put('receipts', sampleReceipt({
          id: `supply-${index}`,
          category: '耗材',
          paidFen: 10000,
          uploadOrder: index + 1,
        }));
      }
      store.put('receipts', sampleReceipt({
        id: 'food', category: '食材', paidFen: 10000, uploadOrder: 9,
      }));
      const batch = createBatch(
        store,
        [...Array.from({ length: 8 }, (_, index) => `supply-${index}`), 'food'],
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

  it('splits a category with too many receipts across sheets and keeps its parts fixed', async () => {
    const store = openStore(':memory:');
    try {
      // 食材 40 张：每行 6 张、一张 5 行，第一张放 30 张，余下 10 张接到第二张；酒水 1 张排在后面
      const foodIds = Array.from({ length: 40 }, (_, index) => `food-${index}`);
      foodIds.forEach((id, index) => {
        store.put('receipts', sampleReceipt({ id, category: '食材', paidFen: 10000 + index, uploadOrder: index + 1 }));
      });
      store.put('receipts', sampleReceipt({ id: 'wine', category: '酒水', paidFen: 5600, uploadOrder: 41 }));
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });
      const created = await request(app).post('/api/batches').send({
        receiptIds: [...foodIds, 'wine'],
        options: resolveOptions(getSettings(store), new Date()),
      });

      expect(created.status).toBe(201);
      const batch = created.body as Batch;
      expect(batch.sheets.map((sheet) => sheet.groups.map((group) => [group.category, group.part, group.receiptIds.length, group.totalFen]))).toEqual([
        [['食材', 1, 30, 300435]],
        [['食材', 2, 10, 100345], ['酒水', undefined, 1, 5600]],
      ]);
      expect(batch.sheets[0]!.groups[0]!.receiptIds).toEqual(foodIds.slice(0, 30));
      expect(batch.sheets[1]!.groups[0]!.receiptIds).toEqual(foodIds.slice(30));
      // 没有被拆开的分类不带 part 字段，接口输出和以前一样
      expect(Object.keys(batch.sheets[1]!.groups[1]!)).not.toContain('part');
      expect(batch.totalFen).toBe(406380);
      expect(store.list('receipts').every((receipt) => receipt.status === 'generated' && receipt.batchId === batch.id)).toBe(true);

      // 被拆开的分类不能单独移动；没拆开的分类照常可以
      for (const direction of [1, -1]) {
        const refused = await request(app).post(`/api/batches/${batch.id}/move`).send({ category: '食材', direction });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('CATEGORY_SPLIT');
      }
      const full = await request(app).post(`/api/batches/${batch.id}/move`).send({ category: '酒水', direction: -1 });
      expect(full.status).toBe(400);
      expect(full.body.code).toBe('CATEGORY_TOO_LARGE');
      const moved = await request(app).post(`/api/batches/${batch.id}/move`).send({ category: '酒水', direction: 1 });
      expect(moved.status).toBe(200);
      expect(moved.body.sheets.map((sheet: FormSheet) => sheet.groups.map((group) => group.part ?? null))).toEqual([[1], [2], [null]]);

      // 逐张备注照常按报销单保存
      const saved = await request(app).patch(`/api/batches/${batch.id}/options`).send({
        options: batch.options,
        noteBySheet: { 'sheet-001': null, 'sheet-002': null, 'sheet-003': null },
      });
      expect(saved.status).toBe(200);
    } finally {
      store.close();
    }
  });

  it('only accepts a saved layout whose parts cover every receipt exactly once', () => {
    const store = openStore(':memory:');
    try {
      const ids = Array.from({ length: 40 }, (_, index) => `food-${index}`);
      ids.forEach((id, index) => {
        store.put('receipts', sampleReceipt({ id, category: '食材', paidFen: 10000 + index, uploadOrder: index + 1 }));
      });
      const batch = createBatch(store, ids, resolveOptions(getSettings(store), new Date()), new Date());
      expect(batch.sheets).toHaveLength(2);
      const edited = (change: (sheets: FormSheet[]) => void): FormSheet[] => {
        const sheets = structuredClone(batch.sheets);
        change(sheets);
        return sheets;
      };

      // 原样保存没问题
      expect(updateBatchLayout(store, batch.id, batch.sheets).sheets).toEqual(batch.sheets);
      // 部分的序号乱了、小计和金额对不上、少了凭证、多了一份、两部分挤在一张上，都不行
      expect(() => updateBatchLayout(store, batch.id, edited((sheets) => {
        sheets[0]!.groups[0]!.part = 2;
        sheets[1]!.groups[0]!.part = 1;
      }))).toThrow('INVALID_LAYOUT');
      expect(() => updateBatchLayout(store, batch.id, edited((sheets) => {
        sheets[1]!.groups[0]!.totalFen += 1;
      }))).toThrow('INVALID_LAYOUT');
      expect(() => updateBatchLayout(store, batch.id, edited((sheets) => {
        const part = sheets[1]!.groups[0]!;
        part.receiptIds.pop();
        part.amountsFen.pop();
        part.totalFen = part.amountsFen.reduce((sum, amount) => sum + amount, 0);
      }))).toThrow('INVALID_LAYOUT');
      expect(() => updateBatchLayout(store, batch.id, [
        { id: 'sheet-001', noteId: null, groups: groupItems(batch.items) },
      ])).toThrow('CATEGORY_TOO_LARGE');
      expect(() => updateBatchLayout(store, batch.id, edited((sheets) => {
        sheets[1]!.groups.unshift(structuredClone(sheets[0]!.groups[0]!));
      }))).toThrow('CATEGORY_TOO_LARGE');
      expect(getBatch(store, batch.id).sheets).toEqual(batch.sheets);
    } finally {
      store.close();
    }
  });

  it('does not accept two parts of one category on the same sheet', () => {
    const store = openStore(':memory:');
    try {
      // 12 张食材本来占 2 行、一张放得下；硬拆成两部分再排在同一张上是不允许的
      const ids = Array.from({ length: 12 }, (_, index) => `food-${index}`);
      ids.forEach((id, index) => {
        store.put('receipts', sampleReceipt({ id, category: '食材', paidFen: 10000 + index, uploadOrder: index + 1 }));
      });
      const batch = createBatch(store, ids, resolveOptions(getSettings(store), new Date()), new Date());
      expect(batch.sheets).toHaveLength(1);
      const whole = batch.sheets[0]!.groups[0]!;
      const part = (from: number, to: number, number: number) => ({
        category: whole.category,
        receiptIds: whole.receiptIds.slice(from, to),
        amountsFen: whole.amountsFen.slice(from, to),
        totalFen: whole.amountsFen.slice(from, to).reduce((sum, amount) => sum + amount, 0),
        part: number,
      });

      expect(() => updateBatchLayout(store, batch.id, [
        { id: 'sheet-001', noteId: null, groups: [part(0, 6, 1), part(6, 12, 2)] },
      ])).toThrow('INVALID_LAYOUT');
      expect(getBatch(store, batch.id).sheets).toEqual(batch.sheets);
    } finally {
      store.close();
    }
  });

  it('reports a draft laid out the old way as outdated, never exports it, and lets it be regenerated', async () => {
    const store = openStore(':memory:');
    try {
      const categories: Category[] = ['食材', '肉类', '酒水', '耗材', '员工餐'];
      const ids: string[] = [];
      categories.forEach((category, categoryIndex) => {
        for (let index = 0; index < 7; index += 1) {
          const id = `${category}-${index}`;
          ids.push(id);
          store.put('receipts', sampleReceipt({ id, category, paidFen: 10000 + index, uploadOrder: categoryIndex * 10 + index + 1 }));
        }
      });
      const options = resolveOptions(getSettings(store), new Date());
      const fresh = createBatch(store, ids, options, new Date());
      expect(fresh.sheets.length).toBeGreaterThan(1);
      // 旧版式：每个分类只占一行，5 个分类挤在一张上；新版式下每类 7 张金额要 2 行，共 10 行，这一张放不下
      const oldLayout: FormSheet[] = [{ id: 'sheet-001', noteId: null, groups: groupItems(fresh.items) }];
      store.put('batches', { ...fresh, sheets: oldLayout });
      const app = createApp({ store, config: loadConfig({}, process.cwd()) });

      const move = await request(app).post(`/api/batches/${fresh.id}/move`).send({ category: '食材', direction: 1 });
      expect(move.status).toBe(409);
      expect(move.body.code).toBe('LAYOUT_OUTDATED');
      expect(move.body.message).toContain('撤销');
      const preview = await request(app).get(`/api/batches/${fresh.id}/preview.pdf`);
      expect(preview.status).toBe(409);
      expect(preview.body.code).toBe('LAYOUT_OUTDATED');
      const exported = await request(app).post(`/api/batches/${fresh.id}/export`);
      expect(exported.status).toBe(409);
      expect(exported.body.code).toBe('LAYOUT_OUTDATED');
      expect(store.get('batches', fresh.id)?.pdfPath).toBeNull();
      expect(store.get('batches', fresh.id)?.sheets).toEqual(oldLayout);

      // 撤销本单后凭证回到报销池，按新版式重新生成
      expect((await request(app).post(`/api/batches/${fresh.id}/cancel`)).status).toBe(200);
      const regenerated = await request(app).post('/api/batches').send({ receiptIds: ids, options });
      expect(regenerated.status).toBe(201);
      expect(regenerated.body.sheets).toHaveLength(fresh.sheets.length);
      expect((await request(app).get(`/api/batches/${regenerated.body.id}/preview.pdf`)).status).toBe(200);
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
    ping: base.ping.bind(base),
    close: base.close.bind(base),
  };
}
