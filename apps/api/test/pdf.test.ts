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

  it('orders original then refund evidence and renders every sheet in order', { timeout: 20000 }, async () => {
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
    // 页眉两行：第一行对账说明（写法同网页对账区），第二行是原始/退款凭证，带退款的写明原实付、退款、实报
    expect(ordered.map((attachment) => attachment.label)).toEqual([
      '第 1 张报销单 · 耗材 第 1/1 张 · 本张 220.00 · 耗材合计 220.00\n原始凭证 · 原实付 300.00 / 退款 80.00 / 实报 220.00',
      '第 1 张报销单 · 耗材 第 1/1 张 · 本张 220.00 · 耗材合计 220.00\n退款凭证 · 原实付 300.00 / 退款 80.00 / 实报 220.00',
    ]);
    expect(orderedAttachments(batch, batch.sheets[1]!).map((attachment) => attachment.label)).toEqual([
      '第 2 张报销单 · 食材 第 1/1 张 · 本张 41.00 · 食材合计 41.00\n原始凭证',
    ]);

    const before = await readFile(safePath(temp, originalA.path));
    const rendered = await renderBatchPdf(store, config, batch);
    const after = await readFile(safePath(temp, originalA.path));
    expect(after).toEqual(before);
    const pages = await pageText(rendered);
    expect(pages).toHaveLength(5);
    expect(pages[0]!.replace(/\s+/g, '')).toContain('费用报销单');
    expect(pages[1]).toContain('原始凭证');
    expect(pages[2]).toContain('退款凭证');
    expect(pages[3]!.replace(/\s+/g, '')).toContain('费用报销单');
    expect(pages[4]).toContain('原始凭证');
    // 附件页页眉印在 PDF 里：先是对账说明，原始凭证页和退款凭证页各写各的
    expect(pages[1]!.replace(/\s+/g, '')).toContain('第1张报销单·耗材第1/1张·本张220.00·耗材合计220.00');
    expect(pages[1]!.replace(/\s+/g, '')).toContain('原始凭证·原实付300.00/退款80.00/实报220.00');
    expect(pages[2]!.replace(/\s+/g, '')).toContain('第1张报销单·耗材第1/1张·本张220.00·耗材合计220.00退款凭证');
    expect(pages[4]!.replace(/\s+/g, '')).toContain('第2张报销单·食材第1/1张·本张41.00·食材合计41.00原始凭证');
    expect(pages.join('\n')).not.toContain('2026-09/');
    expect(pages.join('\n')).not.toContain('qa-a');

    const application = createApp({ store, config });
    // P-16：草稿预览默认只渲染表单页（2 张表 → 2 页），?attachments=1 才带附件页
    const preview = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^application\/pdf/);
    expect(await pageText(preview.body)).toHaveLength(2);
    const fullPreview = await request(application).get(`/api/batches/${batch.id}/preview.pdf?attachments=1`);
    expect(fullPreview.status).toBe(200);
    expect(await pageText(fullPreview.body)).toHaveLength(5);
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

  it('renders a category split across sheets as consecutive forms, each followed by its own receipts', { timeout: 30000 }, async () => {
    // 食材 40 张：第一张报销单写前 30 张，第二张「食材（续）」写后 10 张
    const ids = Array.from({ length: 40 }, (_, index) => `split-${index}`);
    for (const [index, id] of ids.entries()) {
      const original = await indexedImage(`${id}-original`, '#245c77');
      await writeImage(original);
      indexImage(id, 'original', original);
      store.put('receipts', sampleReceipt({ id, uploadOrder: index + 1, category: '食材', paidFen: 10000 + index, original }));
    }
    const batch = createBatch(
      store,
      ids,
      resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
      new Date('2026-09-04T00:00:00.000Z'),
    );
    expect(batch.sheets.map((sheet) => sheet.groups.map((group) => [group.part, group.receiptIds.length]))).toEqual([
      [[1, 30]],
      [[2, 10]],
    ]);
    expect(orderedAttachments(batch, batch.sheets[0]!).map((attachment) => attachment.receiptId)).toEqual(ids.slice(0, 30));
    expect(orderedAttachments(batch, batch.sheets[1]!).map((attachment) => attachment.receiptId)).toEqual(ids.slice(30));
    // 拆开的分类：每一部分单独数「第 i/n 张」、单独合计，第二张报销单写「食材（续）」
    const firstSheet = orderedAttachments(batch, batch.sheets[0]!);
    const secondSheet = orderedAttachments(batch, batch.sheets[1]!);
    expect(firstSheet[0]!.label).toBe('第 1 张报销单 · 食材 第 1/30 张 · 本张 100.00 · 食材合计 3004.35\n原始凭证');
    expect(firstSheet.at(-1)!.label).toBe('第 1 张报销单 · 食材 第 30/30 张 · 本张 100.29 · 食材合计 3004.35\n原始凭证');
    expect(secondSheet[0]!.label).toBe('第 2 张报销单 · 食材（续） 第 1/10 张 · 本张 100.30 · 食材（续）合计 1003.45\n原始凭证');
    expect(secondSheet.at(-1)!.label).toBe('第 2 张报销单 · 食材（续） 第 10/10 张 · 本张 100.39 · 食材（续）合计 1003.45\n原始凭证');

    const formsOnly = await pageText(await renderBatchPdf(store, config, batch, { attachments: false }));
    expect(formsOnly).toHaveLength(2);
    expect(formsOnly[0]).toContain('食材');
    expect(formsOnly[0]).not.toContain('（续）');
    expect(formsOnly[1]).toContain('食材（续）');

    const pages = await pageText(await renderBatchPdf(store, config, batch));
    expect(pages).toHaveLength(2 + 40);
    expect(pages[0]!.replace(/\s+/g, '')).toContain('费用报销单');
    expect(pages.slice(1, 31).every((page) => page.includes('原始凭证'))).toBe(true);
    expect(pages[31]!.replace(/\s+/g, '')).toContain('食材（续）');
    expect(pages.slice(32).every((page) => page.includes('原始凭证'))).toBe(true);
    expect(pages[1]!.replace(/\s+/g, '')).toContain('第1张报销单·食材第1/30张·本张100.00·食材合计3004.35');
    expect(pages[32]!.replace(/\s+/g, '')).toContain('第2张报销单·食材（续）第1/10张·本张100.30·食材（续）合计1003.45');

    const exported = await exportBatchPdf(store, config, batch.id);
    expect(exported.pdfPath).not.toBeNull();
    expect(await pageText(await readFile(safePath(temp, exported.pdfPath!)))).toHaveLength(42);
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
    // 默认预览只渲染表单页不读附件（P-16）；带 ?attachments=1 才发现缺失附件
    const formOnly = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(formOnly.status).toBe(200);
    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf?attachments=1`);
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
