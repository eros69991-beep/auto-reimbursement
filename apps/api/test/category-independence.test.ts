import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Analysis, Batch, ImageRef, Receipt } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { applyAnalysis, decide } from '../src/decision.js';
import { recordCorrection } from '../src/learning.js';
import { getSettings } from '../src/settings.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

// Task 02：「百慕达食材」与「食材」始终是两个独立分类 ——
// 识别精确落库、人工修改不被迟到识别/重识别覆盖、两类同批不合并、学习规则不改写类别。
describe('百慕达食材与食材分类独立', () => {
  let store: Store;
  let temp: string;
  let config: Config;
  let dbFile: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-category-'));
    dbFile = join(temp, 'store.sqlite');
    store = openStore(dbFile);
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  function analysisOf(category: '百慕达食材' | '食材', amount: string, merchant: string): Analysis {
    return {
      amount,
      category,
      merchant,
      date: '2026-09-26',
      confidence: { amount: 0.99, category: 0.99 },
      ambiguous: false,
      keywords: [],
      evidence: 'test',
    };
  }

  it('keeps AI suggestions exact: 百慕达→百慕达, 食材→食材', () => {
    store.put('receipts', sampleReceipt({ id: 'a', status: 'recognizing', category: null, paidFen: null, recognizedFen: null }));
    store.put('receipts', sampleReceipt({ id: 'b', status: 'recognizing', category: null, paidFen: null, recognizedFen: null }));

    const a = applyAnalysis(store, 'a', analysisOf('百慕达食材', '100.00', '百慕达供应'));
    const b = applyAnalysis(store, 'b', analysisOf('食材', '50.00', '微信生鲜'));

    expect(a.category).toBe('百慕达食材');
    expect(a.status).toBe('ready');
    expect(b.category).toBe('食材');
    expect(b.status).toBe('ready');
  });

  it('never lets a late or repeated recognition overwrite a manual category', async () => {
    await seedReceipt('manual');
    const application = createApp({ store, config });

    // 人工改为百慕达食材并确认
    const patched = await request(application)
      .patch('/api/receipts/manual')
      .send({ category: '百慕达食材' });
    expect(patched.status).toBe(200);
    const confirmed = await request(application).post('/api/receipts/manual/confirm');
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as Receipt).category).toBe('百慕达食材');
    expect((confirmed.body as Receipt).status).toBe('ready');

    // 刷新/重开（同一 SQLite）后仍是百慕达食材
    store.close();
    store = openStore(dbFile);
    const reopened = createApp({ store, config });
    const pool = await request(reopened).get('/api/receipts?view=pool');
    expect((pool.body as Receipt[]).find((r) => r.id === 'manual')?.category).toBe('百慕达食材');

    // 非 api_failed 凭证不允许重识别
    const retry = await request(reopened).post('/api/receipts/manual/retry');
    expect(retry.status).toBe(409);

    // 迟到的识别结果直接被拒，不覆盖人工分类
    expect(() =>
      applyAnalysis(store, 'manual', analysisOf('食材', '50.00', '微信生鲜')),
    ).toThrow('INVALID_RECEIPT_STATE');
    expect(store.get('receipts', 'manual')?.category).toBe('百慕达食材');
  });

  it('keeps both categories separate in one batch: 100.00 + 50.00 = 150.00', async () => {
    await seedReceipt('bermuda', { category: '百慕达食材', paidFen: 10000, merchant: '百慕达供应' });
    await seedReceipt('food', { category: '食材', paidFen: 5000, merchant: '微信生鲜' });
    const application = createApp({ store, config });

    const created = await request(application)
      .post('/api/batches')
      .send({
        receiptIds: ['bermuda', 'food'],
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
    expect(batch.totalFen).toBe(15000);
    const groups = batch.sheets.flatMap((sheet) => sheet.groups);
    expect(groups).toHaveLength(2);
    expect(Object.fromEntries(groups.map((group) => [group.category, group.totalFen]))).toEqual({
      百慕达食材: 10000,
      食材: 5000,
    });

    // 预览 PDF：两行两分类，表单页合计拆位 150.00（万/千/百/十/元/角/分）
    const preview = await request(application).get(`/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    const pages = await pageText(preview.body);
    const formPage = pages[0]!.replace(/\s+/g, '');
    expect(formPage).toContain('百慕达食材');
    expect(formPage).toContain('食材');
    expect(formPage).toContain('合计15000');
    const all = pages.join('\n').replace(/\s+/g, '');
    expect(all).toContain('100.00');
    expect(all).toContain('50.00');
  });

  it('flags a strong learned rule conflict as pending instead of rewriting the category', () => {
    // 同一商家三次人工确认为百慕达食材 → 强规则
    for (const id of ['r1', 'r2', 'r3']) {
      store.put(
        'receipts',
        sampleReceipt({ id, merchant: '百慕达供应', category: '百慕达食材', status: 'ready' }),
      );
      recordCorrection(store, id, '百慕达食材');
    }
    const rules = store.list('rules');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.strong).toBe(true);
    expect(rules[0]!.category).toBe('百慕达食材');

    // 新凭证同商家但 AI 说食材：规则只产生冲突待确认，不改写类别、不静默放行
    const decision = decide(
      analysisOf('食材', '50.00', '百慕达供应'),
      rules,
      getSettings(store),
    );
    expect(decision.status).toBe('pending');
    expect(decision.reasons).toContain('rule_conflict');
    expect(decision.category).toBe('食材');

    // 精确匹配先于包含：「食材」规则不匹配「百慕达供应」商家以外的语义，归一化不裁剪
    const other = decide(
      analysisOf('百慕达食材', '100.00', '百慕达供应'),
      rules,
      getSettings(store),
    );
    expect(other.status).toBe('ready');
    expect(other.category).toBe('百慕达食材');
  });

  async function seedReceipt(id: string, overrides: Partial<Receipt> = {}): Promise<ImageRef> {
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
    store.put('receipts', sampleReceipt({ id, original: image, ...overrides }));
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
