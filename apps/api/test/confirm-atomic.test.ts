import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { sampleReceipt } from './support.js';

// P-10：修改 + 确认是同一个原子请求；失败时凭证保持原状态，不会“失踪”
describe('atomic confirm with patch (P-10)', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-confirm-'));
    store = openStore(join(temp, 'app.sqlite'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('applies paidFen/category and confirms in one request', async () => {
    store.put('receipts', sampleReceipt({ status: 'pending', paidFen: null, category: null }));
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/receipt-1/confirm')
      .send({ paidFen: 30000, category: '耗材' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ready',
      paidFen: 30000,
      category: '耗材',
      pendingReasons: [],
    }));
  });

  it('still confirms without a body (no patch)', async () => {
    store.put('receipts', sampleReceipt({ status: 'pending', paidFen: 30000, category: '耗材' }));
    const application = createApp({ store, config });
    const response = await request(application).post('/api/receipts/receipt-1/confirm');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
  });

  it('rejects an invalid patch and leaves the receipt untouched', async () => {
    store.put('receipts', sampleReceipt({ status: 'pending', paidFen: 30000, category: '耗材' }));
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/receipt-1/confirm')
      .send({ paidFen: -5, category: '耗材' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PAID_FEN');
    const receipt = store.get('receipts', 'receipt-1');
    expect(receipt?.status).toBe('pending');
    expect(receipt?.paidFen).toBe(30000);
  });

  it('rejects a patch that would break the refund invariant without changing state', async () => {
    store.put('receipts', sampleReceipt({ status: 'pending', paidFen: 30000, refundFen: 15000, category: '耗材' }));
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/receipt-1/confirm')
      .send({ paidFen: 10000 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REFUND_EXCEEDS_PAID');
    const receipt = store.get('receipts', 'receipt-1');
    expect(receipt?.status).toBe('pending');
    expect(receipt?.paidFen).toBe(30000);
  });
});
