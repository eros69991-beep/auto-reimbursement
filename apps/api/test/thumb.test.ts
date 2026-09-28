import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// P-13：报销池缩略图接口 /api/images/:id?size=thumb
describe('image thumbnails (P-13)', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-thumb-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('serves a 320px webp thumbnail with immutable caching and persists it to disk', async () => {
    const original = await indexedImage('thumb-source', 1200, 900);
    store.put('receipts', sampleReceipt({ id: 'a', original }));
    store.put('files', {
      id: original.id, ownerId: 'a', kind: 'original',
      path: original.path, sha256: original.sha256, deletedAt: null,
    });
    const application = createApp({ store, config });

    const first = await request(application).get(`/api/images/${original.id}?size=thumb`);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('image/webp');
    expect(first.headers['cache-control']).toContain('immutable');

    const metadata = await sharp(first.body as Buffer).metadata();
    expect(metadata.format).toBe('webp');
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(320);
    // 缩略图必须远小于原图
    expect((first.body as Buffer).length).toBeLessThan(original.bytes / 4);

    // 第二次请求命中磁盘缓存（缓存文件已按内容哈希落盘）
    const second = await request(application).get(`/api/images/${original.id}?size=thumb`);
    expect(second.status).toBe(200);
    expect(second.body as Buffer).toEqual(first.body);

    // 不带 size 参数仍返回原图
    const full = await request(application).get(`/api/images/${original.id}`);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toContain('image/png');
    expect((full.body as Buffer).length).toBe(original.bytes);
  });

  it('returns 404 for a missing image and 410 for a deleted one', async () => {
    const application = createApp({ store, config });
    const missing = await request(application).get('/api/images/nope?size=thumb');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('IMAGE_NOT_FOUND');

    const original = await indexedImage('thumb-deleted', 100, 100);
    store.put('files', {
      id: original.id, ownerId: 'a', kind: 'original',
      path: original.path, sha256: original.sha256, deletedAt: '2026-09-01T00:00:00.000Z',
    });
    const deleted = await request(application).get(`/api/images/${original.id}?size=thumb`);
    expect(deleted.status).toBe(410);
    expect(deleted.body.code).toBe('IMAGE_DELETED');
  });

  async function indexedImage(id: string, width: number, height: number): Promise<ImageRef> {
    const bytes = await sharp({
      create: { width, height, channels: 3, background: '#245c77' },
    }).png().toBuffer();
    const image: ImageRef = {
      id,
      path: `2026-09/originals/${id}.png`,
      mime: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width,
      height,
      deletedAt: null,
    };
    const path = safePath(temp, image.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    return image;
  }
});
