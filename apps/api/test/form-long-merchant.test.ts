import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FileIndexEntry, ImageRef } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createBatch } from '../src/batches.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { renderBatchPdf } from '../src/render/pdf.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

// P-04 回归：长商户名（发票销售方全称）不得让整批预览/导出 500。
describe('long merchant names (P-04)', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-long-merchant-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function seed(merchant: string): Promise<string> {
    const id = `receipt-${merchant.length}`;
    const bytes = await sharp({
      create: { width: 160, height: 100, channels: 3, background: '#245c77' },
    })
      .png()
      .toBuffer();
    const original: ImageRef = {
      id: `image-${merchant.length}`,
      path: `2026-09/originals/image-${merchant.length}.png`,
      mime: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width: 160,
      height: 100,
      deletedAt: null,
    };
    await mkdir(dirname(safePath(temp, original.path)), { recursive: true });
    await writeFile(safePath(temp, original.path), bytes);
    const entry: FileIndexEntry = {
      id: original.id,
      ownerId: id,
      kind: 'original',
      path: original.path,
      sha256: original.sha256,
      deletedAt: null,
    };
    store.put('files', entry);
    store.put('receipts', sampleReceipt({ id, merchant, original, paidFen: 128000 }));
    const batch = createBatch(
      store,
      [id],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    store.put('batches', batch);
    return batch.id;
  }

  async function firstPageText(bytes: Buffer): Promise<string> {
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    return text.items.map((item) => ('str' in item ? item.str : '')).join('');
  }

  it('shrinks a 27-char merchant into the summary column instead of 500', async () => {
    const merchant = '深圳市百慕达国际海鲜餐饮管理有限公司远洋分店酒水专柜';
    const batchId = await seed(merchant);
    const batch = store.get('batches', batchId)!;
    const joined = await firstPageText(await renderBatchPdf(store, config, batch));
    // 缩字号后完整放下，不截断、不抛错
    expect(joined).toContain(merchant);

    const application = createApp({ store, config });
    const preview = await request(application).get(`/api/batches/${batchId}/preview.pdf`);
    expect(preview.status).toBe(200);
    const exported = await request(application).post(`/api/batches/${batchId}/export`);
    expect(exported.status).toBe(200);
  });

  it('truncates an extremely long merchant with an ellipsis instead of 500', async () => {
    const merchant = '深圳市百慕达国际海鲜餐饮管理有限公司远洋分店酒水专柜暨进口生鲜冷链配送中心华南大区旗舰总店财务结算专用';
    const batchId = await seed(merchant);
    const batch = store.get('batches', batchId)!;
    const joined = await firstPageText(await renderBatchPdf(store, config, batch));
    expect(joined).toContain('…');
    expect(joined).not.toContain(merchant);

    const application = createApp({ store, config });
    const preview = await request(application).get(`/api/batches/${batchId}/preview.pdf`);
    expect(preview.status).toBe(200);
  });
});
