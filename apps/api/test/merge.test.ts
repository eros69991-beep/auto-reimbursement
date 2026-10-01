import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Analysis, Receipt } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AiError, type ReceiptAnalyzer } from '../src/ai/types.js';
import { cleanOriginals } from '../src/archive.js';
import { poolTotals } from '../src/batches.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { applyAnalysis } from '../src/decision.js';
import { mergeReceipts, splitReceipt, stitchImages } from '../src/merge.js';
import { createQueue, type RecognitionQueue } from '../src/queue.js';
import { listReceipts, restoreReceipt, uploadReceipts, deleteReceipt } from '../src/receipts.js';
import { fileIndexSha256, readVerifiedFile, safePath, storeImage } from '../src/storage.js';
import { sampleReceipt } from './support.js';

const now = new Date('2026-09-04T08:00:00.000Z');

type Rgb = { r: number; g: number; b: number };
const RED: Rgb = { r: 255, g: 0, b: 0 };
const GREEN: Rgb = { r: 0, g: 160, b: 0 };
const BLUE: Rgb = { r: 0, g: 0, b: 255 };
const GAP = [138, 138, 138];

async function solid(
  width: number,
  height: number,
  color: Rgb,
  format: 'png' | 'jpeg' = 'png',
  alpha = 1,
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 4, background: { ...color, alpha } },
  });
  return format === 'png' ? image.png().toBuffer() : image.jpeg({ quality: 95 }).toBuffer();
}

// 纯色图的感知哈希都一样，会被当成疑似重复；上传类测试用带随机纹理的图
async function noise(width: number, height: number, seed: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let offset = 0; offset < pixels.length; offset += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[offset] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function pixel(bytes: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
}

function near(actual: number[], expected: number[], tolerance = 6): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

const incompleteAnalysis: Analysis = {
  amount: null,
  category: '百慕达食材',
  merchant: '武汉仓',
  date: '2026-09-03',
  confidence: { amount: 0.2, category: 0.9 },
  ambiguous: false,
  keywords: ['武汉仓'],
  evidence: '商品清单',
  incomplete: true,
};

const fullAnalysis: Analysis = {
  amount: '588.00',
  category: '百慕达食材',
  merchant: '武汉仓',
  date: '2026-09-03',
  confidence: { amount: 0.99, category: 0.98 },
  ambiguous: false,
  keywords: ['武汉仓'],
  evidence: '实付 588.00',
};

describe('stitchImages', () => {
  it('puts the screenshots side by side at one height with a gray gap', async () => {
    const stitched = await stitchImages([
      await solid(100, 200, RED),
      await solid(150, 100, BLUE),
    ]);

    expect(stitched.mime).toBe('image/png');
    const metadata = await sharp(stitched.bytes).metadata();
    // 蓝色那张放大到 200 高：150x100 → 300x200；加 6px 分隔线
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 406, height: 200 });
    expect(await pixel(stitched.bytes, 50, 100)).toEqual([255, 0, 0]);
    expect(await pixel(stitched.bytes, 102, 100)).toEqual(GAP);
    expect(await pixel(stitched.bytes, 250, 100)).toEqual([0, 0, 255]);
    expect(await pixel(stitched.bytes, 405, 199)).toEqual([0, 0, 255]);
  });

  it('keeps three screenshots in the given order', async () => {
    const stitched = await stitchImages([
      await solid(100, 100, RED),
      await solid(100, 100, GREEN),
      await solid(100, 100, BLUE),
    ]);

    const metadata = await sharp(stitched.bytes).metadata();
    expect(metadata.width).toBe(312);
    expect(await pixel(stitched.bytes, 50, 50)).toEqual([255, 0, 0]);
    expect(await pixel(stitched.bytes, 156, 50)).toEqual([0, 160, 0]);
    expect(await pixel(stitched.bytes, 262, 50)).toEqual([0, 0, 255]);
  });

  it('caps the height at 2800px', async () => {
    const stitched = await stitchImages([
      await solid(1000, 5000, RED),
      await solid(1000, 3000, BLUE),
    ]);

    const metadata = await sharp(stitched.bytes).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 1499, height: 2800 });
  });

  it('shrinks very wide results so the whole image stays under 8400px wide', async () => {
    const stitched = await stitchImages([
      await solid(4000, 1000, RED),
      await solid(4000, 1000, GREEN),
      await solid(4000, 1000, BLUE),
    ]);

    const metadata = await sharp(stitched.bytes).metadata();
    expect(metadata.width).toBeLessThanOrEqual(8400);
    expect(metadata.width).toBeGreaterThan(8300);
    expect(metadata.height).toBe(699);
  });

  it('draws transparent screenshots on white, not black', async () => {
    const stitched = await stitchImages([
      await solid(50, 50, RED, 'png', 0),
      await solid(50, 50, BLUE),
    ]);

    expect(await pixel(stitched.bytes, 25, 25)).toEqual([255, 255, 255]);
  });

  it('outputs JPEG as soon as one source is not a PNG', async () => {
    const stitched = await stitchImages([
      await solid(100, 100, RED, 'jpeg'),
      await solid(100, 100, BLUE),
    ]);

    expect(stitched.mime).toBe('image/jpeg');
    expect((await sharp(stitched.bytes).metadata()).format).toBe('jpeg');
    expect(near(await pixel(stitched.bytes, 50, 50), [255, 0, 0])).toBe(true);
    expect(near(await pixel(stitched.bytes, 156, 50), [0, 0, 255])).toBe(true);
  });

  it('sizes a rotated (EXIF) photo by how it will be displayed', async () => {
    const sideways = await sharp(await solid(200, 100, RED, 'jpeg'))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const stitched = await stitchImages([sideways, await solid(100, 200, BLUE)]);

    // 转正后是 100x200，两张等高：100 + 6 + 100
    const metadata = await sharp(stitched.bytes).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 206, height: 200 });
  });

  it('rejects bytes that are not an image', async () => {
    await expect(
      stitchImages([Buffer.from('not an image'), await solid(10, 10, RED)]),
    ).rejects.toThrow();
  });

  describe('panels', () => {
    it('reports where each screenshot sits so a viewer can show them one at a time', async () => {
      const stitched = await stitchImages([
        await solid(100, 200, RED),
        await solid(150, 100, BLUE),
      ]);

      // 红 100 宽；蓝 150x100 放大到 200 高后 300 宽，起点在 100 + 6（分隔线）
      expect(stitched.panels).toEqual([
        { left: 0, width: 100 },
        { left: 106, width: 300 },
      ]);
      // 位置和实际像素对得上：每张的两端都是自己的颜色，缝是灰色，不属于任何一张
      expect(await pixel(stitched.bytes, 0, 0)).toEqual([255, 0, 0]);
      expect(await pixel(stitched.bytes, 99, 0)).toEqual([255, 0, 0]);
      expect(await pixel(stitched.bytes, 100, 0)).toEqual(GAP);
      expect(await pixel(stitched.bytes, 105, 0)).toEqual(GAP);
      expect(await pixel(stitched.bytes, 106, 0)).toEqual([0, 0, 255]);
      expect(await pixel(stitched.bytes, 405, 0)).toEqual([0, 0, 255]);
    });

    it('keeps three screenshots in the order they were given', async () => {
      const stitched = await stitchImages([
        await solid(100, 100, RED),
        await solid(100, 100, GREEN),
        await solid(100, 100, BLUE),
      ]);

      expect(stitched.panels).toEqual([
        { left: 0, width: 100 },
        { left: 106, width: 100 },
        { left: 212, width: 100 },
      ]);
    });

    it('measures a rotated (EXIF) photo by how it is displayed', async () => {
      const sideways = await sharp(await solid(200, 100, RED, 'jpeg'))
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();

      const stitched = await stitchImages([sideways, await solid(100, 200, BLUE)]);

      expect(stitched.panels).toEqual([
        { left: 0, width: 100 },
        { left: 106, width: 100 },
      ]);
    });

    it('still lines up with the pixels after a very wide result is shrunk', async () => {
      const stitched = await stitchImages([
        await solid(4000, 1000, RED),
        await solid(4000, 1000, GREEN),
        await solid(4000, 1000, BLUE),
      ]);

      const { data, info } = await sharp(stitched.bytes)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (x: number): number[] => {
        const offset = (Math.floor(info.height / 2) * info.width + x) * info.channels;
        return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      };
      const [first, second, third] = stitched.panels;
      // 最后一张正好到图的右边缘：没有多出来的空白，也没有溢出
      expect(third!.left + third!.width).toBe(info.width);
      expect(at(first!.left)).toEqual([255, 0, 0]);
      expect(at(first!.left + first!.width - 1)).toEqual([255, 0, 0]);
      expect(at(first!.left + first!.width)).toEqual(GAP);
      expect(at(second!.left - 1)).toEqual(GAP);
      expect(at(second!.left)).toEqual([0, 160, 0]);
      expect(at(second!.left + second!.width - 1)).toEqual([0, 160, 0]);
      expect(at(third!.left)).toEqual([0, 0, 255]);
      expect(at(third!.left + third!.width - 1)).toEqual([0, 0, 255]);
    });

    it('also reports the panels when the result falls back to JPEG', async () => {
      const stitched = await stitchImages([
        await solid(100, 100, RED, 'jpeg'),
        await solid(100, 100, BLUE),
      ]);

      expect(stitched.mime).toBe('image/jpeg');
      expect(stitched.panels).toEqual([
        { left: 0, width: 100 },
        { left: 106, width: 100 },
      ]);
    });
  });
});

describe('merging and splitting receipts', () => {
  let temp: string;
  let config: Config;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-merge-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function source(
    id: string,
    order: number,
    bytes: Buffer,
    overrides: Partial<Receipt> = {},
  ): Promise<Receipt> {
    const original = await storeImage(config, '2026-09', 'originals', {
      name: `${id}.png`,
      mime: 'image/png',
      bytes,
    });
    const receipt = sampleReceipt({
      id,
      original,
      uploadOrder: order,
      uploadedAt: `2026-09-03T00:0${order}:00.000Z`,
      status: 'pending',
      pendingReasons: ['amount_uncertain'],
      analysis: incompleteAnalysis,
      recognizedFen: null,
      paidFen: null,
      category: '百慕达食材',
      merchant: '武汉仓',
      date: '2026-09-03',
      ...overrides,
    });
    store.transact(() => {
      store.put('receipts', receipt);
      store.put('files', {
        id: original.id,
        ownerId: receipt.id,
        kind: 'original',
        path: original.path,
        sha256: fileIndexSha256(original),
        deletedAt: null,
      });
    });
    return receipt;
  }

  async function originalFiles(): Promise<string[]> {
    try {
      return (await readdir(join(temp, '2026-09', 'originals'))).sort();
    } catch {
      return [];
    }
  }

  async function pair(): Promise<{ left: Receipt; right: Receipt; leftBytes: Buffer; rightBytes: Buffer }> {
    const leftBytes = await solid(300, 600, RED);
    const rightBytes = await solid(300, 400, BLUE);
    const left = await source('left', 3, leftBytes);
    const right = await source('right', 5, rightBytes);
    return { left, right, leftBytes, rightBytes };
  }

  describe('mergeReceipts', () => {
    it('stitches the sources into a new receipt that is recognized again', async () => {
      const { left, right } = await pair();

      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      expect(merged).toMatchObject({
        status: 'recognizing',
        mergedFrom: ['left', 'right'],
        analysis: null,
        paidFen: null,
        category: null,
        batchId: null,
        deletedAt: null,
        month: '2026-09',
        uploadOrder: 3,
        refundFen: 0,
      });
      expect(store.get('receipts', merged.id)).toEqual(merged);

      // 拼出来的图：600 高，左 300 + 6 + 右（400→600 高后 450 宽）
      expect({ width: merged.original.width, height: merged.original.height }).toEqual({
        width: 756,
        height: 600,
      });
      const entry = store.get('files', merged.original.id)!;
      expect(entry).toMatchObject({ ownerId: merged.id, kind: 'original', deletedAt: null });
      const bytes = await readVerifiedFile(config, entry);
      expect(await pixel(bytes, 150, 300)).toEqual([255, 0, 0]);
      expect(await pixel(bytes, 303, 300)).toEqual(GAP);
      expect(await pixel(bytes, 500, 300)).toEqual([0, 0, 255]);
    });

    it('records where each screenshot sits in the stitched image, and keeps that when stored', async () => {
      const { left, right } = await pair();

      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      // 左 300 宽；右 300x400 放大到 600 高后 450 宽，起点 300 + 6。对账时据此一张一张看
      expect(merged.original.panels).toEqual([
        { left: 0, width: 300 },
        { left: 306, width: 450 },
      ]);
      expect(store.get('receipts', merged.id)?.original.panels).toEqual(merged.original.panels);
      // 来源截图本身是单张图，没有分屏信息
      expect(store.get('receipts', 'left')?.original.panels).toBeUndefined();
    });

    it('hides the sources without touching their data, files or other receipts', async () => {
      const { left, right } = await pair();
      const bystander = await source('bystander', 4, await solid(50, 50, GREEN), {
        status: 'ready',
        pendingReasons: [],
        paidFen: 100,
        recognizedFen: 100,
      });
      const filesBefore = await originalFiles();

      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      expect(store.get('receipts', 'left')).toEqual({
        ...left,
        deletedAt: now.toISOString(),
        mergedInto: merged.id,
      });
      expect(store.get('receipts', 'right')).toEqual({
        ...right,
        deletedAt: now.toISOString(),
        mergedInto: merged.id,
      });
      expect(store.get('receipts', 'bystander')).toEqual(bystander);
      // 来源截图的文件还在，合并只多出拼好的那一张
      expect(await originalFiles()).toEqual(
        [...filesBefore, `${merged.original.id}.png`].sort(),
      );
      expect(store.get('files', left.original.id)?.deletedAt).toBeNull();
    });

    it('shows the merged receipt in the pending list and the sources nowhere', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      expect(listReceipts(store, 'pending').map((receipt) => receipt.id)).toEqual([merged.id]);
      expect(listReceipts(store, 'pool')).toEqual([]);
      // 被合并隐藏的来源不算「已删除」，不会出现在回收站
      expect(listReceipts(store, 'deleted')).toEqual([]);
      expect(listReceipts(store, 'excluded')).toEqual([]);
    });

    it('uses the order the caller gives, and the earliest upload time and position', async () => {
      const first = await source('first', 5, await solid(100, 100, RED), {
        uploadedAt: '2026-09-03T01:00:00.000Z',
      });
      const second = await source('second', 3, await solid(100, 100, BLUE), {
        uploadedAt: '2026-09-03T00:00:00.000Z',
      });

      const merged = await mergeReceipts(store, config, [first.id, second.id], now);

      // 左右顺序按请求里的来，位置和上传时间取最早的
      expect(merged.mergedFrom).toEqual(['first', 'second']);
      expect(merged.uploadOrder).toBe(3);
      expect(merged.uploadedAt).toBe('2026-09-03T00:00:00.000Z');
      const bytes = await readVerifiedFile(config, store.get('files', merged.original.id)!);
      expect(await pixel(bytes, 50, 50)).toEqual([255, 0, 0]);
      expect(await pixel(bytes, 156, 50)).toEqual([0, 0, 255]);
    });

    it('can merge three receipts, including ones already in the pool', async () => {
      const a = await source('a', 1, await solid(100, 100, RED));
      const b = await source('b', 2, await solid(100, 100, GREEN), {
        status: 'ready',
        pendingReasons: [],
        analysis: fullAnalysis,
        paidFen: 58800,
        recognizedFen: 58800,
      });
      const c = await source('c', 3, await solid(100, 100, BLUE));

      const merged = await mergeReceipts(store, config, [a.id, b.id, c.id], now);

      expect(merged.mergedFrom).toEqual(['a', 'b', 'c']);
      expect(merged.original.width).toBe(312);
      expect(listReceipts(store, 'pool')).toEqual([]);
      expect(poolTotals(store.list('receipts')).count).toBe(0);
    });

    it.each([
      ['one receipt', ['left']],
      ['four receipts', ['left', 'right', 'a', 'b']],
      ['the same receipt twice', ['left', 'left']],
      ['nothing', []],
    ])('refuses %s', async (_name, ids) => {
      await pair();
      const filesBefore = await originalFiles();

      await expect(mergeReceipts(store, config, ids, now)).rejects.toThrow('INVALID_MERGE');
      expect(await originalFiles()).toEqual(filesBefore);
    });

    it('refuses an unknown receipt', async () => {
      const { left } = await pair();
      await expect(mergeReceipts(store, config, [left.id, 'ghost'], now)).rejects.toThrow('NOT_FOUND');
    });

    it('refuses receipts that are still being recognized', async () => {
      const { left, right } = await pair();
      store.put('receipts', { ...right, status: 'recognizing', analysis: null });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_NOT_READY',
      );
    });

    it.each<[string, Partial<Receipt>]>([
      ['deleted', { deletedAt: '2026-09-04T00:00:00.000Z' }],
      ['in a batch', { status: 'generated', batchId: 'batch-1' }],
      ['archived', { status: 'archived', archivedAt: '2026-09-04T00:00:00.000Z' }],
      ['refunded', { refundFen: 100 }],
      ['already merged', { mergedFrom: ['x', 'y'] }],
      ['hidden by an earlier merge', { mergedInto: 'other', deletedAt: '2026-09-04T00:00:00.000Z' }],
    ])('refuses a receipt that is %s', async (_name, overrides) => {
      const { left, right } = await pair();
      store.put('receipts', { ...right, ...overrides });
      const filesBefore = await originalFiles();

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_NOT_ALLOWED',
      );
      expect(await originalFiles()).toEqual(filesBefore);
      expect(store.get('receipts', left.id)).toEqual(left);
    });

    it('refuses a receipt whose original image was cleaned up', async () => {
      const { left, right } = await pair();
      store.put('receipts', {
        ...right,
        original: { ...right.original, deletedAt: '2026-09-04T00:00:00.000Z' },
      });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_NOT_ALLOWED',
      );
    });

    it('refuses when an image file is missing or does not match its checksum', async () => {
      const { left, right } = await pair();
      const filesBefore = await originalFiles();

      await unlink(safePath(config.dataDir, right.original.path));
      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_IMAGE_MISSING',
      );

      await writeFile(safePath(config.dataDir, right.original.path), Buffer.from('tampered'));
      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_IMAGE_MISSING',
      );
      expect((await originalFiles()).length).toBe(filesBefore.length);
      expect(store.get('receipts', left.id)?.deletedAt).toBeNull();
    });

    it('refuses when the file index entry belongs to someone else', async () => {
      const { left, right } = await pair();
      store.put('files', { ...store.get('files', right.original.id)!, ownerId: 'someone-else' });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_IMAGE_MISSING',
      );
    });

    it('removes the stitched image again when saving fails', async () => {
      const { left, right } = await pair();
      const filesBefore = await originalFiles();
      vi.spyOn(store, 'transact').mockImplementation(() => {
        throw new Error('DISK_FULL');
      });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow('DISK_FULL');

      vi.restoreAllMocks();
      expect(await originalFiles()).toEqual(filesBefore);
      expect(store.get('receipts', left.id)?.deletedAt).toBeNull();
    });

    it('checks the receipts again when saving: a receipt deleted meanwhile blocks the merge', async () => {
      const { left, right } = await pair();
      const filesBefore = await originalFiles();
      const realTransact = store.transact.bind(store);
      vi.spyOn(store, 'transact').mockImplementation((work) => {
        // 拼图期间有人把右边那张删了
        store.put('receipts', { ...right, deletedAt: '2026-09-04T07:59:00.000Z' });
        return realTransact(work);
      });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_NOT_ALLOWED',
      );

      vi.restoreAllMocks();
      expect(await originalFiles()).toEqual(filesBefore);
      expect(store.get('receipts', left.id)).toEqual(left);
      expect(store.list('receipts').filter((receipt) => receipt.mergedFrom !== undefined)).toEqual([]);
    });

    it('checks the receipts again when saving: a replaced image blocks the merge', async () => {
      const { left, right } = await pair();
      const realTransact = store.transact.bind(store);
      vi.spyOn(store, 'transact').mockImplementation((work) => {
        store.put('receipts', { ...right, original: { ...right.original, id: 'another-image' } });
        return realTransact(work);
      });

      await expect(mergeReceipts(store, config, [left.id, right.id], now)).rejects.toThrow(
        'MERGE_NOT_ALLOWED',
      );
    });
  });

  describe('splitReceipt', () => {
    it('brings the sources back exactly as they were and removes the merged receipt', async () => {
      const { left, right } = await pair();
      const filesBefore = await originalFiles();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      const restored = await splitReceipt(store, config, merged.id);

      expect(restored).toEqual([left, right]);
      expect(store.get('receipts', 'left')).toEqual(left);
      expect(store.get('receipts', 'right')).toEqual(right);
      expect(store.get('receipts', merged.id)).toBeNull();
      expect(store.get('files', merged.original.id)).toBeNull();
      expect(await originalFiles()).toEqual(filesBefore);
      expect(listReceipts(store, 'pending').map((receipt) => receipt.id)).toEqual(['left', 'right']);
    });

    it('splits a merged receipt that has already been recognized or edited', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      store.put('receipts', {
        ...merged,
        status: 'ready',
        analysis: fullAnalysis,
        paidFen: 58800,
        recognizedFen: 58800,
        pendingReasons: [],
      });

      const restored = await splitReceipt(store, config, merged.id);

      expect(restored.map((receipt) => receipt.id)).toEqual(['left', 'right']);
      expect(listReceipts(store, 'pool')).toEqual([]);
    });

    it('can merge the same screenshots again after splitting', async () => {
      const { left, right } = await pair();
      const first = await mergeReceipts(store, config, [left.id, right.id], now);
      await splitReceipt(store, config, first.id);

      const second = await mergeReceipts(store, config, [right.id, left.id], now);

      expect(second.mergedFrom).toEqual(['right', 'left']);
      expect(second.id).not.toBe(first.id);
    });

    it('refuses things that are not merged receipts', async () => {
      const { left } = await pair();

      await expect(splitReceipt(store, config, 'ghost')).rejects.toThrow('NOT_FOUND');
      await expect(splitReceipt(store, config, left.id)).rejects.toThrow('NOT_MERGED');
    });

    it.each<[string, Partial<Receipt>, string]>([
      ['in a batch', { status: 'generated', batchId: 'batch-1' }, 'IMMUTABLE_RECEIPT'],
      ['archived', { status: 'archived', archivedAt: '2026-09-05T00:00:00.000Z' }, 'IMMUTABLE_RECEIPT'],
      ['in the recycle bin', { deletedAt: '2026-09-05T00:00:00.000Z' }, 'IMMUTABLE_RECEIPT'],
      ['refunded', { refundFen: 100 }, 'SPLIT_HAS_REFUND'],
    ])('refuses to split a merged receipt that is %s', async (_name, overrides, code) => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      store.put('receipts', { ...merged, ...overrides });

      await expect(splitReceipt(store, config, merged.id)).rejects.toThrow(code);
      expect(store.get('receipts', 'left')?.mergedInto).toBe(merged.id);
      expect(store.get('files', merged.original.id)).not.toBeNull();
    });

    it('refuses when a source record is missing or points elsewhere', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      store.put('receipts', { ...store.get('receipts', 'right')!, mergedInto: 'someone-else' });

      await expect(splitReceipt(store, config, merged.id)).rejects.toThrow('SPLIT_SOURCES_MISSING');
      store.remove('receipts', 'right');
      await expect(splitReceipt(store, config, merged.id)).rejects.toThrow('SPLIT_SOURCES_MISSING');
      expect(store.get('receipts', merged.id)).not.toBeNull();
    });

    it('refuses when a source original was already cleaned up', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      const hidden = store.get('receipts', 'left')!;
      store.put('receipts', {
        ...hidden,
        original: { ...hidden.original, deletedAt: '2026-09-05T00:00:00.000Z' },
      });

      await expect(splitReceipt(store, config, merged.id)).rejects.toThrow('ORIGINAL_CLEANED');
      expect(store.get('receipts', merged.id)).not.toBeNull();
    });
  });

  describe('re-uploading a merged screenshot', () => {
    it('says it was merged, then points at the recycle bin, then at the restored original', async () => {
      const { left, right, leftBytes } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      const filesWithMerged = await originalFiles();

      const whileMerged = await uploadReceipts(
        store,
        config,
        [{ name: 'again.png', mime: 'image/png', bytes: leftBytes }],
        now,
      );
      expect(whileMerged.accepted).toEqual([]);
      expect(whileMerged.rejected).toEqual([
        { index: 0, code: 'MERGED_DUPLICATE', duplicateId: merged.id },
      ]);
      // 被拒绝的文件不留在磁盘上
      expect(await originalFiles()).toEqual(filesWithMerged);

      deleteReceipt(store, merged.id, now);
      const whileDeleted = await uploadReceipts(
        store,
        config,
        [{ name: 'again.png', mime: 'image/png', bytes: leftBytes }],
        now,
      );
      expect(whileDeleted.rejected).toEqual([
        { index: 0, code: 'DELETED_DUPLICATE', duplicateId: merged.id },
      ]);

      // 把合并后的凭证恢复出来再拆开：来源截图重新成为普通凭证，重复上传就是普通的「重复文件」
      restoreReceipt(store, merged.id);
      await splitReceipt(store, config, merged.id);
      const afterSplit = await uploadReceipts(
        store,
        config,
        [{ name: 'again.png', mime: 'image/png', bytes: leftBytes }],
        now,
      );
      expect(afterSplit.rejected).toEqual([
        { index: 0, code: 'EXACT_DUPLICATE', duplicateId: 'left' },
      ]);
    });

    it('does not let a hidden source be restored or deleted on its own', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);

      expect(() => restoreReceipt(store, left.id)).toThrow('MERGED_RECEIPT');
      expect(() => deleteReceipt(store, left.id, now)).toThrow('IMMUTABLE_RECEIPT');
      expect(store.get('receipts', left.id)?.mergedInto).toBe(merged.id);

      // 合并后的凭证没了（数据异常）时，才按普通凭证恢复
      store.remove('receipts', merged.id);
      const restored = restoreReceipt(store, left.id);
      expect(restored.deletedAt).toBeNull();
      expect(restored.mergedInto).toBeUndefined();
    });
  });

  describe('cleaning up originals', () => {
    it('also removes the hidden source screenshots of an archived merged receipt', async () => {
      const { left, right } = await pair();
      const merged = await mergeReceipts(store, config, [left.id, right.id], now);
      const mergedFile = store.get('files', merged.original.id)!;
      const pdfBytes = Buffer.from('%PDF-1.7 saved batch');
      const pdfPath = '2026-09/exports/merged.pdf';
      await mkdir(join(temp, '2026-09', 'exports'), { recursive: true });
      await writeFile(safePath(config.dataDir, pdfPath), pdfBytes);
      const archived: Receipt = {
        ...store.get('receipts', merged.id)!,
        status: 'archived',
        archivedAt: '2026-09-10T00:00:00.000Z',
        batchId: 'batch-1',
        category: '百慕达食材',
        paidFen: 58800,
        recognizedFen: 58800,
      };
      store.put('receipts', archived);
      store.put('batches', {
        id: 'batch-1',
        month: '2026-09',
        createdAt: '2026-09-09T00:00:00.000Z',
        totalFen: 58800,
        items: [
          {
            receiptId: archived.id,
            uploadOrder: archived.uploadOrder,
            category: '百慕达食材',
            paidFen: 58800,
            refundFen: 0,
            netFen: 58800,
            original: archived.original,
            refundImages: [],
          },
        ],
        sheets: [],
        options: { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
        notes: [],
        pdfPath,
        archivedAt: archived.archivedAt,
      });
      store.put('files', {
        id: 'batch-pdf',
        ownerId: 'batch-1',
        kind: 'pdf',
        path: pdfPath,
        sha256: createHash('sha256').update(pdfBytes).digest('hex'),
        deletedAt: null,
      });

      const result = await cleanOriginals(store, config, '2026-09', 'DELETE ORIGINALS 2026-09');

      // 张数只数报销单里的凭证，来源截图是它们的一部分
      expect(result.affected).toBe(1);
      expect(await originalFiles()).toEqual([]);
      for (const id of ['left', 'right']) {
        const hidden = store.get('receipts', id)!;
        expect(hidden.original.deletedAt).not.toBeNull();
        expect(store.get('files', hidden.original.id)?.deletedAt).not.toBeNull();
      }
      expect(store.get('files', mergedFile.id)?.deletedAt).not.toBeNull();
      // 重复清理不会出错
      await expect(
        cleanOriginals(store, config, '2026-09', 'DELETE ORIGINALS 2026-09'),
      ).resolves.toEqual({ affected: 0 });
    });
  });
});

describe('merge routes', () => {
  let temp: string;
  let config: Config;
  let store: Store;
  let enqueued: string[][];
  let queue: RecognitionQueue;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-merge-routes-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
    enqueued = [];
    queue = {
      start: () => undefined,
      enqueue: (ids) => {
        enqueued.push(ids);
      },
      drain: async () => undefined,
      stop: async () => undefined,
    };
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function upload(app: ReturnType<typeof createApp>, images: Buffer[]): Promise<Receipt[]> {
    let call = request(app).post('/api/receipts/upload');
    for (const [index, bytes] of images.entries()) {
      call = call.attach('files', bytes, { filename: `${index}.png`, contentType: 'image/png' });
    }
    const response = await call;
    expect(response.status).toBe(201);
    return response.body.accepted as Receipt[];
  }

  function finishRecognition(receipts: Receipt[], analysis: Analysis): void {
    for (const receipt of receipts) applyAnalysis(store, receipt.id, analysis);
  }

  it('merges two uploaded screenshots into one receipt and queues it for recognition', async () => {
    const app = createApp({ store, config, queue });
    const accepted = await upload(app, [await noise(120, 300, 1), await noise(120, 200, 2)]);
    finishRecognition(accepted, incompleteAnalysis);
    enqueued.length = 0;

    const response = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: accepted.map((receipt) => receipt.id) });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'recognizing',
      mergedFrom: accepted.map((receipt) => receipt.id),
    });
    expect(enqueued).toEqual([[response.body.id]]);

    const pending = await request(app).get('/api/receipts?view=pending');
    expect(pending.body.map((receipt: Receipt) => receipt.id)).toEqual([response.body.id]);
    const image = await request(app).get(`/api/receipts/${response.body.id}/original-image`);
    expect(image.status).toBe(200);
    expect((await sharp(image.body).metadata()).width).toBe(120 + 6 + 180);
  });

  it('answers bad requests with the matching error', async () => {
    const app = createApp({ store, config, queue });
    const accepted = await upload(app, [await noise(50, 50, 3), await noise(50, 50, 4)]);

    for (const body of [{}, { receiptIds: 'a' }, { receiptIds: [1, 2] }, { receiptIds: [accepted[0]!.id] }]) {
      const response = await request(app).post('/api/receipts/merge').send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_MERGE');
    }
    const ghost = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: [accepted[0]!.id, 'ghost'] });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('RECEIPT_NOT_FOUND');
    const notReady = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: accepted.map((receipt) => receipt.id) });
    expect(notReady.status).toBe(409);
    expect(notReady.body.code).toBe('MERGE_NOT_READY');
    expect(enqueued).toEqual([accepted.map((receipt) => receipt.id)]);
  });

  it('splits a merged receipt back into its screenshots', async () => {
    const app = createApp({ store, config, queue });
    const accepted = await upload(app, [await noise(50, 50, 3), await noise(50, 50, 4)]);
    finishRecognition(accepted, incompleteAnalysis);
    const merged = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: accepted.map((receipt) => receipt.id) });

    const response = await request(app).post(`/api/receipts/${merged.body.id}/split`);

    expect(response.status).toBe(200);
    expect(response.body.map((receipt: Receipt) => receipt.id)).toEqual(
      accepted.map((receipt) => receipt.id),
    );
    expect(response.body.every((receipt: Receipt) => receipt.deletedAt === null)).toBe(true);
    const pending = await request(app).get('/api/receipts?view=pending');
    expect(pending.body.map((receipt: Receipt) => receipt.id)).toEqual(
      accepted.map((receipt) => receipt.id),
    );

    const again = await request(app).post(`/api/receipts/${merged.body.id}/split`);
    expect(again.status).toBe(404);
    const notMerged = await request(app).post(`/api/receipts/${accepted[0]!.id}/split`);
    expect(notMerged.status).toBe(409);
    expect(notMerged.body.code).toBe('NOT_MERGED');
  });

  it('reports a re-uploaded screenshot as already merged', async () => {
    const app = createApp({ store, config, queue });
    const leftBytes = await noise(50, 50, 5);
    const accepted = await upload(app, [leftBytes, await noise(50, 50, 6)]);
    finishRecognition(accepted, incompleteAnalysis);
    const merged = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: accepted.map((receipt) => receipt.id) });

    const response = await request(app)
      .post('/api/receipts/upload')
      .attach('files', leftBytes, { filename: 'again.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.rejected).toEqual([
      { index: 0, code: 'MERGED_DUPLICATE', duplicateId: merged.body.id },
    ]);
    const hiddenRestore = await request(app).post(`/api/receipts/${accepted[0]!.id}/restore`);
    expect(hiddenRestore.status).toBe(409);
    expect(hiddenRestore.body.code).toBe('MERGED_RECEIPT');
  });
});

describe('recognizing a merged receipt', () => {
  let temp: string;
  let config: Config;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-merge-ai-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function mergeTwo(analyzer: ReceiptAnalyzer): Promise<{
    mergedId: string;
    queue: RecognitionQueue;
    leftId: string;
  }> {
    const queue = createQueue({
      store,
      config,
      analyzer,
      onAnalyzed: (id, result) => applyAnalysis(store, id, result),
    });
    const app = createApp({ store, config, queue });
    const accepted = (
      await request(app)
        .post('/api/receipts/upload')
        .attach('files', await noise(120, 300, 7), { filename: 'a.png', contentType: 'image/png' })
        .attach('files', await noise(120, 300, 8), { filename: 'b.png', contentType: 'image/png' })
    ).body.accepted as Receipt[];
    for (const receipt of accepted) applyAnalysis(store, receipt.id, incompleteAnalysis);
    const merged = await request(app)
      .post('/api/receipts/merge')
      .send({ receiptIds: accepted.map((receipt) => receipt.id) });
    return { mergedId: merged.body.id as string, queue, leftId: accepted[0]!.id };
  }

  it('sends the stitched image to the analyzer and uses the result for the single receipt', async () => {
    const seen: Buffer[] = [];
    const { mergedId, queue } = await mergeTwo({
      analyzeReceipt: async (image) => {
        seen.push(image.bytes);
        return fullAnalysis;
      },
    });
    queue.start();

    await queue.drain();
    await queue.stop();

    expect(seen).toHaveLength(1);
    const metadata = await sharp(seen[0]).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 246, height: 300 });
    expect(store.get('receipts', mergedId)).toMatchObject({
      status: 'ready',
      paidFen: 58800,
      category: '百慕达食材',
      analysis: fullAnalysis,
    });
    expect(listReceipts(store, 'pool').map((receipt) => receipt.id)).toEqual([mergedId]);
    expect(poolTotals(store.list('receipts')).count).toBe(1);
  });

  it('keeps the receipt pending when the stitched image is still incomplete', async () => {
    const { mergedId, queue } = await mergeTwo({
      analyzeReceipt: async () => ({ ...incompleteAnalysis, orderNo: 'A123' }),
    });
    queue.start();

    await queue.drain();
    await queue.stop();

    expect(store.get('receipts', mergedId)).toMatchObject({
      status: 'pending',
      pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
      analysis: { incomplete: true, orderNo: 'A123' },
    });
  });

  it('marks the merged receipt as failed after the retries, and the sources can still be split', async () => {
    vi.useFakeTimers();
    try {
      const { mergedId, queue, leftId } = await mergeTwo({
        analyzeReceipt: async () => {
          throw new AiError('AUTH', false);
        },
      });
      queue.start();
      await queue.drain();
      await queue.stop();

      expect(store.get('receipts', mergedId)).toMatchObject({
        status: 'pending',
        pendingReasons: ['api_failed'],
      });
      const restored = await splitReceipt(store, config, mergedId);
      expect(restored[0]!.id).toBe(leftId);
    } finally {
      vi.useRealTimers();
    }
  });
});
