import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Receipt } from '@auto-reimbursement/contracts';
import { expect, test } from '@playwright/test';

import { createFixtureRuntime, type Fixture } from './fixture-runtime.ts';

const fixtureDirectory = join(process.cwd(), 'e2e', 'fixtures');

test('executes every acceptance fixture and its supplier-learning follow-up', async () => {
  const fixtures = JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8')) as Fixture[];
  expect(fixtures).toHaveLength(54);
  const runtime = await createFixtureRuntime();
  try {
    const firstRun = fixtures.filter((fixture) => fixture.run !== 'learning');
    const uploaded = await upload(runtime.baseUrl, firstRun);
    expect(uploaded.accepted).toHaveLength(49);
    expect(uploaded.rejected).toEqual([
      expect.objectContaining({ index: firstRun.findIndex((fixture) => fixture.id === 'duplicate-renamed'), code: 'EXACT_DUPLICATE' }),
    ]);

    await waitForRecognition(runtime.baseUrl, uploaded.accepted.map((receipt) => receipt.id));
    const rows = await receiptRows(runtime.baseUrl);
    const fixtureByReceipt = new Map(uploaded.accepted.map((receipt, index) => [receipt.id, firstRun.filter((fixture) => fixture.id !== 'duplicate-renamed')[index]! ]));
    for (const [id, fixture] of fixtureByReceipt) {
      const receipt = rows.get(id);
      expect(receipt).toBeDefined();
      expect(receipt!.status).toBe(fixture.expected.outcome);
      expect(receipt!.paidFen).toBe(fixture.expected.paidFen);
      expect(receipt!.category).toBe(fixture.expected.category);
      expect(receipt!.pendingReasons).toEqual(fixture.expected.reason === null ? [] : [fixture.expected.reason]);
    }
    expect(runtime.analyzer.callsFor('normal-01')).toBe(1);
    expect(runtime.analyzer.callsFor('transient-01')).toBe(2);
    expect(runtime.analyzer.callsFor('transient-02')).toBe(2);
    expect(runtime.analyzer.callsFor('terminal-01')).toBe(1);
    expect(runtime.analyzer.callsFor('similar-crop')).toBe(0);

    const overLimit = await upload(runtime.baseUrl, Array.from({ length: 51 }, () => firstRun[1]!));
    expect(overLimit.status).toBe(413);

    const secondRun = fixtures.filter((fixture) => fixture.run === 'learning');
    const learning = await upload(runtime.baseUrl, secondRun.slice(0, 3));
    await waitForRecognition(runtime.baseUrl, learning.accepted.map((receipt) => receipt.id));
    for (const [index, receipt] of learning.accepted.entries()) {
      const fixture = secondRun[index]!;
      const corrected = await requestJson<Receipt>(runtime.baseUrl, `/api/receipts/${receipt.id}`, 'PATCH', { paidFen: fixture.expected.paidFen, category: fixture.expected.category });
      expect(corrected.status).toBe('pending');
      const confirmed = await requestJson<Receipt>(runtime.baseUrl, `/api/receipts/${receipt.id}/confirm`, 'POST');
      expect(confirmed).toEqual(expect.objectContaining({
        status: fixture.expected.outcome,
        paidFen: fixture.expected.paidFen,
        category: fixture.expected.category,
        pendingReasons: [],
      }));
    }
    const medium = await upload(runtime.baseUrl, secondRun.slice(3));
    await waitForRecognition(runtime.baseUrl, medium.accepted.map((receipt) => receipt.id));
    const mediumRow = (await receiptRows(runtime.baseUrl)).get(medium.accepted[0]!.id)!;
    expect(mediumRow.status).toBe('ready');
    expect(mediumRow.paidFen).toBe(secondRun[3]!.expected.paidFen);
    expect(mediumRow.category).toBe('耗材');
    expect(mediumRow.pendingReasons).toEqual([]);
  } finally {
    await runtime.close();
  }
});

async function upload(baseUrl: string, fixtures: Fixture[]): Promise<{ status: number; accepted: Receipt[]; rejected: Array<{ index: number; code: string; duplicateId?: string }> }> {
  const body = new FormData();
  for (const fixture of fixtures) {
    const bytes = await readFile(join(fixtureDirectory, 'images', fixture.file));
    body.append('files', new Blob([bytes], { type: 'image/png' }), fixture.id === 'duplicate-renamed' ? 'renamed-copy.png' : fixture.file);
  }
  const response = await fetch(`${baseUrl}/api/receipts/upload`, { method: 'POST', body });
  return { status: response.status, ...(await response.json() as Omit<Awaited<ReturnType<typeof upload>>, 'status'>) };
}

async function receiptRows(baseUrl: string): Promise<Map<string, Receipt>> {
  const [pool, pending] = await Promise.all([
    requestJson<Receipt[]>(baseUrl, '/api/receipts?view=pool'),
    requestJson<Receipt[]>(baseUrl, '/api/receipts?view=pending'),
  ]);
  return new Map([...pool, ...pending].map((receipt) => [receipt.id, receipt]));
}

async function waitForRecognition(baseUrl: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const progress = await requestJson<{ recognizing: number }>(baseUrl, `/api/progress?ids=${ids.join(',')}`);
    if (progress.recognizing === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rows = await receiptRows(baseUrl);
  throw new Error(`Recognition did not settle: ${[...rows.values()].filter((receipt) => receipt.status === 'recognizing').map((receipt) => `${receipt.merchant ?? receipt.id}:${receipt.attempts}`).join(', ')}`);
}

async function requestJson<T>(baseUrl: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}
