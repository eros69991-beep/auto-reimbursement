import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Batch, ImageRef } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBatch } from '../src/batches.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { orderedAttachments } from '../src/render/attachments.js';
import { exportBatchPdf, renderBatchPdf } from '../src/render/pdf.js';
import { safePath } from '../src/storage.js';
import { resolveOptions, getSettings } from '../src/settings.js';
import { sampleReceipt } from './support.js';

describe('full reimbursement PDFs', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-pdf-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('orders original then refund evidence and renders every sheet in order', async () => {
    const originalA = await indexedImage('a-original', '#245c77');
    const refundA = await indexedImage('a-refund', '#b2452f');
    const originalB = await indexedImage('b-original', '#4d7028', '2026-09/originals/b-original.webp');
    await writeImage(originalA);
    await writeImage(refundA);
    await writeImage(originalB);
    store.put('receipts', sampleReceipt({
      id: 'a',
      uploadOrder: 1,
      category: '耗材',
      paidFen: 30000,
      refundFen: 8000,
      original: originalA,
      refundImages: [refundA],
    }));
    store.put('receipts', sampleReceipt({
      id: 'b',
      uploadOrder: 2,
      category: '食材',
      paidFen: 4100,
      original: originalB,
    }));

    const created = createBatch(
      store,
      ['a', 'b'],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    const [first, second] = created.sheets[0]!.groups;
    const batch = {
      ...created,
      sheets: [
        { id: 'sheet-001', groups: [first!], noteId: null },
        { id: 'sheet-002', groups: [second!], noteId: null },
      ],
    };
    store.put('batches', batch);

    const ordered = orderedAttachments(batch, batch.sheets[0]!);
    expect(ordered.map((attachment) => [attachment.receiptId, attachment.kind])).toEqual([
      ['a', 'original'],
      ['a', 'refund'],
    ]);
    expect(batch.sheets.flatMap((sheet) => orderedAttachments(batch, sheet)).map(
      (attachment) => [attachment.receiptId, attachment.kind],
    )).toEqual([
      ['a', 'original'],
      ['a', 'refund'],
      ['b', 'original'],
    ]);
    expect(ordered[0]!.label).toContain('原实付 ¥300.00 / 退款 ¥80.00 / 实报 ¥220.00');

    const before = await readFile(safePath(temp, originalA.path));
    const rendered = await renderBatchPdf(config, batch);
    const after = await readFile(safePath(temp, originalA.path));
    expect(after).toEqual(before);
    const pages = await pageText(rendered);
    expect(pages).toHaveLength(5);
    expect(pages[0]).toContain('费用报销单');
    expect(pages[1]).toContain('原始凭证');
    expect(pages[2]).toContain('退款凭证');
    expect(pages[3]).toContain('费用报销单');
    expect(pages[4]).toContain('原始凭证');
    expect(pages.join('\n')).not.toContain('2026-09/');
    expect(pages.join('\n')).not.toContain('qa-a');

    const application = createApp({ store, config });
    const preview = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^application\/pdf/);
    expect(await pageText(preview.body)).toHaveLength(5);
    expect((await request(application).get(`/api/batches/${batch.id}/pdf`)).status).toBe(404);

    const exportResponse = await request(application).post(`/api/batches/${batch.id}/export`);
    expect(exportResponse.status).toBe(200);
    const exported = exportResponse.body as Batch;
    expect(exported.pdfPath).toMatch(/^2026-09\/exports\/.+\.pdf$/);
    expect(await pageText(await readFile(safePath(temp, exported.pdfPath!)))).toHaveLength(5);
    expect(store.list('files')).toContainEqual(expect.objectContaining({
      ownerId: batch.id,
      kind: 'pdf',
      path: exported.pdfPath,
    }));
    expect((await request(application).post(`/api/batches/${batch.id}/export`)).body).toEqual(exported);
    const saved = await request(application).get(`/api/batches/${batch.id}/pdf`);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(await readFile(safePath(temp, exported.pdfPath!)));
    expect((await request(application).get(`/api/batches/${batch.id}/preview.pdf`)).body).toEqual(saved.body);
  });

  it('renders both signer modes and rejects a missing attachment without exporting', async () => {
    const original = await indexedImage('signer-original', '#245c77');
    const signature = await indexedImage('signature', '#101010', 'settings/signatures/signature.png');
    await writeImage(original);
    await writeImage(signature);
    store.put('receipts', sampleReceipt({ id: 'signer', original }));
    const textBatch = createBatch(
      store,
      ['signer'],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    const batch = {
      ...textBatch,
      options: { ...textBatch.options, signerMode: 'image' as const, signature },
    };
    store.put('batches', batch);

    expect((await pageText(await renderBatchPdf(config, batch)))).toHaveLength(2);
    await rm(safePath(temp, original.path));
    await expect(renderBatchPdf(config, batch)).rejects.toThrow('MISSING_ATTACHMENT');
    await expect(exportBatchPdf(store, config, batch.id)).rejects.toThrow('MISSING_ATTACHMENT');
    expect(store.get('batches', batch.id)!.pdfPath).toBeNull();
    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(409);
    expect(preview.body.code).toBe('MISSING_ATTACHMENT');
    expect(preview.body.message).toContain('signer');
  });

  async function indexedImage(
    id: string,
    background: string,
    path = `2026-09/originals/${id}.png`,
  ): Promise<ImageRef> {
    const image = sharp({
      create: { width: 160, height: 100, channels: 3, background },
    });
    const bytes = path.endsWith('.webp') ? await image.webp().toBuffer() : await image.png().toBuffer();
    return {
      id,
      path,
      mime: path.endsWith('.webp') ? 'image/webp' : 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width: 160,
      height: 100,
      deletedAt: null,
    };
  }

  async function writeImage(image: ImageRef): Promise<void> {
    const output = sharp({
      create: { width: image.width, height: image.height, channels: 3, background: '#245c77' },
    });
    const bytes = image.mime === 'image/webp' ? await output.webp().toBuffer() : await output.png().toBuffer();
    const path = safePath(temp, image.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  }
});

async function pageText(bytes: Buffer): Promise<string[]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  return Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
  }));
}
