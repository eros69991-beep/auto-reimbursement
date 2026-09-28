import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { sampleReceipt } from './support.js';

// P-11：PATCH/confirm 支持修正商户（打印在报销单摘要栏）与日期（参与查重与对账）
describe('receipt merchant/date patch (P-11)', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-patch-'));
    store = openStore(join(temp, 'app.sqlite'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('accepts merchant/date on PATCH, trims the merchant and keeps the receipt pending', async () => {
    store.put('receipts', sampleReceipt({ status: 'ready' }));
    const application = createApp({ store, config });
    const response = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ merchant: '  修正商户  ', date: '2026-09-15' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      merchant: '修正商户',
      date: '2026-09-15',
      status: 'pending',
    }));
  });

  it('rejects an over-long or blank merchant and a non-calendar date', async () => {
    store.put('receipts', sampleReceipt({}));
    const application = createApp({ store, config });

    const tooLong = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ merchant: '长'.repeat(51) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('INVALID_MERCHANT');

    const blank = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ merchant: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('INVALID_MERCHANT');

    const feb30 = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ date: '2026-02-30' });
    expect(feb30.status).toBe(400);
    expect(feb30.body.code).toBe('INVALID_DATE');

    const badFormat = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ date: '2026/09/15' });
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.code).toBe('INVALID_DATE');

    // 全部失败后凭证保持原值
    const receipt = store.get('receipts', 'receipt-1');
    expect(receipt?.merchant).toBeNull();
    expect(receipt?.date).toBeNull();
  });

  it('confirms with merchant/date and keys the learning rule by the corrected merchant', async () => {
    store.put('receipts', sampleReceipt({
      status: 'pending',
      paidFen: 30000,
      category: '耗材',
      analysis: {
        amount: '300.00',
        category: '耗材',
        merchant: 'AI识别商户',
        date: '2026-09-01',
        confidence: { amount: 0.9, category: 0.9 },
        ambiguous: false,
        keywords: ['食材'],
        evidence: 'test',
      },
    }));
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/receipt-1/confirm')
      .send({ merchant: '用户修正商户', date: '2026-09-15' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ready',
      merchant: '用户修正商户',
      date: '2026-09-15',
    }));

    // 学习规则必须按用户修正后的商户记录，而不是 AI 识别结果
    expect(store.get('rules', 'merchant:用户修正商户')).not.toBeNull();
    expect(store.get('rules', 'merchant:ai识别商户')).toBeNull();
  });
});
