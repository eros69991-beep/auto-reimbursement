import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATEGORIES,
  COMPANY_CATEGORIES,
  type Analysis,
  type Batch,
  type Receipt,
  type Rule,
} from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveMonth, cleanOriginals, history } from '../src/archive.js';
import { createApp } from '../src/app.js';
import { createBatch, moveBatchGroup, poolTotals } from '../src/batches.js';
import { loadConfig, type Config } from '../src/config.js';
import { applyAnalysis, decide, reapplyRules } from '../src/decision.js';
import { openStore, type Store } from '../src/db.js';
import { findDuplicates, refineDuplicates } from '../src/duplicates.js';
import { listRules, recordCorrection } from '../src/learning.js';
import { mergeReceipts, splitReceipt } from '../src/merge.js';
import { listReceipts, uploadReceipts } from '../src/receipts.js';
import { setRefund } from '../src/refunds.js';
import { groupItems } from '../src/render/layout.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

const now = new Date(2026, 8, 3, 12, 0, 0);

async function patternPng(seed: number, compressionLevel = 6): Promise<Buffer> {
  const width = 18;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel })
    .toBuffer();
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    amount: '100.00',
    category: null,
    merchant: '某某商贸',
    date: '2026-09-03',
    confidence: { amount: 0.99, category: 0.5 },
    ambiguous: false,
    keywords: [],
    evidence: '',
    ...overrides,
  };
}

function manualRule(key: string, category: Rule['category']): Rule {
  return {
    id: `manual:${category}:${key}`,
    kind: 'keyword',
    key,
    originalCategory: null,
    category,
    confirmations: 0,
    strong: false,
    updatedAt: '2026-09-01T00:00:00.000Z',
    source: 'manual',
  };
}

describe('contracts: ledgers and categories', () => {
  it('keeps the two category lists apart and treats missing ledger as the store', async () => {
    const contracts = await import('@auto-reimbursement/contracts');
    expect(contracts.ledgerOf({})).toBe('store');
    expect(contracts.ledgerOf({ ledger: 'company' })).toBe('company');
    expect(contracts.ledgerOf(null)).toBe('store');
    expect(contracts.categoriesFor('store')).toEqual(CATEGORIES);
    expect(contracts.categoriesFor('company')).toEqual(COMPANY_CATEGORIES);
    for (const category of CATEGORIES) expect(contracts.categoryLedger(category)).toBe('store');
    for (const category of COMPANY_CATEGORIES) expect(contracts.categoryLedger(category)).toBe('company');
    expect(new Set([...CATEGORIES, ...COMPANY_CATEGORIES]).size).toBe(CATEGORIES.length + COMPANY_CATEGORIES.length);
    expect(contracts.ALL_CATEGORIES).toEqual([...CATEGORIES, ...COMPANY_CATEGORIES]);
    expect(contracts.isLedger('company')).toBe(true);
    expect(contracts.isLedger('other')).toBe(false);
  });
});

describe('company ledger isolation', () => {
  let temp: string;
  let config: Config;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-company-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  const app = (): ReturnType<typeof createApp> => createApp({ store, config });

  async function upload(png: Buffer, ledger?: string): Promise<request.Response> {
    return request(app())
      .post(ledger === undefined ? '/api/receipts/upload' : `/api/receipts/upload?ledger=${ledger}`)
      .attach('files', png, 'receipt.png');
  }

  describe('upload, lists and totals', () => {
    it('puts uploads in the store unless the company ledger is asked for, and keeps the lists apart', async () => {
      const storeUpload = await upload(await patternPng(1));
      const companyUpload = await upload(await patternPng(2), 'company');
      expect(storeUpload.status).toBe(201);
      expect(companyUpload.status).toBe(201);
      const storeReceipt = storeUpload.body.accepted[0] as Receipt;
      const companyReceipt = companyUpload.body.accepted[0] as Receipt;
      // 店内的凭证不带 ledger 字段，存下来的数据和以前一样
      expect(Object.hasOwn(storeReceipt, 'ledger')).toBe(false);
      expect(companyReceipt.ledger).toBe('company');
      expect(store.get('receipts', companyReceipt.id)?.ledger).toBe('company');

      store.put('receipts', { ...store.get('receipts', storeReceipt.id)!, status: 'ready', category: '耗材', paidFen: 1200, recognizedFen: 1200 });
      store.put('receipts', { ...store.get('receipts', companyReceipt.id)!, status: 'ready', category: '肉款', paidFen: 1290949, recognizedFen: 1290949 });

      const storePool = await request(app()).get('/api/receipts?view=pool');
      const companyPool = await request(app()).get('/api/receipts?view=pool&ledger=company');
      expect(storePool.body.map((row: Receipt) => row.id)).toEqual([storeReceipt.id]);
      expect(companyPool.body.map((row: Receipt) => row.id)).toEqual([companyReceipt.id]);
      expect((await request(app()).get('/api/receipts?view=pool&ledger=store')).body).toHaveLength(1);

      const storeTotals = await request(app()).get('/api/pool/totals');
      const companyTotals = await request(app()).get('/api/pool/totals?ledger=company');
      expect(storeTotals.body).toMatchObject({ count: 1, totalFen: 1200 });
      expect(Object.keys(storeTotals.body.byCategory)).toEqual([...CATEGORIES]);
      expect(companyTotals.body).toMatchObject({ count: 1, totalFen: 1290949 });
      expect(Object.keys(companyTotals.body.byCategory)).toEqual([...COMPANY_CATEGORIES]);
      expect(companyTotals.body.byCategory['肉款']).toBe(1290949);
    });

    it('lists pending, excluded and deleted receipts per ledger too', () => {
      store.put('receipts', sampleReceipt({ id: 's-pending', status: 'pending', uploadOrder: 1 }));
      store.put('receipts', sampleReceipt({ id: 'c-pending', ledger: 'company', status: 'pending', category: '肉款', uploadOrder: 2 }));
      store.put('receipts', sampleReceipt({ id: 's-excluded', poolExcluded: true, uploadOrder: 3 }));
      store.put('receipts', sampleReceipt({ id: 'c-excluded', ledger: 'company', category: '肉款', poolExcluded: true, uploadOrder: 4 }));
      store.put('receipts', sampleReceipt({ id: 's-deleted', deletedAt: '2026-09-04T00:00:00.000Z', uploadOrder: 5 }));
      store.put('receipts', sampleReceipt({ id: 'c-deleted', ledger: 'company', category: '肉款', deletedAt: '2026-09-04T00:00:00.000Z', uploadOrder: 6 }));

      const ids = (rows: Receipt[]): string[] => rows.map((row) => row.id);
      expect(ids(listReceipts(store, 'pending'))).toEqual(['s-pending']);
      expect(ids(listReceipts(store, 'pending', 'company'))).toEqual(['c-pending']);
      expect(ids(listReceipts(store, 'excluded'))).toEqual(['s-excluded']);
      expect(ids(listReceipts(store, 'excluded', 'company'))).toEqual(['c-excluded']);
      expect(ids(listReceipts(store, 'deleted'))).toEqual(['s-deleted']);
      expect(ids(listReceipts(store, 'deleted', 'company'))).toEqual(['c-deleted']);
    });

    it('rejects an unknown ledger instead of guessing', async () => {
      const response = await upload(await patternPng(3), 'other');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_LEDGER');
      expect(store.list('receipts')).toEqual([]);
      expect((await request(app()).get('/api/receipts?view=pool&ledger=other')).status).toBe(400);
      expect((await request(app()).get('/api/pool/totals?ledger=other')).status).toBe(400);
      expect((await request(app()).get('/api/history?ledger=other')).status).toBe(400);
    });

    it('does not count the other ledger in the totals', () => {
      store.put('receipts', sampleReceipt({ id: 's', category: '耗材', paidFen: 500 }));
      store.put('receipts', sampleReceipt({ id: 'c', ledger: 'company', category: '物业费', paidFen: 700 }));
      expect(poolTotals(store.list('receipts'))).toMatchObject({ count: 1, totalFen: 500 });
      expect(poolTotals(store.list('receipts'), 'company')).toMatchObject({ count: 1, totalFen: 700 });
      expect(poolTotals(store.list('receipts'), 'company').byCategory['物业费']).toBe(700);
    });
  });

  describe('duplicates', () => {
    it('refuses the same picture while it is live in the other ledger, and says which ledger it is in', async () => {
      const png = await patternPng(10);
      const first = await upload(png);
      const second = await upload(png, 'company');
      expect(second.status).toBe(201);
      expect(second.body.accepted).toEqual([]);
      expect(second.body.rejected).toEqual([
        { index: 0, code: 'EXACT_DUPLICATE', duplicateId: first.body.accepted[0].id, duplicateLedger: 'store' },
      ]);
      // 同一个区里的重复照旧，不带 duplicateLedger
      const third = await upload(png);
      expect(third.body.rejected).toEqual([{ index: 0, code: 'EXACT_DUPLICATE', duplicateId: first.body.accepted[0].id }]);
    });

    it('lets a wrongly filed picture be deleted and uploaded again in the right ledger', async () => {
      const png = await patternPng(11);
      const first = await upload(png);
      const id = first.body.accepted[0].id as string;
      expect((await request(app()).delete(`/api/receipts/${id}`)).status).toBe(204);

      // 回收站里的在另一个区：不算重复，可以在对的区重新传
      const moved = await upload(png, 'company');
      expect(moved.body.rejected).toEqual([]);
      expect(moved.body.accepted).toHaveLength(1);
      expect(moved.body.accepted[0].ledger).toBe('company');

      // 回到店内再传：公账区里有一张在用的同一张，仍然拦下
      const back = await upload(png);
      expect(back.body.rejected).toEqual([
        { index: 0, code: 'EXACT_DUPLICATE', duplicateId: moved.body.accepted[0].id, duplicateLedger: 'company' },
      ]);
    });

    it('still points at the trash in the same ledger', async () => {
      const png = await patternPng(12);
      const first = await upload(png, 'company');
      await request(app()).delete(`/api/receipts/${first.body.accepted[0].id}`);
      const again = await upload(png, 'company');
      expect(again.body.rejected).toEqual([
        { index: 0, code: 'DELETED_DUPLICATE', duplicateId: first.body.accepted[0].id },
      ]);
    });

    it('flags similar pictures only inside the store; bank receipts share one template, so the company ledger skips it', async () => {
      const source = await patternPng(90, 0);
      const recompressed = await sharp(source).png({ compressionLevel: 9 }).toBuffer();

      const inStore = await request(app())
        .post('/api/receipts/upload')
        .attach('files', source, 'a.png')
        .attach('files', recompressed, 'b.png');
      expect(inStore.body.accepted[1]).toMatchObject({ status: 'pending', pendingReasons: ['suspected_duplicate'] });

      store.close();
      store = openStore(':memory:');
      const inCompany = await request(app())
        .post('/api/receipts/upload?ledger=company')
        .attach('files', source, 'a.png')
        .attach('files', recompressed, 'b.png');
      expect(inCompany.body.rejected).toEqual([]);
      expect(inCompany.body.accepted.map((row: Receipt) => row.status)).toEqual(['recognizing', 'recognizing']);
      expect(inCompany.body.accepted.every((row: Receipt) => row.duplicateIds.length === 0)).toBe(true);
    });

    it('does not compare similar pictures across ledgers', async () => {
      const source = await patternPng(91, 0);
      const recompressed = await sharp(source).png({ compressionLevel: 9 }).toBuffer();
      await upload(source);
      const other = await upload(recompressed, 'company');
      expect(other.body.accepted[0]).toMatchObject({ status: 'recognizing', duplicateIds: [] });
      const result = await uploadReceipts(store, config, [{ name: 'x.png', mime: 'image/png', bytes: await patternPng(92) }], now, 'company');
      const image = result.accepted[0]!.original;
      const storeView = findDuplicates(store, { ...image, id: 'probe', sha256: '1'.repeat(64) }, 'store');
      expect(storeView.suspectedIds).toEqual([]);
    });

    it('points at the copy in this ledger when both ledgers hold a live copy of the same picture', () => {
      const same = { ...sampleReceipt().original, sha256: 'a'.repeat(64) };
      store.put('receipts', sampleReceipt({ id: 's-copy', uploadOrder: 1, original: { ...same, id: 'img-s' } }));
      store.put('receipts', sampleReceipt({ id: 'c-copy', ledger: 'company', category: '肉款', uploadOrder: 2, original: { ...same, id: 'img-c' } }));
      const probe = { ...same, id: 'probe' };
      const forCompany = findDuplicates(store, probe, 'company');
      const forStore = findDuplicates(store, probe, 'store');
      expect(forCompany.exactId).toBe('c-copy');
      expect(forStore.exactId).toBe('s-copy');
      // 指的是本区的那张，不是「在另一个区」
      expect(Object.hasOwn(forCompany, 'exactOtherLedger')).toBe(false);
      expect(Object.hasOwn(forStore, 'exactOtherLedger')).toBe(false);
    });

    it('re-checks for look-alikes after recognition only inside one ledger', () => {
      const fields = { paidFen: 1290949, recognizedFen: 1290949, date: '2026-09-03', merchant: '上海新沣食品销售有限公司' };
      const make = (id: string, ledger: 'company' | undefined, order: number, hash: string): Receipt => sampleReceipt({
        id,
        ...(ledger === undefined ? {} : { ledger }),
        category: ledger === undefined ? '肉类' : '肉款',
        uploadOrder: order,
        ...fields,
        original: { ...sampleReceipt().original, id: `img-${id}`, sha256: hash.repeat(64) },
      });
      store.put('receipts', make('s-1', undefined, 1, 'a'));
      store.put('receipts', make('c-1', 'company', 2, 'b'));
      expect(refineDuplicates(store, store.get('receipts', 's-1')!)).toEqual([]);
      expect(refineDuplicates(store, store.get('receipts', 'c-1')!)).toEqual([]);
      store.put('receipts', make('c-2', 'company', 3, 'c'));
      // 同一个区里，同金额、同日期、同收款方、图相似：照旧提示
      expect(refineDuplicates(store, store.get('receipts', 'c-1')!)).toEqual(['c-2']);
      expect(refineDuplicates(store, store.get('receipts', 's-1')!)).toEqual([]);
    });

    it('does not let a deleted picture come back while the same picture is live in the other ledger', async () => {
      const png = await patternPng(13);
      const first = await upload(png);
      const id = first.body.accepted[0].id as string;
      await request(app()).delete(`/api/receipts/${id}`);
      const moved = await upload(png, 'company');
      expect(moved.body.accepted).toHaveLength(1);

      const blocked = await request(app()).post(`/api/receipts/${id}/restore`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('LEDGER_DUPLICATE');
      expect(store.get('receipts', id)?.deletedAt).not.toBeNull();

      // 另一个区那张删掉以后，这张就能恢复
      await request(app()).delete(`/api/receipts/${moved.body.accepted[0].id}`);
      const restored = await request(app()).post(`/api/receipts/${id}/restore`);
      expect(restored.status).toBe(200);
      expect(store.get('receipts', id)?.deletedAt).toBeNull();
    });
  });

  describe('batches, history and archive', () => {
    function seedBothLedgers(): { storeBatch: Batch; companyBatch: Batch } {
      store.put('receipts', sampleReceipt({ id: 'store-1', category: '耗材', paidFen: 5000, uploadOrder: 1 }));
      store.put('receipts', sampleReceipt({
        id: 'company-1',
        ledger: 'company',
        category: '肉款',
        paidFen: 1290949,
        uploadOrder: 2,
        original: { ...sampleReceipt().original, id: 'image-company-1', sha256: '1'.repeat(64) },
      }));
      store.put('receipts', sampleReceipt({
        id: 'company-2',
        ledger: 'company',
        category: '品牌管理费',
        paidFen: 678500,
        uploadOrder: 3,
        original: { ...sampleReceipt().original, id: 'image-company-2', sha256: '2'.repeat(64) },
      }));
      const options = resolveOptions(getSettings(store), now);
      return {
        storeBatch: createBatch(store, ['store-1'], options, now),
        companyBatch: createBatch(store, ['company-1', 'company-2'], options, now),
      };
    }

    it('refuses a batch that mixes the two ledgers and changes nothing', async () => {
      store.put('receipts', sampleReceipt({ id: 'store-1', category: '耗材', paidFen: 5000, uploadOrder: 1 }));
      store.put('receipts', sampleReceipt({
        id: 'company-1', ledger: 'company', category: '肉款', paidFen: 100, uploadOrder: 2,
        original: { ...sampleReceipt().original, id: 'image-company-1', sha256: '1'.repeat(64) },
      }));
      const options = resolveOptions(getSettings(store), now);
      expect(() => createBatch(store, ['store-1', 'company-1'], options, now)).toThrow('MIXED_LEDGER');
      expect(store.list('batches')).toEqual([]);
      expect(store.get('receipts', 'store-1')?.status).toBe('ready');

      const response = await request(app())
        .post('/api/batches')
        .send({ receiptIds: ['store-1', 'company-1'], options });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('MIXED_LEDGER');
    });

    it('marks company batches, leaves store batches exactly as before, and groups by the company categories', () => {
      const { storeBatch, companyBatch } = seedBothLedgers();
      expect(Object.hasOwn(storeBatch, 'ledger')).toBe(false);
      expect(companyBatch.ledger).toBe('company');
      expect(companyBatch.totalFen).toBe(1290949 + 678500);
      expect(groupItems(companyBatch.items).map((group) => group.category)).toEqual(['肉款', '品牌管理费']);
      expect(companyBatch.sheets).toHaveLength(1);
      expect(companyBatch.sheets[0]!.groups.map((group) => group.totalFen)).toEqual([1290949, 678500]);
    });

    it('moves a company category between sheets (the move request accepts company categories)', async () => {
      store.put('receipts', sampleReceipt({
        id: 'company-1', ledger: 'company', category: '肉款', paidFen: 100, uploadOrder: 1,
        original: { ...sampleReceipt().original, id: 'image-company-1', sha256: '1'.repeat(64) },
      }));
      store.put('receipts', sampleReceipt({
        id: 'company-2', ledger: 'company', category: '店面租金', paidFen: 200, uploadOrder: 2,
        original: { ...sampleReceipt().original, id: 'image-company-2', sha256: '2'.repeat(64) },
      }));
      const batch = createBatch(store, ['company-1', 'company-2'], resolveOptions(getSettings(store), now), now);
      expect(batch.sheets).toHaveLength(1);
      const moved = moveBatchGroup(store, batch.id, '店面租金', 1);
      expect(moved.sheets.map((sheet) => sheet.groups.map((group) => group.category))).toEqual([['肉款'], ['店面租金']]);

      const response = await request(app())
        .post(`/api/batches/${batch.id}/move`)
        .send({ category: '店面租金', direction: -1 });
      expect(response.status).toBe(200);
      expect(response.body.sheets).toHaveLength(1);
      const bogus = await request(app()).post(`/api/batches/${batch.id}/move`).send({ category: '不存在的分类', direction: 1 });
      expect(bogus.status).toBe(400);
    });

    it('keeps history per ledger', async () => {
      const { storeBatch, companyBatch } = seedBothLedgers();
      expect(history(store).flatMap((month) => month.batches.map((batch) => batch.id))).toEqual([storeBatch.id]);
      expect(history(store, 'company').flatMap((month) => month.batches.map((batch) => batch.id))).toEqual([companyBatch.id]);
      const storeHistory = await request(app()).get('/api/history');
      const companyHistory = await request(app()).get('/api/history?ledger=company');
      expect(storeHistory.body[0].batches.map((batch: Batch) => batch.id)).toEqual([storeBatch.id]);
      expect(companyHistory.body[0].batches.map((batch: Batch) => batch.id)).toEqual([companyBatch.id]);
    });

    it('archives, unarchives and cleans a month for one ledger only', async () => {
      const { storeBatch, companyBatch } = seedBothLedgers();
      for (const batch of [storeBatch, companyBatch]) store.put('batches', { ...batch, pdfPath: `2026-09/exports/${batch.id}.pdf` });

      expect(archiveMonth(store, '2026-09', now, 'company').affected).toBe(2);
      expect(store.get('receipts', 'company-1')?.status).toBe('archived');
      expect(store.get('batches', companyBatch.id)?.archivedAt).not.toBeNull();
      // 店内同一个月的凭证和批次原样
      expect(store.get('receipts', 'store-1')?.status).toBe('generated');
      expect(store.get('batches', storeBatch.id)?.archivedAt).toBeNull();

      const unarchived = await request(app()).post('/api/unarchive/2026-09?ledger=company');
      expect(unarchived.status).toBe(200);
      expect(unarchived.body.affected).toBe(2);
      expect(store.get('batches', companyBatch.id)?.archivedAt).toBeNull();

      // 不带 ledger 的归档就是店内：公账的不受影响
      const archived = await request(app()).post('/api/archive/2026-09');
      expect(archived.body.affected).toBe(1);
      expect(store.get('receipts', 'store-1')?.status).toBe('archived');
      expect(store.get('receipts', 'company-1')?.status).toBe('generated');
    });

    it('archives one ledger over HTTP and leaves the other alone', async () => {
      const { storeBatch, companyBatch } = seedBothLedgers();
      for (const batch of [storeBatch, companyBatch]) store.put('batches', { ...batch, pdfPath: `2026-09/exports/${batch.id}.pdf` });
      const response = await request(app()).post('/api/archive/2026-09?ledger=company');
      expect(response.status).toBe(200);
      expect(response.body.affected).toBe(2);
      expect(store.get('receipts', 'company-1')?.status).toBe('archived');
      expect(store.get('receipts', 'store-1')?.status).toBe('generated');
      expect((await request(app()).post('/api/archive/2026-09?ledger=other')).status).toBe(400);
      expect((await request(app()).post('/api/unarchive/2026-09?ledger=other')).status).toBe(400);
    });

    it('cleans the originals of one ledger only, whatever the other ledger has not finished', async () => {
      const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
      async function seedExported(id: string, ledger: 'company' | undefined, archived: boolean, order: number): Promise<void> {
        const originalBytes = Buffer.from(`original ${id}`);
        const pdfBytes = Buffer.from(`%PDF-1.7 ${id}`);
        const original = {
          ...sampleReceipt().original,
          id: `image-${id}`,
          path: `2026-09/originals/${id}.png`,
          sha256: sha(originalBytes),
          bytes: originalBytes.length,
        };
        const pdfPath = `2026-09/exports/${id}.pdf`;
        const category = ledger === undefined ? ('耗材' as const) : ('肉款' as const);
        await mkdir(join(temp, '2026-09', 'originals'), { recursive: true });
        await mkdir(join(temp, '2026-09', 'exports'), { recursive: true });
        await writeFile(safePath(temp, original.path), originalBytes);
        await writeFile(safePath(temp, pdfPath), pdfBytes);
        const archivedAt = archived ? '2026-09-04T00:00:00.000Z' : null;
        store.put('receipts', sampleReceipt({
          id,
          ...(ledger === undefined ? {} : { ledger }),
          category,
          status: archived ? 'archived' : 'generated',
          archivedAt,
          statusBeforeArchive: archived ? 'generated' : null,
          batchId: `batch-${id}`,
          uploadOrder: order,
          original,
        }));
        store.put('batches', {
          id: `batch-${id}`,
          ...(ledger === undefined ? {} : { ledger }),
          month: '2026-09',
          createdAt: '2026-09-04T00:00:00.000Z',
          totalFen: 1000,
          items: [{ receiptId: id, uploadOrder: order, category, paidFen: 1000, refundFen: 0, netFen: 1000, original, refundImages: [] }],
          sheets: [],
          options: { department: '', date: null, signerMode: 'text' as const, signerName: '', signature: null },
          notes: [],
          pdfPath,
          archivedAt,
        });
        store.put('files', { id: original.id, ownerId: id, kind: 'original', path: original.path, sha256: original.sha256, deletedAt: null });
        store.put('files', { id: `pdf-${id}`, ownerId: `batch-${id}`, kind: 'pdf', path: pdfPath, sha256: sha(pdfBytes), deletedAt: null });
      }
      await seedExported('company-a', 'company', true, 1);
      // 店内同一个月还有一张没归档：店内不能清理，但不影响公账
      await seedExported('store-a', undefined, false, 2);

      const confirmation = { confirmation: 'DELETE ORIGINALS 2026-09' };
      const blocked = await request(app()).post('/api/cleanup/2026-09').send(confirmation);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CLEANUP_NOT_ALLOWED');

      expect((await request(app()).post('/api/cleanup/2026-09?ledger=other').send(confirmation)).status).toBe(400);
      const cleaned = await request(app()).post('/api/cleanup/2026-09?ledger=company').send(confirmation);
      expect(cleaned.status).toBe(200);
      expect(cleaned.body.affected).toBe(1);
      expect(store.get('receipts', 'company-a')?.original.deletedAt).not.toBeNull();
      expect(store.get('receipts', 'store-a')?.original.deletedAt).toBeNull();
      // 再清理一次：公账的原图已经清理过，没有要处理的了，店内的原图还在
      expect((await cleanOriginals(store, config, '2026-09', confirmation.confirmation, 'company')).affected).toBe(0);
      expect(store.get('receipts', 'store-a')?.original.deletedAt).toBeNull();
    });

    it('does not let unfinished work in one ledger block archiving the other', () => {
      store.put('receipts', sampleReceipt({ id: 'store-pending', status: 'pending', month: '2026-09' }));
      store.put('receipts', sampleReceipt({
        id: 'company-done', ledger: 'company', category: '肉款', status: 'ready', month: '2026-09',
        original: { ...sampleReceipt().original, id: 'image-company-done', sha256: '3'.repeat(64) },
      }));
      expect(() => archiveMonth(store, '2026-09', now)).toThrow('MONTH_HAS_UNFINISHED_WORK');
      expect(archiveMonth(store, '2026-09', now, 'company').affected).toBe(1);
    });
  });

  describe('rules', () => {
    it('only applies a fixed rule to receipts of its own ledger', () => {
      const settings = getSettings(store);
      const storeRule = manualRule('某某商贸', '酒水');
      const companyRule = manualRule('某某商贸', '肉款');
      const rules = [storeRule, companyRule];

      const forStore = decide(analysis({ category: '食材' }), rules, settings, 'store');
      expect(forStore).toMatchObject({ status: 'ready', category: '酒水' });
      const forCompany = decide(analysis({ category: '其他公账支出' }), rules, settings, 'company');
      expect(forCompany).toMatchObject({ status: 'ready', category: '肉款' });
      // 只有另一个区的规则时，规则不起作用，回到 AI 判断（置信度不够 → 待处理）
      const storeOnly = decide(analysis({ category: '其他公账支出' }), [storeRule], settings, 'company');
      expect(storeOnly.status).toBe('pending');
      expect(storeOnly.category).toBe('其他公账支出');
      expect(storeOnly.ruleMatch).toBeUndefined();
      const companyOnly = decide(analysis({ category: '食材' }), [companyRule], settings, 'store');
      expect(companyOnly.status).toBe('pending');
      expect(companyOnly.ruleMatch).toBeUndefined();
    });

    it('lists rules per ledger by their category', async () => {
      for (const rule of [manualRule('新沣', '肉款'), manualRule('武汉仓', '百慕达食材')]) store.put('rules', rule);
      expect(listRules(store).map((rule) => rule.category).sort()).toEqual(['百慕达食材', '肉款'].sort());
      expect(listRules(store, 'company').map((rule) => rule.category)).toEqual(['肉款']);
      expect(listRules(store, 'store').map((rule) => rule.category)).toEqual(['百慕达食材']);
      const company = await request(app()).get('/api/rules?ledger=company');
      expect(company.body.map((rule: Rule) => rule.category)).toEqual(['肉款']);
      expect((await request(app()).get('/api/rules')).body).toHaveLength(2);
    });

    it('learns company rules under their own id so the same name in the store is a separate rule', () => {
      const storeReceipt = sampleReceipt({ id: 'r-store', merchant: '同名商户', category: '食材' });
      const companyReceipt = sampleReceipt({
        id: 'r-company', ledger: 'company', merchant: '同名商户', category: '肉款',
        original: { ...sampleReceipt().original, id: 'image-r-company', sha256: '4'.repeat(64) },
      });
      store.put('receipts', storeReceipt);
      store.put('receipts', companyReceipt);
      const storeRule = recordCorrection(store, 'r-store', '食材');
      const companyRule = recordCorrection(store, 'r-company', '肉款');
      expect(storeRule?.id).toBe('merchant:同名商户');
      expect(companyRule?.id).toBe('company:merchant:同名商户');
      expect(store.get('rules', 'merchant:同名商户')?.category).toBe('食材');
      expect(store.get('rules', 'company:merchant:同名商户')?.category).toBe('肉款');
    });

    function pendingWith(id: string, ledger: 'company' | undefined, category: Receipt['category'], hash: string): Receipt {
      return sampleReceipt({
        id,
        ...(ledger === undefined ? {} : { ledger }),
        status: 'pending',
        category,
        pendingReasons: ['category_uncertain'],
        recognizedFen: 10000,
        paidFen: 10000,
        analysis: analysis({ category, merchant: '某某商贸' }),
        original: { ...sampleReceipt().original, id: `image-${id}`, sha256: hash.repeat(64) },
      });
    }

    it('re-applies rules for one ledger without touching the other', () => {
      store.put('receipts', pendingWith('s', undefined, '食材', '5'));
      store.put('receipts', pendingWith('c', 'company', '其他公账支出', '6'));
      store.put('rules', manualRule('某某商贸', '酒水'));
      store.put('rules', manualRule('某某商贸', '肉款'));

      expect(reapplyRules(store, 'company')).toBe(1);
      expect(store.get('receipts', 'c')).toMatchObject({ status: 'ready', category: '肉款' });
      expect(store.get('receipts', 's')).toMatchObject({ status: 'pending', category: '食材' });

      expect(reapplyRules(store)).toBe(1);
      expect(store.get('receipts', 's')).toMatchObject({ status: 'ready', category: '酒水' });
    });

    it('re-applies rules for one ledger over HTTP', async () => {
      store.put('receipts', pendingWith('s', undefined, '食材', '5'));
      store.put('receipts', pendingWith('c', 'company', '其他公账支出', '6'));
      store.put('rules', manualRule('某某商贸', '酒水'));
      store.put('rules', manualRule('某某商贸', '肉款'));

      const company = await request(app()).post('/api/rules/reapply?ledger=company');
      expect(company.body).toEqual({ affected: 1 });
      expect(store.get('receipts', 'c')).toMatchObject({ status: 'ready', category: '肉款' });
      expect(store.get('receipts', 's')).toMatchObject({ status: 'pending', category: '食材' });

      // 不带 ledger 的请求按店内处理（和以前一样）：只动店内的凭证
      const storeLedger = await request(app()).post('/api/rules/reapply?ledger=store');
      expect(storeLedger.body).toEqual({ affected: 1 });
      expect(store.get('receipts', 's')).toMatchObject({ status: 'ready', category: '酒水' });
      expect((await request(app()).post('/api/rules/reapply?ledger=other')).status).toBe(400);
    });

    it('applies the fixed rules of its own ledger when a receipt is recognized', () => {
      store.put('rules', manualRule('新沣', '肉款'));
      store.put('rules', manualRule('新沣', '酒水'));
      const recognizing = (id: string, ledger: 'company' | undefined, hash: string): Receipt => sampleReceipt({
        id,
        ...(ledger === undefined ? {} : { ledger }),
        status: 'recognizing',
        category: null,
        paidFen: null,
        recognizedFen: null,
        original: { ...sampleReceipt().original, id: `image-${id}`, sha256: hash.repeat(64) },
      });
      store.put('receipts', recognizing('s', undefined, '9'));
      store.put('receipts', recognizing('c', 'company', 'a'));
      const result = analysis({ merchant: '上海新沣食品销售有限公司', category: null });
      expect(applyAnalysis(store, 'c', result)).toMatchObject({ status: 'ready', category: '肉款' });
      expect(applyAnalysis(store, 's', result)).toMatchObject({ status: 'ready', category: '酒水' });
    });
  });

  describe('editing', () => {
    it('only accepts categories of the ledger the receipt is in', async () => {
      store.put('receipts', sampleReceipt({ id: 's', status: 'pending', category: null, paidFen: null, recognizedFen: null }));
      store.put('receipts', sampleReceipt({
        id: 'c', ledger: 'company', status: 'pending', category: null, paidFen: null, recognizedFen: null,
        original: { ...sampleReceipt().original, id: 'image-c', sha256: '7'.repeat(64) },
      }));

      const wrongForCompany = await request(app()).post('/api/receipts/c/confirm').send({ paidFen: 100, category: '耗材' });
      expect(wrongForCompany.status).toBe(400);
      expect(wrongForCompany.body.code).toBe('INVALID_CATEGORY');
      const wrongForStore = await request(app()).post('/api/receipts/s/confirm').send({ paidFen: 100, category: '肉款' });
      expect(wrongForStore.status).toBe(400);
      expect(wrongForStore.body.code).toBe('INVALID_CATEGORY');
      expect((await request(app()).patch('/api/receipts/c').send({ category: '食材' })).status).toBe(400);

      const rightForCompany = await request(app()).post('/api/receipts/c/confirm').send({ paidFen: 678500, category: '品牌管理费' });
      expect(rightForCompany.status).toBe(200);
      expect(rightForCompany.body).toMatchObject({ status: 'ready', category: '品牌管理费', paidFen: 678500, ledger: 'company' });
      const rightForStore = await request(app()).post('/api/receipts/s/confirm').send({ paidFen: 100, category: '耗材' });
      expect(rightForStore.status).toBe(200);
    });

    it('has no refunds in the company ledger', async () => {
      store.put('receipts', sampleReceipt({
        id: 'c', ledger: 'company', category: '肉款', paidFen: 100000,
        original: { ...sampleReceipt().original, id: 'image-c', sha256: '8'.repeat(64) },
      }));
      expect(() => setRefund(store, 'c', 100)).toThrow('REFUND_NOT_SUPPORTED');
      const response = await request(app()).put('/api/receipts/c/refund').send({ refundFen: 100 });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('REFUND_NOT_SUPPORTED');
      expect(store.get('receipts', 'c')?.refundFen).toBe(0);
    });
  });

  describe('merging screenshots', () => {
    async function uploaded(seed: number, ledger: 'store' | 'company'): Promise<Receipt> {
      const result = await uploadReceipts(store, config, [{ name: `${seed}.png`, mime: 'image/png', bytes: await patternPng(seed) }], now, ledger);
      const receipt = result.accepted[0]!;
      const ready: Receipt = { ...receipt, status: 'pending', category: null, pendingReasons: ['incomplete_screenshot'] };
      store.put('receipts', ready);
      return ready;
    }

    it('merges two company screenshots into a company receipt', async () => {
      const first = await uploaded(20, 'company');
      const second = await uploaded(21, 'company');
      const merged = await mergeReceipts(store, config, [first.id, second.id], now);
      expect(merged.ledger).toBe('company');
      expect(merged.mergedFrom).toEqual([first.id, second.id]);
    });

    it('keeps a store merge exactly as before (no ledger field)', async () => {
      const first = await uploaded(22, 'store');
      const second = await uploaded(23, 'store');
      const merged = await mergeReceipts(store, config, [first.id, second.id], now);
      expect(Object.hasOwn(merged, 'ledger')).toBe(false);
    });

    it('does not let a split bring back a screenshot that was uploaded again in the other ledger', async () => {
      const first = await uploaded(26, 'company');
      const second = await uploaded(27, 'company');
      const merged = await mergeReceipts(store, config, [first.id, second.id], now);
      // 合并后来源截图被隐藏，把其中一张传到店内不算重复
      const again = await uploadReceipts(store, config, [{ name: 'again.png', mime: 'image/png', bytes: await patternPng(26) }], now, 'store');
      expect(again.rejected).toEqual([]);
      expect(again.accepted).toHaveLength(1);

      await expect(splitReceipt(store, config, merged.id)).rejects.toThrow('LEDGER_DUPLICATE');
      expect(store.get('receipts', merged.id)?.deletedAt).toBeNull();
      expect(store.get('receipts', first.id)?.deletedAt).not.toBeNull();
      const response = await request(app()).post(`/api/receipts/${merged.id}/split`);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('LEDGER_DUPLICATE');

      // 店内那张删掉以后就能拆开
      store.put('receipts', { ...store.get('receipts', again.accepted[0]!.id)!, deletedAt: now.toISOString() });
      const restored = await splitReceipt(store, config, merged.id);
      expect(restored.map((row) => row.id)).toEqual([first.id, second.id]);
    });

    it('refuses to merge screenshots from two ledgers', async () => {
      const first = await uploaded(24, 'store');
      const second = await uploaded(25, 'company');
      await expect(mergeReceipts(store, config, [first.id, second.id], now)).rejects.toThrow('MERGE_MIXED_LEDGER');
      expect(store.get('receipts', first.id)?.deletedAt).toBeNull();
      expect(store.get('receipts', second.id)?.deletedAt).toBeNull();
    });
  });
});
