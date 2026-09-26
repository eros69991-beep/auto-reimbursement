import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Batch, ImageRef } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

// Task 01：报销人/部门全链路持久化 —— 建批写入、PATCH 修改、预览幂等、
// 重启后仍在、定稿导出同一快照、定稿后锁定。
describe('batch options persistence', () => {
  let store: Store;
  let temp: string;
  let config: Config;
  let dbFile: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-persistence-'));
    dbFile = join(temp, 'store.sqlite');
    store = openStore(dbFile);
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('keeps department and signer through edit, preview, restart and export', async () => {
    const original = await seedReceipt('persist-a');
    await seedReceipt('persist-b');
    void original;

    const application = createApp({ store, config });
    const created = await request(application)
      .post('/api/batches')
      .send({
        receiptIds: ['persist-a', 'persist-b'],
        options: {
          department: '武汉测试店',
          date: '2026-09-26',
          signerMode: 'text',
          signerName: '测试报销人甲',
          signature: null,
        },
      });
    expect(created.status).toBe(201);
    const batch = created.body as Batch;
    expect(batch.options.department).toBe('武汉测试店');
    expect(batch.options.signerName).toBe('测试报销人甲');

    const fetched = await request(application).get(`/api/batches/${batch.id}`);
    expect(fetched.body.options.department).toBe('武汉测试店');
    expect(fetched.body.options.signerName).toBe('测试报销人甲');

    const noteBySheet = Object.fromEntries(
      (fetched.body as Batch).sheets.map((sheet) => [sheet.id, sheet.noteId]),
    );
    const patched = await request(application)
      .patch(`/api/batches/${batch.id}/options`)
      .send({
        options: { ...fetched.body.options, department: '武汉测试店乙', signerName: '测试报销人乙' },
        noteBySheet,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.options.department).toBe('武汉测试店乙');

    const refetched = await request(application).get(`/api/batches/${batch.id}`);
    expect(refetched.body.options.department).toBe('武汉测试店乙');
    expect(refetched.body.options.signerName).toBe('测试报销人乙');

    // 预览 PDF 含新值，且连续两次生成字节一致（幂等）
    const previewA = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(previewA.status).toBe(200);
    const previewB = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(previewB.status).toBe(200);
    expect(previewB.body.equals(previewA.body)).toBe(true);
    const previewText = (await pageText(previewA.body)).join('\n').replace(/\s+/g, '');
    expect(previewText).toContain('武汉测试店乙');
    expect(previewText).toContain('测试报销人乙');

    // 模拟刷新/重开：关闭并用同一 SQLite 文件重开后读取
    store.close();
    store = openStore(dbFile);
    const reopened = createApp({ store, config });
    const afterRestart = await request(reopened).get(`/api/batches/${batch.id}`);
    expect(afterRestart.body.options.department).toBe('武汉测试店乙');
    expect(afterRestart.body.options.signerName).toBe('测试报销人乙');

    // 定稿导出后下载 PDF 含同一快照
    const exported = await request(reopened).post(`/api/batches/${batch.id}/export`);
    expect(exported.status).toBe(200);
    expect((exported.body as Batch).pdfPath).not.toBeNull();
    const finalPdf = await request(reopened).get(`/api/batches/${batch.id}/pdf`);
    expect(finalPdf.status).toBe(200);
    const finalText = (await pageText(finalPdf.body)).join('\n').replace(/\s+/g, '');
    expect(finalText).toContain('武汉测试店乙');
    expect(finalText).toContain('测试报销人乙');

    // 定稿后直接改选项应拒绝（需先撤销）
    const editAfterExport = await request(reopened)
      .patch(`/api/batches/${batch.id}/options`)
      .send({
        options: { ...afterRestart.body.options, department: 'X' },
        noteBySheet,
      });
    expect(editAfterExport.status).toBe(409);
    expect(editAfterExport.body.code).toBe('BATCH_FINALIZED');
  });

  async function seedReceipt(id: string): Promise<ImageRef> {
    const bytes = await sharp({
      create: { width: 160, height: 100, channels: 3, background: '#245c77' },
    })
      .png()
      .toBuffer();
    const image: ImageRef = {
      id: `${id}-original`,
      path: `2026-09/originals/${id}.png`,
      mime: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width: 160,
      height: 100,
      deletedAt: null,
    };
    const path = safePath(temp, image.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    store.put('files', {
      id: image.id,
      ownerId: id,
      kind: 'original',
      path: image.path,
      sha256: image.sha256,
      deletedAt: null,
    });
    store.put('receipts', sampleReceipt({ id, original: image }));
    return image;
  }
});

async function pageText(bytes: Buffer): Promise<string[]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  return Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const content = await (await pdf.getPage(index + 1)).getTextContent();
      return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
    }),
  );
}
