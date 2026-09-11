import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Batch, Receipt, UploadResult } from '@auto-reimbursement/contracts';
import { expect, test } from '@playwright/test';

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
    const uploaded = await upload(runtime.baseUrl, ['normal-01.png']);
    const receipt = uploaded.accepted[0]!;
    await waitForRecognition(runtime.baseUrl, [receipt.id]);
    const batch = await requestJson<Batch>(runtime.baseUrl, '/api/batches', 'POST', {
      receiptIds: [receipt.id],
      options: { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
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
    expect((await backupResponse.arrayBuffer()).byteLength).toBeGreaterThan(100);
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
