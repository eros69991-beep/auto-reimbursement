import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Batch, FileIndexEntry, ImageRef } from '@auto-reimbursement/contracts';
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
  const imageBytes = new Map<string, Buffer>();

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
    indexImage('a', 'original', originalA);
    indexImage('a', 'refund', refundA);
    indexImage('b', 'original', originalB);
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
    const rendered = await renderBatchPdf(store, config, batch);
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

    await writeFile(safePath(temp, exported.pdfPath!), Buffer.from('%PDF-1.7 replaced'));
    expect((await request(application).get(`/api/batches/${batch.id}/pdf`)).status).toBe(404);
    expect((await request(application).get(`/api/batches/${batch.id}/preview.pdf`)).status).toBe(404);

    await writeFile(safePath(temp, exported.pdfPath!), saved.body);
    const exportedFile = store.list('files').find((entry) => entry.path === exported.pdfPath);
    expect(exportedFile).toBeDefined();
    store.remove('files', exportedFile!.id);
    expect((await request(application).get(`/api/batches/${batch.id}/pdf`)).status).toBe(404);
  });

  it('renders both signer modes and rejects a missing attachment without exporting', async () => {
    const original = await indexedImage('signer-original', '#245c77');
    const signature = await indexedImage('signature', '#101010', 'settings/signatures/signature.webp');
    await writeImage(original);
    await writeImage(signature);
    indexImage('signer', 'original', original);
    indexImage('default', 'signature', signature);
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

    expect((await pageText(await renderBatchPdf(store, config, batch)))).toHaveLength(2);
    await rm(safePath(temp, original.path));
    await expect(renderBatchPdf(store, config, batch)).rejects.toThrow('MISSING_ATTACHMENT');
    await expect(exportBatchPdf(store, config, batch.id)).rejects.toThrow('MISSING_ATTACHMENT');
    expect(store.get('batches', batch.id)!.pdfPath).toBeNull();
    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(409);
    expect(preview.body.code).toBe('MISSING_ATTACHMENT');
    expect(preview.body.message).toContain('signer');
  });

  it('rejects replaced or unindexed attachment evidence without persisting an export', async () => {
    const replaced = await indexedImage('replaced', '#245c77');
    await writeImage(replaced);
    indexImage('replaced', 'original', replaced);
    const replacedBatch = createIndexedBatch('replaced', replaced);
    await writeImage(replaced, '#b2452f');

    const application = createApp({ store, config });
    const replacedExport = await request(application).post(`/api/batches/${replacedBatch.id}/export`);
    expect(replacedExport.status).toBe(409);
    expect(replacedExport.body.code).toBe('MISSING_ATTACHMENT');
    expect(replacedExport.body.message).toContain('replaced');
    expect(store.get('batches', replacedBatch.id)!.pdfPath).toBeNull();
    expect(store.list('files').filter((entry) => entry.kind === 'pdf')).toEqual([]);

    const unindexed = await indexedImage('unindexed', '#245c77');
    await writeImage(unindexed);
    indexImage('unindexed', 'original', unindexed);
    const unindexedBatch = createIndexedBatch('unindexed', unindexed);
    store.remove('files', unindexed.id);
    const unindexedExport = await request(application).post(`/api/batches/${unindexedBatch.id}/export`);
    expect(unindexedExport.status).toBe(409);
    expect(unindexedExport.body.code).toBe('MISSING_ATTACHMENT');
    expect(store.get('batches', unindexedBatch.id)!.pdfPath).toBeNull();
    expect(store.list('files').filter((entry) => entry.kind === 'pdf')).toEqual([]);
  });

  it('rejects a replaced indexed signature before preview', async () => {
    const original = await indexedImage('signature-original', '#245c77');
    const signature = await indexedImage('signature-replaced', '#101010', 'settings/signatures/signature-replaced.png');
    await writeImage(original);
    await writeImage(signature);
    indexImage('signature-batch', 'original', original);
    indexImage('default', 'signature', signature);
    const batch = createIndexedBatch('signature-batch', original, signature);
    await writeImage(signature, '#b2452f');

    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(409);
    expect(preview.body.code).toBe('MISSING_ATTACHMENT');
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
    imageBytes.set(id, bytes);
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

  function createIndexedBatch(
    id: string,
    original: ImageRef,
    signature: ImageRef | null = null,
  ): Batch {
    store.put('receipts', sampleReceipt({ id, original }));
    const created = createBatch(
      store,
      [id],
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    const batch = signature === null
      ? created
      : { ...created, options: { ...created.options, signerMode: 'image' as const, signature } };
    store.put('batches', batch);
    return batch;
  }

  function indexImage(
    ownerId: string,
    kind: FileIndexEntry['kind'],
    image: ImageRef,
  ): void {
    store.put('files', {
      id: image.id,
      ownerId,
      kind,
      path: image.path,
      sha256: image.sha256,
      deletedAt: null,
    });
  }

  async function writeImage(image: ImageRef, replacementBackground?: string): Promise<void> {
    const bytes = replacementBackground === undefined
      ? imageBytes.get(image.id)
      : await sharp({
        create: { width: image.width, height: image.height, channels: 3, background: replacementBackground },
      })[image.mime === 'image/webp' ? 'webp' : 'png']().toBuffer();
    if (bytes === undefined) {
      throw new Error('MISSING_TEST_IMAGE');
    }
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
