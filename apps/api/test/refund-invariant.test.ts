import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { netFenOrNull } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { sampleReceipt } from './support.js';

describe('refund invariant (P-03)', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-refund-'));
    store = openStore(join(temp, 'app.sqlite'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('rejects lowering paidFen below the recorded refund', async () => {
    store.put('receipts', sampleReceipt({ paidFen: 19707, refundFen: 15000 }));
    const application = createApp({ store, config });
    const response = await request(application)
      .patch('/api/receipts/receipt-1')
      .send({ paidFen: 10000 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REFUND_EXCEEDS_PAID');
    expect(store.get('receipts', 'receipt-1')?.paidFen).toBe(19707);
  });

  it('rejects confirming a receipt whose refund exceeds its paid amount', async () => {
    store.put(
      'receipts',
      sampleReceipt({ status: 'pending', paidFen: 10000, refundFen: 15000 }),
    );
    const application = createApp({ store, config });
    const response = await request(application).post('/api/receipts/receipt-1/confirm');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REFUND_EXCEEDS_PAID');
  });

  it('keeps pool totals working when legacy dirty data exists', async () => {
    store.put('receipts', sampleReceipt({ id: 'dirty', paidFen: 10000, refundFen: 15000 }));
    store.put('receipts', sampleReceipt({ id: 'clean', paidFen: 5000, refundFen: 0 }));
    const application = createApp({ store, config });
    const response = await request(application).get('/api/pool/totals');
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.totalFen).toBe(5000);
  });

  it('netFenOrNull degrades instead of throwing', () => {
    expect(netFenOrNull({ paidFen: 10000, refundFen: 15000 })).toBeNull();
    expect(netFenOrNull({ paidFen: 10000, refundFen: 4000 })).toBe(6000);
    expect(netFenOrNull({ paidFen: null, refundFen: 0 })).toBeNull();
  });
});
