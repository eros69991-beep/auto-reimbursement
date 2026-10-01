import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ImageRef } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

const MIB = 1024 * 1024;

// 多 MB 的 Buffer 不能直接 toEqual（逐字节比对极慢），比哈希
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// 带随机纹理的像素：压缩不下去，用来做「大图」
function noisePixels(width: number, height: number, channels: 3 | 4, seed: number): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let offset = 0; offset < pixels.length; offset += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[offset] = state & 0xff;
  }
  return pixels;
}

// 压缩等级调低：噪声本来就压不动，没必要花时间
async function noisePng(width: number, height: number, seed: number): Promise<Buffer> {
  return sharp(noisePixels(width, height, 3, seed), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

// 对账页看凭证图：?size=view。大图给缩小版，小图原样返回
describe('reduced voucher image for the reconcile view', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-view-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function receiptWithImage(
    id: string,
    bytes: Buffer,
    extension: 'png' | 'jpg',
    size: { width: number; height: number },
  ): Promise<ImageRef> {
    const image: ImageRef = {
      id: `${id}-image`,
      path: `2026-09/originals/${id}-image.${extension}`,
      mime: extension === 'png' ? 'image/png' : 'image/jpeg',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width: size.width,
      height: size.height,
      deletedAt: null,
    };
    const path = safePath(temp, image.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    store.put('receipts', sampleReceipt({ id, original: image }));
    store.put('files', {
      id: image.id, ownerId: id, kind: 'original', path: image.path, sha256: image.sha256, deletedAt: null,
    });
    return image;
  }

  async function viewFiles(): Promise<string[]> {
    try {
      return (await readdir(join(temp, 'thumbs'))).filter((name) => name.endsWith('-view.jpg'));
    } catch {
      return [];
    }
  }

  it('serves a downsized JPEG for a large image, caches it on disk and leaves the original alone', async () => {
    const bytes = await noisePng(3300, 400, 1);
    expect(bytes.length).toBeGreaterThan(1.5 * MIB);
    const image = await receiptWithImage('wide', bytes, 'png', { width: 3300, height: 400 });
    const application = createApp({ store, config });

    const first = await request(application).get('/api/receipts/wide/original-image?size=view');

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('image/jpeg');
    const metadata = await sharp(first.body as Buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    // 长边压到 3200，比例不变
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 3200, height: 388 });
    expect((first.body as Buffer).length).toBeLessThan(bytes.length * 0.8);
    expect(await viewFiles()).toEqual([`${image.sha256}-view.jpg`]);

    // 第二次直接读磁盘缓存：字节一样，也没有多出别的文件
    const second = await request(application).get('/api/receipts/wide/original-image?size=view');
    expect(second.status).toBe(200);
    expect(digest(second.body as Buffer)).toBe(digest(first.body as Buffer));
    expect(await viewFiles()).toHaveLength(1);

    // 不带 size（或带别的值）仍是原图，一个字节都不变
    for (const url of ['/api/receipts/wide/original-image', '/api/receipts/wide/original-image?size=big']) {
      const original = await request(application).get(url);
      expect(original.status).toBe(200);
      expect(original.headers['content-type']).toContain('image/png');
      expect(digest(original.body as Buffer)).toBe(digest(bytes));
    }
  });

  it('serves an image that is not large as it is, without re-encoding it', async () => {
    const bytes = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#245c77' },
    }).png().toBuffer();
    await receiptWithImage('small', bytes, 'png', { width: 800, height: 600 });

    const response = await request(createApp({ store, config })).get('/api/receipts/small/original-image?size=view');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(digest(response.body as Buffer)).toBe(digest(bytes));
    expect(await viewFiles()).toEqual([]);
  });

  it('serves the original when shrinking would not save enough', async () => {
    // 已经压得很狠的 JPEG（质量 40）：按质量 82 重新编码只会更大
    const bytes = await sharp(noisePixels(3000, 2000, 3, 2), { raw: { width: 3000, height: 2000, channels: 3 } })
      .jpeg({ quality: 40 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(1.5 * MIB);
    await receiptWithImage('squeezed', bytes, 'jpg', { width: 3000, height: 2000 });

    const response = await request(createApp({ store, config })).get('/api/receipts/squeezed/original-image?size=view');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(digest(response.body as Buffer)).toBe(digest(bytes));
    expect(await viewFiles()).toEqual([]);
  });

  it('draws a transparent image on white, not black', async () => {
    // 颜色噪声、但全透明：PNG 很大，转成 JPEG 后应是一片白
    const rgba = noisePixels(2000, 1000, 4, 3);
    for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 0;
    const bytes = await sharp(rgba, { raw: { width: 2000, height: 1000, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
    expect(bytes.length).toBeGreaterThan(1.5 * MIB);
    await receiptWithImage('clear', bytes, 'png', { width: 2000, height: 1000 });

    const response = await request(createApp({ store, config })).get('/api/receipts/clear/original-image?size=view');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    const { data } = await sharp(response.body as Buffer).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((value) => value >= 250)).toBe(true);
  });

  it('falls back to the original bytes when a big file cannot be decoded', async () => {
    const bytes = Buffer.alloc(2 * MIB, 7);
    await receiptWithImage('broken', bytes, 'png', { width: 10, height: 10 });

    const response = await request(createApp({ store, config })).get('/api/receipts/broken/original-image?size=view');

    expect(response.status).toBe(200);
    expect(digest(response.body as Buffer)).toBe(digest(bytes));
    expect(await viewFiles()).toEqual([]);
  });

  it('still reports a missing receipt, a missing file and a cleaned-up original', async () => {
    const application = createApp({ store, config });
    const missing = await request(application).get('/api/receipts/nope/original-image?size=view');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RECEIPT_NOT_FOUND');

    const bytes = await noisePng(1300, 900, 4);
    const image = await receiptWithImage('gone', bytes, 'png', { width: 1300, height: 900 });
    await unlink(safePath(temp, image.path));
    const noFile = await request(application).get('/api/receipts/gone/original-image?size=view');
    expect(noFile.status).toBe(404);
    expect(noFile.body.code).toBe('IMAGE_NOT_FOUND');

    store.put('files', {
      id: image.id, ownerId: 'gone', kind: 'original', path: image.path, sha256: image.sha256,
      deletedAt: '2026-09-01T00:00:00.000Z',
    });
    const cleaned = await request(application).get('/api/receipts/gone/original-image?size=view');
    expect(cleaned.status).toBe(410);
    expect(cleaned.body.code).toBe('IMAGE_DELETED');
  });
});
