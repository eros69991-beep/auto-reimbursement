import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createBatch } from '../src/batches.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { confirmReceipt, uploadReceipts } from '../src/receipts.js';
import { addRefundImage } from '../src/refunds.js';
import { exportBatchPdf } from '../src/render/pdf.js';
import { readVerifiedFile, safePath } from '../src/storage.js';

// 模拟手机拍照：JPEG + EXIF 方向与描述。去 EXIF 重编码后落盘字节必然与上传字节不同，
// 这正是 e2e 夹具（sharp 生成的 PNG，重编码后字节不变）覆盖不到的情形。
async function phoneJpeg(seed: number): Promise<Buffer> {
  const width = 320;
  const height = 240;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * (seed + 7) + seed * 31) % 251;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 88 })
    .withMetadata({ orientation: 6, exif: { IFD0: { '270': `phone-photo-${seed}` } } })
    .toBuffer();
}

describe('exporting receipts uploaded as real phone photos', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-export-photo-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('indexes the stored (EXIF-stripped) bytes so preview and export can verify them', async () => {
    const upload = await phoneJpeg(1);
    const uploaded = await uploadReceipts(
      store,
      config,
      [{ name: 'walmart.jpg', mime: 'image/jpeg', bytes: upload }],
      new Date('2026-09-26T08:00:00.000Z'),
    );
    const receipt = uploaded.accepted[0]!;
    await addRefundImage(store, config, receipt.id, {
      name: 'refund.jpg',
      mime: 'image/jpeg',
      bytes: await phoneJpeg(2),
    });
    confirmReceipt(store, receipt.id, { paidFen: 19707, category: '耗材', merchant: '沃尔玛', date: '2026-09-20' });

    // 文件索引记录的是落盘字节的哈希，完整性校验能通过；上传指纹保持不变（查重依赖它）
    const stored = store.get('receipts', receipt.id)!;
    expect(stored.original.sha256).not.toBe(stored.original.fileSha256);
    for (const entry of store.list('files')) {
      await expect(readVerifiedFile(config, entry)).resolves.toBeInstanceOf(Buffer);
    }

    const batch = createBatch(
      store,
      [receipt.id],
      { department: '武汉测试店', date: '2026-09-29', signerMode: 'text', signerName: '测试报销人甲', signature: null },
      new Date('2026-09-29T02:00:00.000Z'),
    );

    const app = createApp({ store, config });
    const preview = await request(app).get(`/api/batches/${batch.id}/preview.pdf?attachments=1`);
    expect(preview.status).toBe(200);

    const exported = await exportBatchPdf(store, config, batch.id);
    expect(exported.pdfPath).not.toBeNull();
    const pdf = await getDocument({
      data: new Uint8Array(await readFile(safePath(config.dataDir, exported.pdfPath!))),
      useSystemFonts: false,
    }).promise;
    // 1 张报销单 + 原始凭证 + 退款凭证
    expect(pdf.numPages).toBe(3);
  }, 20_000);
});
