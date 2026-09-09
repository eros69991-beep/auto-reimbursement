import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Analysis, Receipt } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createApp } from '../src/app.js';
import { AiError, type ReceiptAnalyzer } from '../src/ai/types.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import {
  createQueue,
  getProgress,
  persistAnalysis,
  type RecognitionQueue,
} from '../src/queue.js';
import { storeImage } from '../src/storage.js';
import { sampleReceipt } from './support.js';

const analysis: Analysis = {
  amount: '12.30',
  category: '耗材',
  merchant: '测试商户',
  date: '2026-09-03',
  confidence: { amount: 0.99, category: 0.98 },
  ambiguous: false,
  keywords: ['测试'],
  evidence: '实付 12.30',
};
const realSetImmediate = setImmediate;

describe('durable recognition queue', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'reimbursement-queue-'));
    config = loadConfig({}, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    vi.useRealTimers();
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('never exceeds four simultaneous calls and makes exactly three attempts', async () => {
    for (let order = 1; order <= 5; order += 1) {
      await insertRecognizing(store, config, order);
    }
    let active = 0;
    let peak = 0;
    let calls = 0;
    const analyzer: ReceiptAnalyzer = {
      analyzeReceipt: async () => {
        active += 1;
        peak = Math.max(peak, active);
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        throw new AiError('UPSTREAM', true);
      },
    };
    vi.useFakeTimers();
    const queue = createQueue({
      store,
      config: { ...config, concurrency: 4 },
      analyzer,
      onAnalyzed: () => {
        throw new Error('unexpected success');
      },
    });

    queue.start();
    const drained = queue.drain();
    await waitUntil(() => calls === 4);
    await vi.advanceTimersByTimeAsync(5);
    await waitUntil(() => calls === 5);
    await vi.advanceTimersByTimeAsync(5);
    await waitUntil(() =>
      store.list('receipts').every((receipt) => receipt.nextAttemptAt !== null),
    );
    await vi.advanceTimersByTimeAsync(995);
    await waitUntil(() => calls === 9);
    await vi.advanceTimersByTimeAsync(5);
    await waitUntil(() => calls === 10);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(2_995);
    await waitUntil(() => calls === 14);
    await vi.advanceTimersByTimeAsync(5);
    await waitUntil(() => calls === 15);
    await vi.advanceTimersByTimeAsync(5);
    await drained;
    await queue.stop();

    expect(peak).toBe(4);
    expect(calls).toBe(15);
    expect(
      store
        .list('receipts')
        .every(
          (receipt) =>
            receipt.status === 'pending' && receipt.attempts === 3,
        ),
    ).toBe(true);
  });

  it('persists each attempt before calling and retries after 1s then 3s', async () => {
    const receipt = await insertRecognizing(store, config, 1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const calledAt: number[] = [];
    const persistedAttempts: number[] = [];
    const analyzer: ReceiptAnalyzer = {
      analyzeReceipt: async () => {
        calledAt.push(Date.now());
        persistedAttempts.push(store.get('receipts', receipt.id)!.attempts);
        throw new AiError('RATE_LIMIT', true);
      },
    };
    const queue = createQueue({
      store,
      config,
      analyzer,
      onAnalyzed: () => undefined,
    });

    queue.start();
    await waitUntil(() => calledAt.length === 1);
    expect(calledAt).toEqual([Date.parse('2026-09-03T00:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calledAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => calledAt.length === 2);
    expect(calledAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calledAt).toHaveLength(2);
    const drained = queue.drain();
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => calledAt.length === 3);
    await drained;

    expect(calledAt).toEqual([
      Date.parse('2026-09-03T00:00:00.000Z'),
      Date.parse('2026-09-03T00:00:01.000Z'),
      Date.parse('2026-09-03T00:00:04.000Z'),
    ]);
    expect(persistedAttempts).toEqual([1, 2, 3]);
    expect(store.get('receipts', receipt.id)).toMatchObject({
      status: 'pending',
      pendingReasons: ['api_failed'],
      attempts: 3,
      nextAttemptAt: null,
    });
    await queue.stop();
  });

  it('does not hold a store transaction across analyzer or callback awaits', async () => {
    const receipt = await insertRecognizing(store, config, 1);
    let transactionActive = false;
    const guardedStore: Store = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      put: store.put.bind(store),
      remove: store.remove.bind(store),
      transact: <T>(run: () => T): T => {
        transactionActive = true;
        try {
          return store.transact(run);
        } finally {
          transactionActive = false;
        }
      },
      nextOrder: store.nextOrder.bind(store),
      recordConfirmation: store.recordConfirmation.bind(store),
      backupTo: store.backupTo.bind(store),
      close: store.close.bind(store),
    };
    const queue = createQueue({
      store: guardedStore,
      config,
      analyzer: {
        analyzeReceipt: async () => {
          expect(transactionActive).toBe(false);
          await Promise.resolve();
          expect(transactionActive).toBe(false);
          return analysis;
        },
      },
      onAnalyzed: (id, result) => {
        expect(transactionActive).toBe(false);
        persistAnalysis(guardedStore, id, result);
      },
    });

    queue.start();
    await queue.drain();

    expect(store.get('receipts', receipt.id)).toMatchObject({
      analysis,
      recognizedFen: 1230,
      status: 'pending',
      pendingReasons: ['amount_uncertain', 'category_uncertain'],
    });
    await queue.stop();
  });

  it('fails terminal errors immediately but retries transient errors', async () => {
    const terminal = await insertRecognizing(store, config, 1);
    const transient = await insertRecognizing(store, config, 2);
    const calls = new Map<string, number>();
    vi.useFakeTimers();
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: async ({ bytes }) => {
          const id = bytes.equals(terminal.bytes) ? terminal.id : transient.id;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          throw new AiError(id === terminal.id ? 'AUTH' : 'UPSTREAM', id !== terminal.id);
        },
      },
      onAnalyzed: () => undefined,
    });

    queue.start();
    const drained = queue.drain();
    await waitUntil(() => calls.size === 2);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitUntil(() => calls.get(transient.id) === 2);
    await vi.advanceTimersByTimeAsync(3_000);
    await waitUntil(() => calls.get(transient.id) === 3);
    await drained;

    expect(calls).toEqual(
      new Map([
        [terminal.id, 1],
        [transient.id, 3],
      ]),
    );
    expect(store.get('receipts', terminal.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      pendingReasons: ['api_failed'],
    });
    expect(store.get('receipts', transient.id)).toMatchObject({
      status: 'pending',
      attempts: 3,
      pendingReasons: ['api_failed'],
    });
    await queue.stop();
  });

  it('resumes persisted due work and fails exhausted work without another call', async () => {
    const future = await insertRecognizing(store, config, 1, {
      attempts: 1,
      nextAttemptAt: '2026-09-03T00:00:05.000Z',
    });
    const exhausted = await insertRecognizing(store, config, 2, {
      attempts: 3,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const called: string[] = [];
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: async ({ bytes }) => {
          called.push(bytes.equals(future.bytes) ? future.id : exhausted.id);
          return analysis;
        },
      },
      onAnalyzed: (id, result) => persistAnalysis(store, id, result),
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(called).toEqual([]);
    const drained = queue.drain();
    await vi.advanceTimersByTimeAsync(1);
    await drained;

    expect(called).toEqual([future.id]);
    expect(store.get('receipts', future.id)).toMatchObject({
      status: 'pending',
      attempts: 2,
      recognizedFen: 1230,
    });
    expect(store.get('receipts', exhausted.id)).toMatchObject({
      status: 'pending',
      attempts: 3,
      pendingReasons: ['api_failed'],
    });
    await queue.stop();
  });

  it('preserves upload order when analyses complete out of order', async () => {
    const first = await insertRecognizing(store, config, 1);
    const second = await insertRecognizing(store, config, 2);
    vi.useFakeTimers();
    const completed: string[] = [];
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: async ({ bytes }) => {
          const isFirst = bytes.equals(first.bytes);
          await new Promise((resolve) => setTimeout(resolve, isFirst ? 20 : 1));
          completed.push(isFirst ? first.id : second.id);
          return analysis;
        },
      },
      onAnalyzed: (id, result) => persistAnalysis(store, id, result),
    });

    queue.start();
    const drained = queue.drain();
    await waitUntil(() => completed.length === 0 && vi.getTimerCount() === 2);
    await vi.advanceTimersByTimeAsync(20);
    await drained;

    expect(completed).toEqual([second.id, first.id]);
    expect(store.get('receipts', first.id)!.uploadOrder).toBe(1);
    expect(store.get('receipts', second.id)!.uploadOrder).toBe(2);
    await queue.stop();
  });

  it('stop waits for active work, clears retry timers, and releases drain', async () => {
    const receipt = await insertRecognizing(store, config, 1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    let rejectCall!: (error: Error) => void;
    let calls = 0;
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: () => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            rejectCall = reject;
          });
        },
      },
      onAnalyzed: () => undefined,
    });
    queue.start();
    await waitUntil(() => rejectCall !== undefined);
    const drained = queue.drain();
    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    rejectCall(new AiError('UPSTREAM', true));
    await stopping;
    await drained;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.get('receipts', receipt.id)).toMatchObject({
      status: 'recognizing',
      attempts: 1,
      nextAttemptAt: '2026-09-03T00:00:01.000Z',
    });
  });

  it('marks missing or unindexed originals terminal without invoking the analyzer', async () => {
    const missingIndex = sampleReceipt({
      id: 'missing-index',
      status: 'recognizing',
      analysis: null,
      uploadOrder: 1,
    });
    const missingFile = sampleReceipt({
      id: 'missing-file',
      status: 'recognizing',
      analysis: null,
      uploadOrder: 2,
      original: {
        ...sampleReceipt().original,
        id: 'missing-file-image',
        path: '2026-09/originals/missing-file.png',
      },
    });
    store.put('receipts', missingIndex);
    store.put('receipts', missingFile);
    store.put('files', {
      id: missingFile.original.id,
      ownerId: missingFile.id,
      kind: 'original',
      path: missingFile.original.path,
      sha256: missingFile.original.sha256,
      deletedAt: null,
    });
    let calls = 0;
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: async () => {
          calls += 1;
          return analysis;
        },
      },
      onAnalyzed: () => undefined,
    });

    queue.start();
    await queue.drain();

    expect(calls).toBe(0);
    for (const id of [missingIndex.id, missingFile.id]) {
      expect(store.get('receipts', id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        pendingReasons: ['api_failed'],
      });
    }
    await queue.stop();
  });
});

describe('recognition queue API integration', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'reimbursement-queue-api-'));
    config = loadConfig({}, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('enqueues accepted uploads and confirmed distinct receipts', async () => {
    const enqueued: string[][] = [];
    const queue = fakeQueue(enqueued);
    const upload = await request(createApp({ store, config, queue }))
      .post('/api/receipts/upload')
      .attach('files', await png(21), 'receipt.png');
    expect(upload.status).toBe(201);
    const uploaded = upload.body.accepted[0] as Receipt;
    expect(enqueued).toEqual([[uploaded.id]]);

    store.put('receipts', {
      ...uploaded,
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: ['prior'],
    });
    const confirmed = await request(createApp({ store, config, queue })).post(
      `/api/receipts/${uploaded.id}/confirm-distinct`,
    );

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('recognizing');
    expect(enqueued).toEqual([[uploaded.id], [uploaded.id]]);
  });

  it('retries only pending api_failed receipts and maps guards', async () => {
    const failed = sampleReceipt({
      id: 'failed',
      status: 'pending',
      pendingReasons: ['api_failed'],
      attempts: 3,
      nextAttemptAt: '2026-09-03T00:00:04.000Z',
    });
    store.put('receipts', failed);
    store.put('receipts', sampleReceipt({ id: 'ready' }));
    const enqueued: string[][] = [];
    const application = createApp({ store, config, queue: fakeQueue(enqueued) });

    const missing = await request(application).post('/api/receipts/missing/retry');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RECEIPT_NOT_FOUND');
    const disallowed = await request(application).post('/api/receipts/ready/retry');
    expect(disallowed.status).toBe(409);
    expect(disallowed.body.code).toBe('RETRY_NOT_ALLOWED');
    const retried = await request(application).post('/api/receipts/failed/retry');

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      id: failed.id,
      status: 'recognizing',
      attempts: 0,
      pendingReasons: [],
      nextAttemptAt: null,
    });
    expect(store.get('receipts', failed.id)).toEqual(retried.body);
    expect(enqueued).toEqual([[failed.id]]);
  });

  it('reports progress for only the requested unique IDs', async () => {
    store.put('receipts', sampleReceipt({ id: 'old-ready', uploadOrder: 1 }));
    store.put(
      'receipts',
      sampleReceipt({
        id: 'requested-recognizing',
        uploadOrder: 2,
        status: 'recognizing',
      }),
    );
    store.put(
      'receipts',
      sampleReceipt({
        id: 'requested-pending',
        uploadOrder: 3,
        status: 'pending',
        pendingReasons: ['api_failed'],
      }),
    );
    const ids = ['requested-recognizing', 'requested-pending', 'requested-pending'];

    expect(getProgress(store, ids)).toEqual({
      recognizing: 1,
      ready: 0,
      pending: 1,
      total: 2,
    });
    const response = await request(createApp({ store, config })).get(
      `/api/progress?ids=${ids.join(',')}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      recognizing: 1,
      ready: 0,
      pending: 1,
      total: 2,
    });
  });

  it('never analyzes exact or suspected duplicates accepted by upload flow', async () => {
    const source = await patternedPng(17, 0);
    const recompressed = await sharp(source).png({ compressionLevel: 9 }).toBuffer();
    const existingImage = await storeImage(config, '2026-09', 'originals', {
      name: 'source.png',
      mime: 'image/png',
      bytes: source,
    });
    const existing = sampleReceipt({
      id: 'historical',
      original: existingImage,
      uploadOrder: 1,
    });
    store.put('receipts', existing);
    store.put('files', {
      id: existingImage.id,
      ownerId: existing.id,
      kind: 'original',
      path: existingImage.path,
      sha256: existingImage.sha256,
      deletedAt: null,
    });
    let calls = 0;
    const queue = createQueue({
      store,
      config,
      analyzer: {
        analyzeReceipt: async () => {
          calls += 1;
          return analysis;
        },
      },
      onAnalyzed: (id, result) => persistAnalysis(store, id, result),
    });
    queue.start();
    const application = createApp({ store, config, queue });

    const exact = await request(application)
      .post('/api/receipts/upload')
      .attach('files', source, 'renamed.png');
    expect(exact.body).toMatchObject({
      accepted: [],
      rejected: [{ code: 'EXACT_DUPLICATE', duplicateId: existing.id }],
    });
    const suspected = await request(application)
      .post('/api/receipts/upload')
      .attach('files', recompressed, 'recompressed.png');
    expect(suspected.body.accepted[0]).toMatchObject({
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: [existing.id],
    });
    await queue.drain();

    expect(calls).toBe(0);
    await queue.stop();
  });
});

async function insertRecognizing(
  store: Store,
  config: Config,
  order: number,
  overrides: Partial<Receipt> = {},
): Promise<Receipt & { bytes: Buffer }> {
  const bytes = await png(order);
  const original = await storeImage(config, '2026-09', 'originals', {
    name: `${order}.png`,
    mime: 'image/png',
    bytes,
  });
  const receipt = sampleReceipt({
    id: `receipt-${order}`,
    original,
    uploadOrder: order,
    status: 'recognizing',
    analysis: null,
    recognizedFen: null,
    paidFen: null,
    category: null,
    ...overrides,
  });
  store.transact(() => {
    store.put('receipts', receipt);
    store.put('files', {
      id: original.id,
      ownerId: receipt.id,
      kind: 'original',
      path: original.path,
      sha256: original.sha256,
      deletedAt: null,
    });
  });
  return Object.assign(receipt, { bytes });
}

function fakeQueue(enqueued: string[][]): RecognitionQueue {
  return {
    start: () => undefined,
    enqueue: (ids) => enqueued.push(ids),
    drain: async () => undefined,
    stop: async () => undefined,
  };
}

async function png(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: seed, g: seed * 2, b: seed * 3 },
    },
  })
    .png()
    .toBuffer();
}

async function patternedPng(seed: number, compressionLevel: number): Promise<Buffer> {
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
  throw new Error('CONDITION_NOT_REACHED');
}
