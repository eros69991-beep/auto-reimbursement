import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { Receipt } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsFaults = vi.hoisted(() => ({
  failExclusiveWrite: false,
  simulateExclusiveCollision: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const actualOpen = actual.open as (...args: any[]) => Promise<any>;
  const actualWriteFile = actual.writeFile as (...args: any[]) => Promise<void>;

  return {
    ...actual,
    open: async (...args: any[]) => {
      if (fsFaults.simulateExclusiveCollision && args[1] === 'wx') {
        await actualWriteFile(args[0], Buffer.from('pre-existing'), {
          flag: 'wx',
        });
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      const handle = await actualOpen(...args);
      if (!fsFaults.failExclusiveWrite || args[1] !== 'wx') {
        return handle;
      }
      const writeFile = handle.writeFile.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') {
            return async (data: Buffer) => {
              await writeFile(data.subarray(0, Math.min(8, data.length)));
              throw new Error('INJECTED_WRITE_FAILURE');
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    writeFile: async (...args: any[]) => {
      const options = args[2] as { flag?: string } | undefined;
      if (!fsFaults.failExclusiveWrite || options?.flag !== 'wx') {
        return actualWriteFile(...args);
      }
      const handle = await actual.open(args[0], 'wx');
      try {
        const data = args[1] as Buffer;
        await handle.writeFile(data.subarray(0, Math.min(8, data.length)));
      } finally {
        await handle.close();
      }
      throw new Error('INJECTED_WRITE_FAILURE');
    },
  };
});

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { uploadReceipts } from '../src/receipts.js';
import { safePath, storeImage } from '../src/storage.js';
import { sampleReceipt } from './support.js';

const now = new Date(2026, 8, 3, 12, 0, 0);

describe('ordered receipt image upload', () => {
  let temp: string;
  let config: Config;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-upload-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    fsFaults.failExclusiveWrite = false;
    fsFaults.simulateExclusiveCollision = false;
    try {
      store.close();
    } catch {
      // Some failure-path tests deliberately close the real store early.
    }
    await rm(temp, { recursive: true, force: true });
  });

  it('preserves multipart order, immutable bytes, and ignores traversal names', async () => {
    const first = await patternPng(1);
    const second = await patternPng(2);

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', first, {
        filename: '../../one.png',
        contentType: 'image/png',
      })
      .attach('files', second, {
        filename: 'two.png',
        contentType: 'image/png',
      })
      .attach('files', first, {
        filename: 'renamed-copy.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(201);
    expect(
      response.body.accepted.map((receipt: Receipt) => receipt.uploadOrder),
    ).toEqual([1, 2]);
    expect(response.body.accepted).toHaveLength(2);
    expect(response.body.rejected).toEqual([
      {
        index: 2,
        code: 'EXACT_DUPLICATE',
        duplicateId: response.body.accepted[0].id,
      },
    ]);

    const receipts = response.body.accepted as Receipt[];
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      'recognizing',
      'recognizing',
    ]);
    expect(receipts[0]?.recognizedFen).toBeNull();
    expect(receipts[0]?.paidFen).toBeNull();
    expect(receipts[0]?.category).toBeNull();
    expect(receipts[0]?.original.path).not.toContain('one.png');
    expect(receipts[0]?.original.sha256).toBe(
      createHash('sha256').update(first).digest('hex'),
    );
    expect(store.get('files', receipts[0]!.original.id)).toEqual({
      id: receipts[0]!.original.id,
      ownerId: receipts[0]!.id,
      kind: 'original',
      path: receipts[0]!.original.path,
      sha256: receipts[0]!.original.sha256,
      deletedAt: null,
    });
    expect(relative(temp, safePath(temp, receipts[0]!.original.path))).not.toMatch(
      /^\.\./,
    );

    const firstImage = await request(createApp({ store, config })).get(
      `/api/images/${receipts[0]!.original.id}`,
    );
    const secondImage = await request(createApp({ store, config })).get(
      `/api/images/${receipts[1]!.original.id}`,
    );
    expect(firstImage.status).toBe(200);
    expect(firstImage.headers['content-type']).toMatch(/^image\/png/);
    expect(firstImage.body).toEqual(first);
    expect(secondImage.body).toEqual(second);
    expect(await readFile(safePath(temp, receipts[0]!.original.path))).toEqual(
      first,
    );
  });

  it('accepts exactly 50 files and rejects the 51st file at the HTTP boundary', async () => {
    const pngs = await Promise.all(
      Array.from({ length: 50 }, (_, index) => patternPng(index + 10)),
    );
    let fifty = request(createApp({ store, config })).post(
      '/api/receipts/upload',
    );
    for (let index = 0; index < 50; index += 1) {
      fifty = fifty.attach('files', pngs[index]!, `${index}.png`);
    }

    const accepted = await fifty;
    expect(accepted.status).toBe(201);
    expect(accepted.body.accepted).toHaveLength(50);
    expect(
      accepted.body.accepted.map((receipt: Receipt) => receipt.uploadOrder),
    ).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));

    const otherStore = openStore(':memory:');
    try {
      let fiftyOne = request(createApp({ store: otherStore, config })).post(
        '/api/receipts/upload',
      );
      for (let index = 0; index < 51; index += 1) {
        fiftyOne = fiftyOne.attach(
          'files',
          pngs[index % pngs.length]!,
          `${index}.png`,
        );
      }
      const rejected = await fiftyOne;
      expect(rejected.status).toBe(413);
      expect(rejected.body).not.toHaveProperty('stack');
      expect(otherStore.list('receipts')).toEqual([]);
    } finally {
      otherStore.close();
    }
  });

  it('rejects multipart text fields without processing accompanying files', async () => {
    const png = await pixelPng('#102030');
    let upload = request(createApp({ store, config })).post(
      '/api/receipts/upload',
    );
    for (let index = 0; index < 100; index += 1) {
      upload = upload.field(`unexpected-${index}`, 'x');
    }
    const response = await upload.attach('files', png, 'receipt.png');

    expect(response.status).toBe(413);
    expect(response.body).not.toHaveProperty('stack');
    expect(store.list('receipts')).toEqual([]);
    expect(await filesUnder(temp)).toEqual([]);
  });

  it('uses decoded image format instead of the claimed MIME type or extension', async () => {
    const png = await pixelPng('#445566');
    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', Buffer.from('not an image'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .attach('files', png, {
        filename: 'spoofed.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(201);
    expect(response.body.accepted).toHaveLength(1);
    expect(response.body.accepted[0].original.mime).toBe('image/png');
    expect(response.body.accepted[0].uploadOrder).toBe(1);
    expect(response.body.rejected).toEqual([{ index: 0, code: 'INVALID_IMAGE' }]);
    expect(store.list('files')).toHaveLength(1);
  });

  it('partially rejects a truncated PNG whose metadata still parses', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#135724' },
    })
      .png()
      .toBuffer();
    const truncated = png.subarray(0, png.length - 13);
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({
      format: 'png',
      width: 64,
      height: 64,
    });
    await expect(sharp(truncated).raw().toBuffer()).rejects.toThrow();

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', truncated, 'truncated.png')
      .attach('files', png, 'complete.png');

    expect(response.status).toBe(201);
    expect(response.body.rejected).toEqual([{ index: 0, code: 'INVALID_IMAGE' }]);
    expect(response.body.accepted).toHaveLength(1);
    expect(response.body.accepted[0].uploadOrder).toBe(1);
    expect(store.list('files')).toHaveLength(1);
  });

  it('rejects a file larger than 20 MiB without persisting it', async () => {
    const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1);

    await expect(
      storeImage(config, '2026-09', 'originals', {
        name: 'large.png',
        mime: 'image/png',
        bytes: tooLarge,
      }),
    ).rejects.toThrow('IMAGE_TOO_LARGE');
    expect(await filesUnder(temp)).toEqual([]);

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', tooLarge, 'large.png');
    expect(response.status).toBe(413);
    expect(store.list('receipts')).toEqual([]);
    expect(await filesUnder(temp)).toEqual([]);
  });

  it('rejects images over 40 million decoded pixels without writing bytes', async () => {
    const tooManyPixels = await sharp({
      create: {
        width: 8_001,
        height: 5_000,
        channels: 3,
        background: '#112233',
      },
    })
      .png()
      .toBuffer();

    await expect(
      storeImage(config, '2026-09', 'originals', {
        name: 'pixels.png',
        mime: 'image/png',
        bytes: tooManyPixels,
      }),
    ).rejects.toThrow('INVALID_IMAGE');
    expect(await filesUnder(temp)).toEqual([]);
  });

  it('removes a partially written file after an owned exclusive write fails', async () => {
    const png = await pixelPng('#246813');
    const sentinel = join(temp, 'keep.txt');
    await writeFile(sentinel, 'keep');
    fsFaults.failExclusiveWrite = true;

    await expect(
      storeImage(config, '2026-09', 'originals', {
        name: 'partial.png',
        mime: 'image/png',
        bytes: png,
      }),
    ).rejects.toThrow('INJECTED_WRITE_FAILURE');

    fsFaults.failExclusiveWrite = false;
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
    expect(await filesUnder(temp)).toEqual([sentinel]);
  });

  it('never removes a pre-existing path when exclusive creation collides', async () => {
    const png = await pixelPng('#abcdef');
    fsFaults.simulateExclusiveCollision = true;

    await expect(
      storeImage(config, '2026-09', 'originals', {
        name: 'collision.png',
        mime: 'image/png',
        bytes: png,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    fsFaults.simulateExclusiveCollision = false;
    const files = await filesUnder(temp);
    expect(files).toHaveLength(1);
    expect(await readFile(files[0]!, 'utf8')).toBe('pre-existing');
  });

  it('rejects an empty multipart upload and keeps health-only app isolated', async () => {
    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'EMPTY_UPLOAD',
      message: '请选择凭证图片',
    });
    expect(store.list('receipts')).toEqual([]);

    expect((await request(createApp()).get('/health')).status).toBe(200);
    expect(
      (await request(createApp()).post('/api/receipts/upload')).status,
    ).toBe(404);
  });

  it('limits JSON request bodies to 1 MiB without exposing internals', async () => {
    const response = await request(createApp())
      .post('/health')
      .send({ content: 'x'.repeat(1024 * 1024) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      code: 'BODY_TOO_LARGE',
      message: '请求内容过大',
    });
    expect(response.body).not.toHaveProperty('stack');
  });

  it('removes only the newly written orphan when a real database write fails', async () => {
    const png = await pixelPng('#778899');
    const sentinel = join(temp, 'keep.txt');
    await writeFile(sentinel, 'keep');
    store.close();

    await expect(
      uploadReceipts(
        store,
        config,
        [{ name: 'one.png', mime: 'image/png', bytes: png }],
      now,
      ),
    ).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
    expect(await filesUnder(temp)).toEqual([sentinel]);

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', png, 'two.png');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
    });
    expect(await filesUnder(temp)).toEqual([sentinel]);
  });

  it('keeps only historical evidence when rejecting an exact renamed upload', async () => {
    const png = await patternPng(80);
    const first = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', png, 'original.png');
    const prior = first.body.accepted[0] as Receipt;
    store.put('receipts', {
      ...prior,
      status: 'archived',
      archivedAt: '2026-10-01T00:00:00.000Z',
    });

    const duplicate = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', png, 'renamed.png');

    expect(duplicate.status).toBe(201);
    expect(duplicate.body.accepted).toEqual([]);
    expect(duplicate.body.rejected).toEqual([
      { index: 0, code: 'EXACT_DUPLICATE', duplicateId: prior.id },
    ]);
    expect(store.list('receipts')).toHaveLength(1);
    expect(store.list('files')).toHaveLength(1);
    expect(await filesUnder(temp)).toEqual([
      safePath(temp, prior.original.path),
    ]);

    const evidence = await request(createApp({ store, config })).get(
      `/api/images/${prior.original.id}`,
    );
    expect(evidence.status).toBe(200);
    expect(evidence.body).toEqual(png);

    const receiptEvidence = await request(createApp({ store, config })).get(
      `/api/receipts/${prior.id}/original-image`,
    );
    expect(receiptEvidence.status).toBe(200);
    expect(receiptEvidence.body).toEqual(png);
  });

  it('persists a recompressed visual match as pending without losing evidence', async () => {
    const source = await patternPng(90, 0);
    const recompressed = await sharp(source)
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(recompressed).not.toEqual(source);

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', source, 'source.png')
      .attach('files', recompressed, 'recompressed.png');

    expect(response.status).toBe(201);
    expect(response.body.rejected).toEqual([]);
    expect(response.body.accepted).toHaveLength(2);
    const [prior, suspected] = response.body.accepted as Receipt[];
    expect(prior).toMatchObject({ status: 'recognizing', duplicateIds: [] });
    expect(suspected).toMatchObject({
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: [prior!.id],
      duplicateOverride: false,
    });
    expect(store.list('files')).toHaveLength(2);
    expect(
      (
        await request(createApp({ store, config })).get(
          `/api/images/${suspected!.original.id}`,
        )
      ).body,
    ).toEqual(recompressed);
  });

  it('rechecks exact duplicates inside the persistence transaction and removes the race orphan', async () => {
    const png = await patternPng(100);
    const sha256 = createHash('sha256').update(png).digest('hex');
    const prior = sampleReceipt({
      id: 'concurrent-winner',
      original: {
        ...sampleReceipt().original,
        id: 'winner-image',
        sha256,
      },
    });
    let inserted = false;
    const racingStore: Store = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      put: store.put.bind(store),
      remove: store.remove.bind(store),
      transact: <T>(run: () => T): T => {
        if (!inserted) {
          inserted = true;
          store.put('receipts', prior);
        }
        return store.transact(run);
      },
      nextOrder: store.nextOrder.bind(store),
      recordConfirmation: store.recordConfirmation.bind(store),
      backupTo: store.backupTo.bind(store),
      close: store.close.bind(store),
    };

    const result = await uploadReceipts(
      racingStore,
      config,
      [{ name: 'loser.png', mime: 'image/png', bytes: png }],
      now,
    );

    expect(result).toEqual({
      accepted: [],
      rejected: [
        { index: 0, code: 'EXACT_DUPLICATE', duplicateId: prior.id },
      ],
    });
    expect(store.list('receipts')).toEqual([prior]);
    expect(store.list('files')).toEqual([]);
    expect(await filesUnder(temp)).toEqual([]);
  });

  it('serves only indexed live images and distinguishes deleted and missing IDs', async () => {
    const png = await pixelPng('#fedcba');
    const upload = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', png, 'one.png');
    const receipt = upload.body.accepted[0] as Receipt;
    const indexed = store.get('files', receipt.original.id)!;

    expect(
      (await request(createApp({ store, config })).get('/api/images/unknown'))
        .status,
    ).toBe(404);

    await unlink(safePath(temp, indexed.path));
    expect(
      (
        await request(createApp({ store, config })).get(
          `/api/images/${indexed.id}`,
        )
      ).status,
    ).toBe(404);

    store.put('files', {
      ...indexed,
      deletedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(
      (
        await request(createApp({ store, config })).get(
          `/api/images/${indexed.id}`,
        )
      ).status,
    ).toBe(410);
  });
});

async function pixelPng(background: string): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background },
  })
    .png()
    .toBuffer();
}

async function patternPng(
  seed: number,
  compressionLevel = 6,
): Promise<Buffer> {
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

async function filesUnder(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
