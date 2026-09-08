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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { uploadReceipts } from '../src/receipts.js';
import { safePath, storeImage } from '../src/storage.js';

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
    try {
      store.close();
    } catch {
      // Some failure-path tests deliberately close the real store early.
    }
    await rm(temp, { recursive: true, force: true });
  });

  it('preserves multipart order, immutable bytes, and ignores traversal names', async () => {
    const first = await pixelPng('#123456');
    const second = await pixelPng('#abcdef');

    const response = await request(createApp({ store, config }))
      .post('/api/receipts/upload')
      .attach('files', first, {
        filename: '../../one.png',
        contentType: 'image/png',
      })
      .attach('files', second, {
        filename: 'two.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(201);
    expect(
      response.body.accepted.map((receipt: Receipt) => receipt.uploadOrder),
    ).toEqual([1, 2]);
    expect(response.body.accepted).toHaveLength(2);
    expect(response.body.rejected).toEqual([]);

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
    const png = await pixelPng('#010203');
    let fifty = request(createApp({ store, config })).post(
      '/api/receipts/upload',
    );
    for (let index = 0; index < 50; index += 1) {
      fifty = fifty.attach('files', png, `${index}.png`);
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
        fiftyOne = fiftyOne.attach('files', png, `${index}.png`);
      }
      const rejected = await fiftyOne;
      expect(rejected.status).toBe(413);
      expect(rejected.body).not.toHaveProperty('stack');
      expect(otherStore.list('receipts')).toEqual([]);
    } finally {
      otherStore.close();
    }
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

async function filesUnder(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
