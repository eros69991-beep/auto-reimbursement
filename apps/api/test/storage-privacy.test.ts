import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { deleteReceipt, uploadReceipts } from '../src/receipts.js';
import { safePath } from '../src/storage.js';

async function pixelJpeg(exif: boolean): Promise<Buffer> {
  const base = sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: { r: 32, g: 64, b: 96 },
    },
  }).jpeg();
  if (!exif) {
    return base.toBuffer();
  }
  // 写入 EXIF（方向 + 图像描述），模拟手机拍照带出的元数据
  return base
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { '270': 'captured-on-phone GPS: 30.5,114.3' } },
    })
    .toBuffer();
}

describe('stored image metadata (P-35)', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-meta-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('strips EXIF metadata from stored originals while keeping the upload fingerprint stable', async () => {
    const upload = await pixelJpeg(true);
    const result = await uploadReceipts(
      store,
      config,
      [{ name: 'receipt.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T08:00:00.000Z'),
    );
    expect(result.rejected).toHaveLength(0);
    const receipt = result.accepted[0]!;

    // 存盘文件不再携带 EXIF（方向、描述、GPS 等）
    const stored = await readFile(safePath(config.dataDir, receipt.original.path));
    const storedMetadata = await sharp(stored).metadata();
    expect(storedMetadata.exif).toBeUndefined();
    expect(storedMetadata.orientation).toBeUndefined();
    // 方向已转正为真实像素排列（原图声明 orientation:6，转正后宽高互换）
    expect([storedMetadata.width, storedMetadata.height].sort()).toEqual([6, 8]);

    // sha256 仍按上传原图计算：同一文件再次上传会被判为完全重复
    const again = await uploadReceipts(
      store,
      config,
      [{ name: 'receipt-copy.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T08:01:00.000Z'),
    );
    expect(again.accepted).toHaveLength(0);
    expect(again.rejected[0]).toMatchObject({ code: 'EXACT_DUPLICATE', duplicateId: receipt.id });
  });
});

describe('deleted duplicate detection (P-32)', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-dup-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('rejects a re-upload of a deleted receipt with DELETED_DUPLICATE pointing at the recycle bin entry', async () => {
    const upload = await pixelJpeg(false);
    const first = await uploadReceipts(
      store,
      config,
      [{ name: 'receipt.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T08:00:00.000Z'),
    );
    const receipt = first.accepted[0]!;
    deleteReceipt(store, receipt.id, new Date('2026-09-26T09:00:00.000Z'));

    const second = await uploadReceipts(
      store,
      config,
      [{ name: 'receipt.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T09:05:00.000Z'),
    );
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toHaveLength(1);
    expect(second.rejected[0]).toMatchObject({
      code: 'DELETED_DUPLICATE',
      duplicateId: receipt.id,
    });
  });

  it('does not report suspected duplicates against deleted receipts', async () => {
    const upload = await pixelJpeg(false);
    const first = await uploadReceipts(
      store,
      config,
      [{ name: 'receipt.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T08:00:00.000Z'),
    );
    deleteReceipt(store, first.accepted[0]!.id, new Date('2026-09-26T09:00:00.000Z'));

    // 内容几乎相同（疑似重复）的另一张图：回收站里的凭证不应参与疑似查重
    const similar = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 33, g: 64, b: 96 },
      },
    })
      .jpeg()
      .toBuffer();
    const second = await uploadReceipts(
      store,
      config,
      [{ name: 'similar.jpg', mime: 'image/jpeg', bytes: similar }],
      new Date('2026-09-26T09:05:00.000Z'),
    );
    expect(second.rejected).toHaveLength(0);
    expect(second.accepted[0]!.status).toBe('recognizing');
    expect(second.accepted[0]!.duplicateIds).toEqual([]);
  });
});
