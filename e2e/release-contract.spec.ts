import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Batch, Note, Receipt, Rule, Settings, UploadResult } from '@auto-reimbursement/contracts';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { openStore } from '../apps/api/src/db.ts';
import { createFixtureRuntime } from './fixture-runtime.ts';

const fixtures = join(process.cwd(), 'e2e', 'fixtures', 'images');

test('enforces local mutations and releases a confirmed distinct receipt with receipt-owned evidence', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const rejected = await fetch(`${runtime.baseUrl}/health`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({
      code: 'CROSS_ORIGIN_MUTATION',
      message: '拒绝非本机来源的修改请求',
    });

    const uploaded = await upload(runtime.baseUrl, ['normal-01.png', 'similar-crop.png']);
    expect(uploaded.accepted).toHaveLength(2);
    await waitForRecognition(runtime.baseUrl, uploaded.accepted.map((receipt) => receipt.id));
    const suspect = (await rows(runtime.baseUrl)).find((receipt) => receipt.id === uploaded.accepted[1]!.id)!;
    expect(suspect).toMatchObject({ status: 'pending', pendingReasons: ['suspected_duplicate'] });
    expect(suspect.duplicateIds).toEqual([uploaded.accepted[0]!.id]);

    const evidence = await fetch(`${runtime.baseUrl}/api/receipts/${suspect.duplicateIds[0]!}/original-image`);
    expect(evidence.status).toBe(200);
    expect((await evidence.arrayBuffer()).byteLength).toBeGreaterThan(0);

    await requestJson<Receipt>(runtime.baseUrl, `/api/receipts/${suspect.id}/confirm-distinct`, 'POST');
    await waitForRecognition(runtime.baseUrl, [suspect.id]);
    expect((await rows(runtime.baseUrl)).find((receipt) => receipt.id === suspect.id)).toMatchObject({
      status: 'ready', pendingReasons: [], duplicateIds: [], duplicateOverride: true,
    });
    expect(runtime.analyzer.callsFor('similar-crop')).toBe(1);
  } finally {
    await runtime.close();
  }
});

test('keeps a batch PDF and structured backup through archive, unarchive and deliberate original cleanup', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const defaults = await requestJson<Settings>(runtime.baseUrl, '/api/settings');
    const savedSettings = await requestJson<Settings>(runtime.baseUrl, '/api/settings', 'PUT', {
      ...defaults, department: '归档验收部门', dateMode: 'blank',
    });
    const savedNote = await requestJson<Note>(runtime.baseUrl, '/api/notes', 'POST', {
      name: '归档备注', content: '备份后仍然存在',
    });
    const savedRule = await requestJson<Rule>(runtime.baseUrl, '/api/rules/archive-rule', 'PUT', {
      kind: 'keyword',
      key: '归档关键词',
      originalCategory: null,
      category: '耗材',
      confirmations: 3,
      strong: true,
    });
    const uploaded = await upload(runtime.baseUrl, ['normal-01.png']);
    const receipt = uploaded.accepted[0]!;
    await waitForRecognition(runtime.baseUrl, [receipt.id]);
    const batch = await requestJson<Batch>(runtime.baseUrl, '/api/batches', 'POST', {
      receiptIds: [receipt.id],
      options: { department: savedSettings.department, date: null, signerMode: 'text', signerName: '', signature: null },
    });
    const exported = await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/export`, 'POST');
    expect(exported.pdfPath).not.toBeNull();

    await requestJson(runtime.baseUrl, `/api/archive/${batch.month}`, 'POST');
    expect((await requestJson<Array<{ month: string; batches: Batch[] }>>(runtime.baseUrl, '/api/history'))[0]).toMatchObject({
      month: batch.month,
      batches: [expect.objectContaining({ id: batch.id, archivedAt: expect.any(String) })],
    });
    const immutable = await fetch(`${runtime.baseUrl}/api/receipts/${receipt.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paidFen: 1 }),
    });
    expect(immutable.status).toBe(409);

    await requestJson(runtime.baseUrl, `/api/unarchive/${batch.month}`, 'POST');
    expect(await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}`)).toMatchObject({ archivedAt: null });
    expect((await rows(runtime.baseUrl)).find((row) => row.id === receipt.id)).toBeUndefined();
    await requestJson(runtime.baseUrl, `/api/archive/${batch.month}`, 'POST');
    await requestJson(runtime.baseUrl, `/api/cleanup/${batch.month}`, 'POST', {
      confirmation: `DELETE ORIGINALS ${batch.month}`,
    });
    expect((await fetch(`${runtime.baseUrl}/api/receipts/${receipt.id}/original-image`)).status).toBe(410);
    expect((await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/pdf`)).status).toBe(200);

    const backup = await requestJson<{ downloadUrl: string; includesImages: boolean }>(runtime.baseUrl, '/api/backup', 'POST');
    expect(backup.includesImages).toBe(false);
    const backupResponse = await fetch(`${runtime.baseUrl}${backup.downloadUrl}`);
    expect(backupResponse.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await backupResponse.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual([
      'app.sqlite', 'files.json', 'manifest.json', 'rules.json', 'settings.json',
    ]);
    expect(JSON.parse(Buffer.from(archive['manifest.json']!).toString('utf8'))).toMatchObject({
      schemaVersion: 3, includesImages: false,
    });

    const restoreDir = await mkdtemp(join(tmpdir(), 'auto-reimbursement-backup-reopen-'));
    const restoredPath = join(restoreDir, 'app.sqlite');
    try {
      await writeFile(restoredPath, archive['app.sqlite']!);
      const restored = openStore(restoredPath);
      try {
        expect(restored.get('settings', 'default')).toEqual(savedSettings);
        expect(restored.get('notes', savedNote.id)).toEqual(savedNote);
        expect(restored.get('rules', savedRule.id)).toEqual(savedRule);
        expect(restored.get('receipts', receipt.id)).toMatchObject({
          status: 'archived',
          batchId: batch.id,
          original: { deletedAt: expect.any(String) },
        });
        expect(restored.get('batches', batch.id)).toMatchObject({
          pdfPath: exported.pdfPath,
          archivedAt: expect.any(String),
          totalFen: 12_000,
        });
        expect(JSON.parse(Buffer.from(archive['settings.json']!).toString('utf8'))).toEqual(restored.list('settings'));
        expect(JSON.parse(Buffer.from(archive['rules.json']!).toString('utf8'))).toEqual(restored.list('rules'));
        expect(JSON.parse(Buffer.from(archive['files.json']!).toString('utf8'))).toEqual(restored.list('files'));
      } finally {
        restored.close();
      }
    } finally {
      await rm(restoreDir, { recursive: true, force: true });
    }
  } finally {
    await runtime.close();
  }
});

test('resumes queued recognition from the persisted store after a restart', async () => {
  const runtime = await createFixtureRuntime({ startQueue: false });
  try {
    const uploaded = await upload(runtime.baseUrl, ['normal-01.png']);
    const receipt = uploaded.accepted[0]!;
    expect(await requestJson(runtime.baseUrl, `/api/progress?ids=${receipt.id}`)).toEqual({
      recognizing: 1,
      ready: 0,
      pending: 0,
      total: 1,
    });
    expect(runtime.analyzer.callsFor('normal-01')).toBe(0);

    await runtime.restart();
    await waitForRecognition(runtime.baseUrl, [receipt.id]);

    expect((await rows(runtime.baseUrl)).find((row) => row.id === receipt.id)).toMatchObject({
      status: 'ready',
      attempts: 1,
      original: { sha256: receipt.original.sha256 },
    });
    expect(runtime.analyzer.callsFor('normal-01')).toBe(1);
  } finally {
    await runtime.close();
  }
});

test('excludes a fully refunded receipt from totals and batch creation', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const uploaded = await upload(runtime.baseUrl, ['normal-01.png']);
    const receipt = uploaded.accepted[0]!;
    await waitForRecognition(runtime.baseUrl, [receipt.id]);
    await requestJson<Receipt>(runtime.baseUrl, `/api/receipts/${receipt.id}/refund`, 'PUT', {
      refundFen: 12_000,
    });

    expect(await requestJson(runtime.baseUrl, '/api/pool/totals')).toMatchObject({
      count: 0,
      totalFen: 0,
    });
    const rejected = await fetch(`${runtime.baseUrl}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiptIds: [receipt.id],
        options: { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
      }),
    });
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({ code: 'NOT_ELIGIBLE' });
  } finally {
    await runtime.close();
  }
});

test('renders isolated multi-sheet form options and preserves every stored original', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const signatureBody = new FormData();
    signatureBody.append('file', new Blob([await readFile(join(fixtures, 'normal-35.png'))], { type: 'image/png' }), 'signature.png');
    const settings = await requestJson<Settings>(runtime.baseUrl, '/api/settings/signature', 'POST', signatureBody);
    expect(settings.signature).not.toBeNull();
    const firstNote = await requestJson<Note>(runtime.baseUrl, '/api/notes', 'POST', {
      name: '第一页', content: '第一页验收备注',
    });
    const secondNote = await requestJson<Note>(runtime.baseUrl, '/api/notes', 'POST', {
      name: '第二页', content: '第二页验收备注',
    });

    const names = Array.from({ length: 10 }, (_, index) => `normal-${String(index + 1).padStart(2, '0')}.png`);
    const uploaded = await upload(runtime.baseUrl, names);
    await waitForRecognition(runtime.baseUrl, uploaded.accepted.map((receipt) => receipt.id));
    const hashesBefore = new Map(await Promise.all(uploaded.accepted.map(async (receipt) => [
      receipt.id,
      sha256(await readFile(join(runtime.dataDir, receipt.original.path))),
    ] as const)));

    const batch = await requestJson<Batch>(runtime.baseUrl, '/api/batches', 'POST', {
      receiptIds: uploaded.accepted.map((receipt) => receipt.id),
      options: {
        department: '验收部门',
        date: null,
        signerMode: 'image',
        signerName: '不应打印的文字签名',
        signature: settings.signature,
      },
    });
    expect(batch.sheets.map((sheet) => sheet.groups.map((group) => group.category))).toEqual([
      ['食材', '耗材', '日常用品', '肉类', '酒水', '能耗费', '人工费用'],
      ['租金及管理费', '员工餐', '百慕达食材'],
    ]);

    const movedCategory = '百慕达食材';
    const moved = await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/move`, 'POST', {
      category: movedCategory, direction: 1,
    });
    expect(moved.sheets).toHaveLength(3);
    expect(moved.sheets.at(-1)?.groups.map((group) => group.category)).toEqual([movedCategory]);
    const restored = await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/move`, 'POST', {
      category: movedCategory, direction: -1,
    });
    expect(restored.sheets).toEqual(batch.sheets);

    const saved = await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/options`, 'PATCH', {
      options: batch.options,
      noteBySheet: {
        [batch.sheets[0]!.id]: firstNote.id,
        [batch.sheets[1]!.id]: secondNote.id,
      },
    });
    expect(saved.options).toMatchObject({ date: null, signerMode: 'image' });
    expect(saved.options.signature?.sha256).toBe(settings.signature?.sha256);
    expect(saved.sheets.map((sheet) => sheet.noteId)).toEqual([firstNote.id, secondNote.id]);

    await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/export`, 'POST');
    const pdfResponse = await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/pdf`);
    expect(pdfResponse.status).toBe(200);
    const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
    const pageText = await pdfPageText(pdfBytes);
    expect(pageText).toHaveLength(12);
    expect(pageText[0]).toContain('伍佰贰拾柒元叁角叁分');
    expect(pageText[0]).toContain(firstNote.content);
    expect(pageText[0].replace(/\s+/g, '')).toContain('日期：单据及附件共');
    expect(pageText[0]).not.toContain('不应打印的文字签名');
    expect(await pdfPageHasImage(pdfBytes, 1)).toBe(true);
    expect(pageText[8]).toContain('壹佰捌拾捌元整');
    expect(pageText[8]).toContain(secondNote.content);
    expect(attachmentLabels(pageText, saved)).toEqual([
      '食材:120.00',
      '耗材:36.33',
      '日常用品:45.00',
      '肉类:78.00',
      '酒水:56.00',
      '能耗费:92.00',
      '人工费用:100.00',
      '租金及管理费:68.00',
      '员工餐:32.00',
      '百慕达食材:88.00',
    ]);

    for (const receipt of uploaded.accepted) {
      expect(sha256(await readFile(join(runtime.dataDir, receipt.original.path)))).toBe(hashesBefore.get(receipt.id));
    }
  } finally {
    await runtime.close();
  }
});

test('keeps exported receipt, layout, options and PDF history immutable', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const uploaded = await upload(runtime.baseUrl, ['normal-01.png']);
    const receipt = uploaded.accepted[0]!;
    await waitForRecognition(runtime.baseUrl, [receipt.id]);
    const batch = await requestJson<Batch>(runtime.baseUrl, '/api/batches', 'POST', {
      receiptIds: [receipt.id],
      options: { department: '原部门', date: '2026-09-12', signerMode: 'text', signerName: '原签名', signature: null },
    });
    const exported = await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/export`, 'POST');
    const originalPdf = Buffer.from(await (await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/pdf`)).arrayBuffer());

    const mutations: Array<[string, string, unknown]> = [
      [`/api/receipts/${receipt.id}`, 'PATCH', { paidFen: 1 }],
      [`/api/receipts/${receipt.id}/refund`, 'PUT', { refundFen: 1 }],
      [`/api/batches/${batch.id}/move`, 'POST', { category: '食材', direction: 1 }],
      [`/api/batches/${batch.id}/options`, 'PATCH', {
        options: { ...batch.options, department: '篡改部门' },
        noteBySheet: { [batch.sheets[0]!.id]: null },
      }],
    ];
    for (const [path, method, body] of mutations) {
      const response = await fetch(`${runtime.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(409);
    }

    expect(await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}`)).toEqual(exported);
    expect(await requestJson<Batch>(runtime.baseUrl, `/api/batches/${batch.id}/export`, 'POST')).toEqual(exported);
    const historyRows = await requestJson<Array<{ month: string; batches: Batch[] }>>(runtime.baseUrl, '/api/history');
    expect(historyRows).toEqual([{ month: exported.month, batches: [exported] }]);
    const unchangedPdf = Buffer.from(await (await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/pdf`)).arrayBuffer());
    expect(sha256(unchangedPdf)).toBe(sha256(originalPdf));
  } finally {
    await runtime.close();
  }
});

test('keeps configured provider credentials out of browser requests and loaded assets', async ({ page }) => {
  const secrets = ['acceptance-api-key', 'provider-model-private', 'provider-password'];
  const runtime = await createFixtureRuntime({
    ai: {
      baseUrl: `https://provider-user:${secrets[2]}@vision.example/v1`,
      model: secrets[1]!,
      apiKey: secrets[0]!,
    },
  });
  try {
    const browserRequests: Array<{ url: string; headers: Record<string, string>; body: string | null }> = [];
    page.on('request', (request) => browserRequests.push({
      url: request.url(), headers: request.headers(), body: request.postData(),
    }));
    await page.route('**/api/**', async (route) => {
      const original = new URL(route.request().url());
      await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByText('AI 服务：已配置', { exact: true })).toBeVisible();

    const statusResponse = await fetch(`${runtime.baseUrl}/api/ai/status`);
    const statusBody = await statusResponse.text();
    expect(JSON.parse(statusBody)).toEqual({ configured: true, provider: 'openai-compatible' });
    const assetUrls = await page.evaluate(() => [
      location.href,
      ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ]);
    const webOrigin = new URL(page.url()).origin;
    const localAssets = await Promise.all([...new Set(assetUrls)]
      .filter((url) => {
        const parsed = new URL(url);
        return parsed.origin === webOrigin && !parsed.pathname.startsWith('/api/');
      })
      .map(async (url) => {
        const response = await page.request.get(url);
        return response.ok() ? await response.text() : '';
      }));
    expect(localAssets.join('\n')).toContain('Automatic Reimbursement Assistant');

    const exposedSurface = JSON.stringify({ browserRequests, statusBody, localAssets });
    for (const secret of secrets) expect(exposedSurface).not.toContain(secret);
  } finally {
    await runtime.close();
  }
});

async function upload(baseUrl: string, names: string[]): Promise<UploadResult> {
  const form = new FormData();
  for (const name of names) {
    form.append('files', new Blob([await readFile(join(fixtures, name))], { type: 'image/png' }), name);
  }
  return requestJson(baseUrl, '/api/receipts/upload', 'POST', form);
}

async function rows(baseUrl: string): Promise<Receipt[]> {
  const [pool, pending] = await Promise.all([
    requestJson<Receipt[]>(baseUrl, '/api/receipts?view=pool'),
    requestJson<Receipt[]>(baseUrl, '/api/receipts?view=pending'),
  ]);
  return [...pool, ...pending];
}

async function waitForRecognition(baseUrl: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const progress = await requestJson<{ recognizing: number }>(baseUrl, `/api/progress?ids=${ids.join(',')}`);
    if (progress.recognizing === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('recognition did not settle');
}

async function requestJson<T>(baseUrl: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined || form ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

async function pdfPageText(bytes: Buffer): Promise<string[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await loadingTask.promise;
  try {
    return await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
      const content = await (await pdf.getPage(index + 1)).getTextContent();
      return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
    }));
  } finally {
    await loadingTask.destroy();
  }
}

async function pdfPageHasImage(bytes: Buffer, pageNumber: number): Promise<boolean> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await loadingTask.promise;
  try {
    const operators = await (await pdf.getPage(pageNumber)).getOperatorList();
    return operators.fnArray.some((operator) => (
      operator === OPS.paintImageXObject ||
      operator === OPS.paintInlineImageXObject ||
      operator === OPS.paintImageMaskXObject
    ));
  } finally {
    await loadingTask.destroy();
  }
}

function attachmentLabels(pages: string[], batch: Batch): string[] {
  const labels: string[] = [];
  let pageIndex = 0;
  for (const sheet of batch.sheets) {
    pageIndex += 1;
    for (const group of sheet.groups) {
      for (const receiptId of group.receiptIds) {
        const item = batch.items.find((candidate) => candidate.receiptId === receiptId)!;
        const original = pages[pageIndex++]!.replace(/\s+/g, '');
        expect(original).toContain('原始凭证');
        labels.push(`${group.category}:${(item.netFen / 100).toFixed(2)}`);
        expect(original).toContain(`${group.category}·¥${(item.netFen / 100).toFixed(2)}·原始凭证`);
        pageIndex += item.refundImages.length;
      }
    }
  }
  expect(pageIndex).toBe(pages.length);
  return labels;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
