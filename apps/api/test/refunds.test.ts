import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { netFen } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { addRefundImage, isEligible, setRefund } from '../src/refunds.js';
import { sampleReceipt } from './support.js';

describe('refund recording and evidence', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-refunds-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('keeps main status and excludes a full refund from eligibility', () => {
    store.put('receipts', sampleReceipt({ paidFen: 30000 }));

    expect(netFen(setRefund(store, 'receipt-1', 8000))).toBe(22000);
    const full = setRefund(store, 'receipt-1', 30000);
    expect(full.status).toBe('ready');
    expect(isEligible(full)).toBe(false);
    expect(() => setRefund(store, 'receipt-1', 30001)).toThrow(
      'INVALID_REFUND',
    );
    expect(() => setRefund(store, 'receipt-1', -1)).toThrow('INVALID_REFUND');
  });

  it('allows a refund to reset to zero and filters every ineligible receipt state', () => {
    const ready = sampleReceipt({ paidFen: 30000, refundFen: 8000 });
    store.put('receipts', ready);

    expect(setRefund(store, ready.id, 0)).toMatchObject({
      refundFen: 0,
      status: 'ready',
      recognizedFen: 1000,
    });
    expect(isEligible(store.get('receipts', ready.id)!)).toBe(true);
    expect(
      [
        { status: 'pending' as const },
        { deletedAt: '2026-09-03T00:00:00.000Z' },
        { archivedAt: '2026-09-03T00:00:00.000Z' },
        { batchId: 'batch-1' },
        { category: null },
        { paidFen: null },
      ].every((override) => !isEligible({ ...ready, ...override })),
    ).toBe(true);
  });

  it('appends refund evidence in addition order and preserves the original hash', async () => {
    const receipt = sampleReceipt({ paidFen: 30000 });
    const originalHash = receipt.original.sha256;
    store.put('receipts', receipt);
    const first = await png('#123456');
    const second = await png('#654321');

    await addRefundImage(store, config, receipt.id, image('first.png', first));
    const updated = await addRefundImage(
      store,
      config,
      receipt.id,
      image('second.png', second),
    );

    expect(updated.original.sha256).toBe(originalHash);
    expect(updated.refundImages).toHaveLength(2);
    expect(updated.refundImages.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/^2026-09\/refunds\/.+\.png$/),
      expect.stringMatching(/^2026-09\/refunds\/.+\.png$/),
    ]);
    expect(updated.refundImages.map((entry) => entry.sha256)).toEqual([
      createHash('sha256').update(first).digest('hex'),
      createHash('sha256').update(second).digest('hex'),
    ]);
    expect(
      updated.refundImages.map((entry) => store.get('files', entry.id)),
    ).toEqual(
      updated.refundImages.map((entry) => ({
        id: entry.id,
        ownerId: receipt.id,
        kind: 'refund',
        path: entry.path,
        sha256: entry.sha256,
        deletedAt: null,
      })),
    );
  });

  it('removes only newly written refund evidence when receipt persistence fails', async () => {
    const receipt = sampleReceipt();
    store.put('receipts', receipt);
    const failingStore = fileIndexFailingStore(store);

    await expect(
      addRefundImage(
        failingStore,
        config,
        receipt.id,
        image('refund.png', await png('#bada55')),
      ),
    ).rejects.toThrow('PERSIST_FAIL');
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
    expect(await filesUnder(temp)).toEqual([]);
  });

  it('uses refund HTTP routes with strict inputs and immutable receipt conflicts', async () => {
    const ready = sampleReceipt({ id: 'ready', paidFen: 30000 });
    const generated = sampleReceipt({ id: 'generated', status: 'generated' });
    const archived = sampleReceipt({ id: 'archived', status: 'archived' });
    store.put('receipts', ready);
    store.put('receipts', generated);
    store.put('receipts', archived);
    const application = createApp({ store, config });

    const partial = await request(application)
      .put('/api/receipts/ready/refund')
      .send({ refundFen: 8000 });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({ refundFen: 8000, status: 'ready' });

    for (const body of [{ refundFen: 30001 }, { refundFen: '8000' }]) {
      const invalid = await request(application)
        .put('/api/receipts/ready/refund')
        .send(body);
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('INVALID_REFUND');
    }
    for (const id of ['generated', 'archived']) {
      const immutable = await request(application)
        .put(`/api/receipts/${id}/refund`)
        .send({ refundFen: 1 });
      expect(immutable.status).toBe(409);
      expect(immutable.body.code).toBe('IMMUTABLE_RECEIPT');
    }

    const first = await request(application)
      .post('/api/receipts/ready/refund-images')
      .attach('file', await png('#102030'), 'first.png');
    expect(first.status).toBe(200);
    const tooMany = await request(application)
      .post('/api/receipts/ready/refund-images')
      .attach('file', await png('#405060'), 'second.png')
      .attach('file', await png('#708090'), 'third.png');
    expect(tooMany.status).toBe(413);
  });

  it('rejects malformed refund requests without persisting receipt or evidence changes', async () => {
    const receipt = sampleReceipt({ id: 'invalid-request', paidFen: 30000 });
    store.put('receipts', receipt);
    const application = createApp({ store, config });

    const invalidImage = await request(application)
      .post('/api/receipts/invalid-request/refund-images')
      .attach('file', Buffer.from('not an image'), 'bad.png');
    expect(invalidImage.status).toBe(400);
    expect(invalidImage.body.code).toBe('INVALID_IMAGE');
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
    expect(store.list('files')).toEqual([]);
    expect(await filesUnder(temp)).toEqual([]);

    const wrongField = await request(application)
      .post('/api/receipts/invalid-request/refund-images')
      .attach('wrong', await png('#102030'), 'refund.png');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.code).toBe('INVALID_REFUND_IMAGE');
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
    expect(store.list('files')).toEqual([]);

    const malformedJson = await request(application)
      .put('/api/receipts/invalid-request/refund')
      .set('Content-Type', 'application/json')
      .send('{"refundFen":');
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.body.code).toBe('INVALID_REFUND');
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
  });
});

function image(name: string, bytes: Buffer) {
  return { name, mime: 'image/png', bytes };
}

async function png(background: string): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background },
  })
    .png()
    .toBuffer();
}

function fileIndexFailingStore(base: Store): Store {
  return {
    get: base.get.bind(base),
    list: base.list.bind(base),
    put: (table, row) => {
      if (table === 'files') {
        throw new Error('PERSIST_FAIL');
      }
      base.put(table, row);
    },
    remove: base.remove.bind(base),
    transact: base.transact.bind(base),
    nextOrder: base.nextOrder.bind(base),
    recordConfirmation: base.recordConfirmation.bind(base),
    backupTo: base.backupTo.bind(base),
    close: base.close.bind(base),
  };
}

async function filesUnder(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}
