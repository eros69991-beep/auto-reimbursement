import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { Batch, FileIndexEntry, ImageRef } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatch, getBatch } from '../src/batches.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { orderedAttachments } from '../src/render/attachments.js';
import { exportBatchPdf, renderBatchPdf } from '../src/render/pdf.js';
import { safePath } from '../src/storage.js';
import { resolveOptions, getSettings } from '../src/settings.js';
import { sampleReceipt } from './support.js';

// 只在测试要求时让「仅报销单页」副本（文件名以 -form 结尾）写不进去，其余照常写盘
const failures = vi.hoisted(() => ({ formCopy: false }));
vi.mock('../src/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage.js')>();
  return {
    ...actual,
    storeExportPdf: (config: Config, month: string, id: string, bytes: Buffer) => {
      if (failures.formCopy && id.endsWith('-form')) return Promise.reject(new Error('DISK_FULL'));
      return actual.storeExportPdf(config, month, id, bytes);
    },
  };
});

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
    failures.formCopy = false;
    vi.restoreAllMocks();
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
    // 导出时顺手存了「仅报销单页」的小副本（2 张报销单 → 2 页），对账页预览用它，不用下整份
    const formEntry = store.list('files').find((entry) => entry.ownerId === batch.id && entry.kind === 'pdf-form');
    expect(formEntry).toBeDefined();
    expect(formEntry!.path).toMatch(/^2026-09\/exports\/.+-form\.pdf$/);
    const formFile = await readFile(safePath(temp, formEntry!.path));
    expect(await pageText(formFile)).toHaveLength(2);

    expect((await request(application).post(`/api/batches/${batch.id}/export`)).body).toEqual(exported);
    expect(store.list('files').filter((entry) => entry.kind === 'pdf-form')).toHaveLength(1);
    const saved = await request(application).get(`/api/batches/${batch.id}/pdf`);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(await readFile(safePath(temp, exported.pdfPath!)));
    // 下载的仍是整份（5 页）；定稿后的预览是报销单页小副本（2 页），内容不可变所以长缓存，带 ETag 可 304
    expect(await pageText(saved.body)).toHaveLength(5);
    const finalPreview = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(finalPreview.status).toBe(200);
    expect(finalPreview.body).toEqual(formFile);
    expect(finalPreview.body.length).toBeLessThan(saved.body.length);
    expect(finalPreview.headers['cache-control']).toContain('immutable');
    const formEtag = finalPreview.headers['etag'] as string;
    expect(formEtag).toMatch(/^"saved-form-[0-9a-f]{24}"$/);
    expect((await request(application).get(`/api/batches/${batch.id}/preview.pdf`).set('If-None-Match', formEtag)).status).toBe(304);

    // 整份 PDF 被换掉：下载报错，预览走小副本不受影响；小副本也被换掉才整体 404
    await writeFile(safePath(temp, exported.pdfPath!), Buffer.from('%PDF-1.7 replaced'));
    expect((await request(application).get(`/api/batches/${batch.id}/pdf`)).status).toBe(404);
    expect((await request(application).get(`/api/batches/${batch.id}/preview.pdf`)).body).toEqual(formFile);
    await writeFile(safePath(temp, formEntry!.path), Buffer.from('%PDF-1.7 replaced'));
    expect((await request(application).get(`/api/batches/${batch.id}/preview.pdf`)).status).toBe(404);

    // 整份恢复后，小副本仍是坏的：预览退回整份
    await writeFile(safePath(temp, exported.pdfPath!), saved.body);
    const fallback = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(fallback.status).toBe(200);
    expect(fallback.body).toEqual(saved.body);
    expect(fallback.headers['etag']).toMatch(/^"saved-[0-9a-f]{24}"$/);
    await writeFile(safePath(temp, formEntry!.path), formFile);
    const exportedFile = store.list('files').find((entry) => entry.path === exported.pdfPath);
    expect(exportedFile).toBeDefined();
    store.remove('files', exportedFile!.id);
    expect((await request(application).get(`/api/batches/${batch.id}/pdf`)).status).toBe(404);
  });

  it('previews a finalized batch from the whole saved PDF when it has no form-only copy (exported before the copy existed)', async () => {
    const original = await indexedImage('old-final-original', '#245c77');
    await writeImage(original);
    indexImage('old-final', 'original', original);
    const batch = createIndexedBatch('old-final', original);
    const exported = await exportBatchPdf(store, config, batch.id);
    for (const entry of store.list('files').filter((file) => file.kind === 'pdf-form')) {
      store.remove('files', entry.id);
    }

    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(await readFile(safePath(temp, exported.pdfPath!)));
    expect(preview.headers['etag']).toMatch(/^"saved-[0-9a-f]{24}"$/);
    // 一张报销单 + 一页凭证
    expect(await pageText(preview.body)).toHaveLength(2);
  });

  it('keeps no form-only copy for a draft and never serves one as an image', async () => {
    const original = await indexedImage('copy-original', '#245c77');
    await writeImage(original);
    indexImage('copy', 'original', original);
    const batch = createIndexedBatch('copy', original);
    expect(store.list('files').filter((entry) => entry.kind === 'pdf-form')).toEqual([]);

    await exportBatchPdf(store, config, batch.id);
    const copy = store.list('files').find((entry) => entry.kind === 'pdf-form');
    expect(copy).toBeDefined();
    const response = await request(createApp({ store, config })).get(`/api/images/${copy!.id}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('IMAGE_NOT_FOUND');
  });

  it('exports anyway when the form-only copy cannot be saved, and previews from the whole PDF', async () => {
    const original = await indexedImage('nocopy-original', '#245c77');
    await writeImage(original);
    indexImage('nocopy', 'original', original);
    const batch = createIndexedBatch('nocopy', original);
    failures.formCopy = true;

    const exported = await exportBatchPdf(store, config, batch.id);

    expect(exported.pdfPath).toMatch(/^2026-09\/exports\/.+\.pdf$/);
    expect(store.list('files').filter((entry) => entry.kind === 'pdf-form')).toEqual([]);
    // 没有留下写了一半的临时文件
    expect(await readdir(join(temp, '2026-09', 'exports'))).toEqual([basename(exported.pdfPath!)]);
    const preview = await request(createApp({ store, config })).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(await readFile(safePath(temp, exported.pdfPath!)));
  });

  it('removes both files it wrote when another request finalized the batch first', async () => {
    const original = await indexedImage('race-original', '#245c77');
    await writeImage(original);
    indexImage('race', 'original', original);
    const batch = createIndexedBatch('race', original);
    const winnerPath = '2026-09/exports/winner.pdf';
    const realTransact = store.transact.bind(store);
    vi.spyOn(store, 'transact').mockImplementation((work) => {
      // 渲染、写文件期间，另一个请求已经把这张报销单定稿了
      store.put('batches', { ...getBatch(store, batch.id), pdfPath: winnerPath });
      return realTransact(work);
    });

    const exported = await exportBatchPdf(store, config, batch.id);

    expect(exported.pdfPath).toBe(winnerPath);
    // 这次多写的两份文件（整份 PDF 和报销单页副本）都清掉了，索引里也没有它们
    expect(store.list('files').filter((entry) => entry.kind === 'pdf' || entry.kind === 'pdf-form')).toEqual([]);
    expect(await readdir(join(temp, '2026-09', 'exports'))).toEqual([]);
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
