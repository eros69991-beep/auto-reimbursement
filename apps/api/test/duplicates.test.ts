import { createHash } from 'node:crypto';

import type { ImageRef, Receipt } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import {
  confirmDistinct,
  findDuplicates,
  fingerprint,
  refineDuplicates,
} from '../src/duplicates.js';
import { sampleReceipt } from './support.js';

describe('historical duplicate detection', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('blocks renamed originals even after history is archived or deleted', () => {
    const archived = sampleReceipt({
      id: 'archived',
      original: imageRef({
        id: 'archived-image',
        sha256: 'a'.repeat(64),
        perceptualHash: '1234567890abcdef',
      }),
      status: 'archived',
      archivedAt: '2026-10-01T00:00:00.000Z',
    });
    const deleted = sampleReceipt({
      id: 'deleted',
      original: imageRef({
        id: 'deleted-image',
        sha256: 'b'.repeat(64),
        perceptualHash: 'fedcba0987654321',
      }),
      deletedAt: '2026-10-02T00:00:00.000Z',
      uploadOrder: 2,
    });
    store.put('receipts', deleted);
    store.put('receipts', archived);

    expect(
      findDuplicates(
        store,
        imageRef({
          id: 'renamed-archived-image',
          sha256: archived.original.sha256,
          perceptualHash: archived.original.perceptualHash,
        }),
      ).exactId,
    ).toBe('archived');
    expect(
      findDuplicates(
        store,
        imageRef({
          id: 'renamed-deleted-image',
          sha256: deleted.original.sha256,
          perceptualHash: deleted.original.perceptualHash,
        }),
      ).exactId,
    ).toBe('deleted');
  });

  it('uses SHA-256 bytes and a real 64-bit dHash for recompressed images', async () => {
    const { source, recompressed, checkerboard } = await imageFixtures();
    const sourceFingerprint = await fingerprint(source);
    const recompressedFingerprint = await fingerprint(recompressed);
    const checkerboardFingerprint = await fingerprint(checkerboard);

    expect(sourceFingerprint.sha256).toBe(
      createHash('sha256').update(source).digest('hex'),
    );
    expect(sourceFingerprint.sha256).not.toBe(recompressedFingerprint.sha256);
    expect(sourceFingerprint.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    expect(recompressedFingerprint.perceptualHash).toBe(
      sourceFingerprint.perceptualHash,
    );
    expect(checkerboardFingerprint.perceptualHash).not.toBe(
      sourceFingerprint.perceptualHash,
    );

    store.put(
      'receipts',
      sampleReceipt({
        id: 'source',
        original: imageRef({
          id: 'source-image',
          ...sourceFingerprint,
        }),
      }),
    );

    expect(
      findDuplicates(
        store,
        imageRef({ id: 'recompressed-image', ...recompressedFingerprint }),
      ),
    ).toEqual({ exactId: null, suspectedIds: ['source'] });
    expect(
      findDuplicates(
        store,
        imageRef({ id: 'checkerboard-image', ...checkerboardFingerprint }),
      ),
    ).toEqual({ exactId: null, suspectedIds: [] });
  });

  it('does not match empty fingerprints or the image itself', () => {
    const receipt = sampleReceipt({
      id: 'self',
      original: imageRef({
        id: 'same-image',
        sha256: 'c'.repeat(64),
        perceptualHash: '0000000000000000',
      }),
    });
    store.put('receipts', receipt);

    expect(findDuplicates(store, receipt.original)).toEqual({
      exactId: null,
      suspectedIds: [],
    });
    expect(
      findDuplicates(
        store,
        imageRef({ id: 'empty-image', sha256: '', perceptualHash: '' }),
      ),
    ).toEqual({ exactId: null, suspectedIds: [] });
  });

  it('returns duplicate IDs in upload order with an ID tie-breaker', () => {
    const perceptualHash = '0f0f0f0f0f0f0f0f';
    for (const receipt of [
      sampleReceipt({
        id: 'z-last',
        uploadOrder: 2,
        original: imageRef({
          id: 'z-image',
          sha256: '1'.repeat(64),
          perceptualHash,
        }),
      }),
      sampleReceipt({
        id: 'b-second',
        uploadOrder: 1,
        original: imageRef({
          id: 'b-image',
          sha256: '2'.repeat(64),
          perceptualHash,
        }),
      }),
      sampleReceipt({
        id: 'a-first',
        uploadOrder: 1,
        original: imageRef({
          id: 'a-image',
          sha256: '3'.repeat(64),
          perceptualHash,
        }),
      }),
    ]) {
      store.put('receipts', receipt);
    }

    expect(
      findDuplicates(
        store,
        imageRef({
          id: 'candidate',
          sha256: '4'.repeat(64),
          perceptualHash,
        }),
      ).suspectedIds,
    ).toEqual(['a-first', 'b-second', 'z-last']);
  });

  it('refines only when image and every normalized metadata field agree', () => {
    const candidate = sampleReceipt({
      id: 'candidate',
      original: imageRef({
        id: 'candidate-image',
        perceptualHash: '0000000000000000',
      }),
      paidFen: 1234,
      merchant: 'ＡＣＭＥ   Store',
      date: '2026-09-03',
      uploadOrder: 10,
    });
    const rows: Receipt[] = [
      sampleReceipt({
        id: 'match',
        original: imageRef({
          id: 'match-image',
          perceptualHash: '00000000000003ff',
        }),
        paidFen: 1234,
        merchant: ' acme store ',
        date: '2026-09-03',
        uploadOrder: 1,
      }),
      sampleReceipt({
        id: 'metadata-only',
        original: imageRef({
          id: 'metadata-image',
          perceptualHash: 'ffffffffffffffff',
        }),
        paidFen: 1234,
        merchant: 'acme store',
        date: '2026-09-03',
        uploadOrder: 2,
      }),
      sampleReceipt({
        id: 'wrong-amount',
        original: imageRef({
          id: 'amount-image',
          perceptualHash: '0000000000000001',
        }),
        paidFen: 1235,
        merchant: 'acme store',
        date: '2026-09-03',
        uploadOrder: 3,
      }),
      sampleReceipt({
        id: 'empty-merchant',
        original: imageRef({
          id: 'merchant-image',
          perceptualHash: '0000000000000001',
        }),
        paidFen: 1234,
        merchant: '   ',
        date: '2026-09-03',
        uploadOrder: 4,
      }),
      sampleReceipt({
        id: 'null-date',
        original: imageRef({
          id: 'date-image',
          perceptualHash: '0000000000000001',
        }),
        paidFen: 1234,
        merchant: 'acme store',
        date: null,
        uploadOrder: 5,
      }),
      candidate,
    ];
    for (const row of rows) {
      store.put('receipts', row);
    }

    expect(refineDuplicates(store, candidate)).toEqual(['match']);
    expect(
      refineDuplicates(store, { ...candidate, duplicateOverride: true }),
    ).toEqual([]);
  });

  it('confirms an unanalysed suspected receipt as distinct and resumes recognition', () => {
    const receipt = sampleReceipt({
      id: 'pending',
      analysis: null,
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: ['prior'],
    });
    store.put('receipts', receipt);

    const confirmed = confirmDistinct(store, receipt.id);
    expect(confirmed).toMatchObject({
      id: receipt.id,
      status: 'recognizing',
      pendingReasons: [],
      duplicateIds: [],
      duplicateOverride: true,
    });
    expect(store.get('receipts', receipt.id)).toEqual(confirmed);
  });

  it('releases an analysed receipt when duplicate review was its only blocker', () => {
    const receipt = sampleReceipt({
      id: 'analysed-duplicate',
      analysis: {
        amount: '10.00',
        category: '耗材',
        merchant: '已识别商户',
        date: '2026-09-03',
        confidence: { amount: 0.99, category: 0.99 },
        ambiguous: false,
        keywords: [],
        evidence: '实付 10.00',
      },
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: ['prior'],
    });
    store.put('receipts', receipt);

    expect(confirmDistinct(store, receipt.id)).toMatchObject({
      status: 'ready',
      pendingReasons: [],
      duplicateIds: [],
      duplicateOverride: true,
    });
  });

  it('keeps an analysed receipt review-visible when another reason remains', () => {
    const receipt = sampleReceipt({
      id: 'analysed-low-confidence',
      analysis: {
        amount: '10.00',
        category: '耗材',
        merchant: '已识别商户',
        date: '2026-09-03',
        confidence: { amount: 0.99, category: 0.4 },
        ambiguous: false,
        keywords: [],
        evidence: '实付 10.00',
      },
      status: 'pending',
      pendingReasons: ['category_uncertain', 'suspected_duplicate'],
      duplicateIds: ['prior'],
    });
    store.put('receipts', receipt);

    expect(confirmDistinct(store, receipt.id)).toMatchObject({
      status: 'pending',
      pendingReasons: ['category_uncertain'],
      duplicateIds: [],
      duplicateOverride: true,
    });
  });
});

describe('confirm-distinct HTTP lifecycle', () => {
  let store: Store;
  let config: Config;

  beforeEach(() => {
    store = openStore(':memory:');
    config = loadConfig({}, process.cwd());
  });

  afterEach(() => {
    store.close();
  });

  it('maps an unknown receipt to 404 and archived history to 409', async () => {
    store.put(
      'receipts',
      sampleReceipt({
        id: 'archived',
        status: 'archived',
        archivedAt: '2026-10-01T00:00:00.000Z',
      }),
    );

    const unknown = await request(createApp({ store, config })).post(
      '/api/receipts/unknown/confirm-distinct',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({
      code: 'RECEIPT_NOT_FOUND',
      message: '凭证不存在',
    });

    const archived = await request(createApp({ store, config })).post(
      '/api/receipts/archived/confirm-distinct',
    );
    expect(archived.status).toBe(409);
    expect(archived.body).toEqual({
      code: 'IMMUTABLE_RECEIPT',
      message: '已归档凭证不可修改',
    });
  });
});

function imageRef(overrides: Partial<ImageRef> = {}): ImageRef {
  return {
    id: 'candidate-image',
    path: '2026-09/originals/candidate-image.png',
    mime: 'image/png',
    sha256: 'd'.repeat(64),
    perceptualHash: 'aaaaaaaaaaaaaaaa',
    bytes: 100,
    width: 18,
    height: 16,
    deletedAt: null,
    ...overrides,
  };
}

async function imageFixtures(): Promise<{
  source: Buffer;
  recompressed: Buffer;
  checkerboard: Buffer;
}> {
  const width = 18;
  const height = 16;
  const gradientPixels = Buffer.alloc(width * height * 3);
  const checkerboardPixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const gradient = (x * 11 + y * 7) % 256;
      const checker = (x + y) % 2 === 0 ? 0 : 255;
      gradientPixels.fill(gradient, offset, offset + 3);
      checkerboardPixels.fill(checker, offset, offset + 3);
    }
  }
  const source = await sharp(gradientPixels, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const recompressed = await sharp(source)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const checkerboard = await sharp(checkerboardPixels, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { source, recompressed, checkerboard };
}
