import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ImageRef } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBatch } from '../src/batches.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { renderBatchPdf } from '../src/render/pdf.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

// P-16：预览缓存/ETag 与附件降采样
describe('preview caching and attachment downscaling (P-16)', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-preview-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('serves an ETag, answers 304 on revalidation, and changes the ETag after edits', async () => {
    const original = await indexedImage('etag-original', 800, 600);
    store.put('receipts', sampleReceipt({ id: 'a', original }));
    store.put('files', {
      id: original.id, ownerId: 'a', kind: 'original',
      path: original.path, sha256: original.sha256, deletedAt: null,
    });
    const batch = createBatch(
      store, ['a'],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    store.put('batches', batch);
    const application = createApp({ store, config });

    const first = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(first.status).toBe(200);
    const etag = first.headers['etag'] as string;
    expect(etag).toMatch(/^"preview-[0-9a-f]{32}"$/);
    expect(first.headers['cache-control']).toContain('no-cache');

    const revalidated = await request(application)
      .get(`/api/batches/${batch.id}/preview.pdf`)
      .set('If-None-Match', etag);
    expect(revalidated.status).toBe(304);

    // 批次内容变化后 ETag 必须变化（缓存按内容哈希，不会命中旧内容）
    const edited = { ...batch, options: { ...batch.options, department: '新部门' } };
    store.put('batches', edited);
    const changed = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(changed.status).toBe(200);
    expect(changed.headers['etag']).not.toBe(etag);
  });

  it('downscales large originals to a fraction of their size inside the PDF', { timeout: 20000 }, async () => {
    // 2400×1800 高噪点 JPEG（长边超过 1600，足以验证降采样；比 12MP 省 CPU）
    const big = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 30 } },
    }).jpeg({ quality: 92 }).toBuffer();
    const original: ImageRef = {
      id: 'big-original',
      path: '2026-09/originals/big-original.jpg',
      mime: 'image/jpeg',
      sha256: createHash('sha256').update(big).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: big.length,
      width: 2400,
      height: 1800,
      deletedAt: null,
    };
    const path = safePath(temp, original.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, big);
    store.put('receipts', sampleReceipt({ id: 'big', original }));
    store.put('files', {
      id: original.id, ownerId: 'big', kind: 'original',
      path: original.path, sha256: original.sha256, deletedAt: null,
    });
    const batch = createBatch(
      store, ['big'],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );

    const rendered = await renderBatchPdf(store, config, batch);
    // 整份 PDF（表单页 + 附件页）必须比原图本身小得多
    expect(rendered.length).toBeLessThan(big.length / 2);
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
