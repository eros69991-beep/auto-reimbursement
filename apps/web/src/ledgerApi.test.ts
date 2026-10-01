import { afterEach, describe, expect, it, vi } from 'vitest';

import { settings } from './test/fixtures';
import { api, formOptionsFromSettings, withLedger } from './api';
import { apiFor } from './ledgerApi';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respondWith(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function lastRequest(fetchMock: ReturnType<typeof respondWith>): { url: string; init: RequestInit | undefined } {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init };
}

describe('adding the ledger to an address', () => {
  it('leaves the address alone when no ledger is given — the store pages never send one', () => {
    expect(withLedger('/api/history', undefined)).toBe('/api/history');
    expect(withLedger('/api/receipts?view=pool', undefined)).toBe('/api/receipts?view=pool');
  });

  it('adds ledger as the first or a further query parameter', () => {
    expect(withLedger('/api/history', 'company')).toBe('/api/history?ledger=company');
    expect(withLedger('/api/receipts?view=pool', 'company')).toBe('/api/receipts?view=pool&ledger=company');
    expect(withLedger('/api/rules', 'store')).toBe('/api/rules?ledger=store');
  });
});

describe('API calls with and without a ledger', () => {
  it('keeps every store address exactly as it was', async () => {
    const fetchMock = respondWith([]);

    await api.receipts('pool');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/receipts\?view=pool$/);
    await api.totals();
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/pool\/totals$/);
    await api.history();
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/history$/);
    await api.archive('2026-09');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/archive\/2026-09$/);
    await api.unarchive('2026-09');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/unarchive\/2026-09$/);
    await api.cleanup('2026-09', 'DELETE ORIGINALS 2026-09');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/cleanup\/2026-09$/);
    await api.rules();
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/rules$/);
    await api.reapplyRules();
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/rules\/reapply$/);
  });

  it('asks the company ledger when told to', async () => {
    const fetchMock = respondWith([]);

    await api.receipts('pending', 'company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/receipts\?view=pending&ledger=company$/);
    await api.totals('company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/pool\/totals\?ledger=company$/);
    await api.history('company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/history\?ledger=company$/);
    await api.archive('2026-09', 'company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/archive\/2026-09\?ledger=company$/);
    await api.unarchive('2026-09', 'company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/unarchive\/2026-09\?ledger=company$/);
    await api.cleanup('2026-09', 'DELETE ORIGINALS 2026-09', 'company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/cleanup\/2026-09\?ledger=company$/);
    expect(lastRequest(fetchMock).init).toMatchObject({ method: 'POST', body: JSON.stringify({ confirmation: 'DELETE ORIGINALS 2026-09' }) });
    await api.rules('company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/rules\?ledger=company$/);
    await api.reapplyRules('company');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/rules\/reapply\?ledger=company$/);
    expect(lastRequest(fetchMock).init).toMatchObject({ method: 'POST' });
  });

  it('the settings page can ask for just the store rules', async () => {
    const fetchMock = respondWith([]);
    await api.rules('store');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/rules\?ledger=store$/);
  });

  it('moves a group without a month the way it always did, and with the month when there is one', async () => {
    const fetchMock = respondWith({ id: 'b1' });

    await api.moveGroup('b1', '耗材', 1);
    expect(lastRequest(fetchMock).init?.body).toBe(JSON.stringify({ category: '耗材', direction: 1 }));

    await api.moveGroup('b1', '电费', -1, '2026-07');
    expect(lastRequest(fetchMock).url).toMatch(/\/api\/batches\/b1\/move$/);
    expect(lastRequest(fetchMock).init?.body).toBe(JSON.stringify({ category: '电费', direction: -1, period: '2026-07' }));
  });

  it('sends the ledger of an upload in the address, because an upload carries no form fields', () => {
    const opened: string[] = [];
    class FakeRequest {
      upload = {};
      responseType = '';
      open(_method: string, url: string): void { opened.push(url); }
      setRequestHeader = vi.fn();
      send = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const file = new File(['x'], 'a.png', { type: 'image/png' });

    void api.upload([file]);
    void api.upload([file], undefined, 'company');

    expect(opened[0]).toMatch(/\/api\/receipts\/upload$/);
    expect(opened[1]).toMatch(/\/api\/receipts\/upload\?ledger=company$/);
  });

  it('passes the lines, month and payee of a company receipt in the confirm request', async () => {
    const fetchMock = respondWith({ id: 'r1' });
    const patch = {
      lines: [{ category: '店面租金' as const, fen: 2_281_410, period: '2026-09' }, { category: '电费' as const, fen: 1_146_687, period: '2026-07' }],
      payee: { name: '示例公司', bank: '示例银行', account: '1234567890123456789' },
    };

    await api.confirmReceipt('r1', patch);

    expect(lastRequest(fetchMock).url).toMatch(/\/api\/receipts\/r1\/confirm$/);
    expect(JSON.parse(String(lastRequest(fetchMock).init?.body))).toEqual(patch);
  });
});

describe('form options for each ledger', () => {
  const now = new Date(2026, 8, 30);

  it('takes the department for the store form, exactly as before', () => {
    const options = formOptionsFromSettings({ ...settings, department: '火门店', companyDepartment: '火门里餐饮管理有限公司' }, now);
    expect(options.department).toBe('火门店');
    expect(formOptionsFromSettings({ ...settings, department: '火门店' }, now, 'store')).toEqual(options);
  });

  it('takes the separate payment unit for the company form and never the store department', () => {
    expect(formOptionsFromSettings({ ...settings, department: '火门店', companyDepartment: '火门里餐饮管理有限公司' }, now, 'company').department)
      .toBe('火门里餐饮管理有限公司');
    // 公账付款单位没填：空，不借用店内的部门
    expect(formOptionsFromSettings({ ...settings, department: '火门店' }, now, 'company').department).toBe('');
  });

  it('shares the date and signer settings between the two ledgers', () => {
    const base = { ...settings, dateMode: 'custom' as const, customDate: '2026-10-01', signerName: '张三', signerMode: 'text' as const };
    const store = formOptionsFromSettings(base, now);
    const company = formOptionsFromSettings(base, now, 'company');
    expect({ ...company, department: store.department }).toEqual(store);
  });
});

describe('the client a page uses', () => {
  it('is the api itself for the store, so every store call is the same call as before', () => {
    expect(apiFor('store')).toBe(api);
  });

  it('adds the company ledger to the calls that need it and nothing else', async () => {
    const receipts = vi.spyOn(api, 'receipts').mockResolvedValue([]);
    const totals = vi.spyOn(api, 'totals').mockResolvedValue({ count: 0, totalFen: 0, byCategory: {} });
    const history = vi.spyOn(api, 'history').mockResolvedValue([]);
    const archive = vi.spyOn(api, 'archive').mockResolvedValue({ affected: 1 });
    const unarchive = vi.spyOn(api, 'unarchive').mockResolvedValue({ affected: 1 });
    const cleanup = vi.spyOn(api, 'cleanup').mockResolvedValue({ affected: 1 });
    const upload = vi.spyOn(api, 'upload').mockResolvedValue({ accepted: [], rejected: [] });
    const client = apiFor('company');
    const onProgress = vi.fn();
    const file = new File(['x'], 'a.png', { type: 'image/png' });

    await client.receipts('pool');
    await client.totals();
    await client.history();
    await client.archive('2026-09');
    await client.unarchive('2026-09');
    await client.cleanup('2026-09', 'DELETE ORIGINALS 2026-09');
    await client.upload([file], onProgress);

    expect(receipts).toHaveBeenCalledWith('pool', 'company');
    expect(totals).toHaveBeenCalledWith('company');
    expect(history).toHaveBeenCalledWith('company');
    expect(archive).toHaveBeenCalledWith('2026-09', 'company');
    expect(unarchive).toHaveBeenCalledWith('2026-09', 'company');
    expect(cleanup).toHaveBeenCalledWith('2026-09', 'DELETE ORIGINALS 2026-09', 'company');
    expect(upload).toHaveBeenCalledWith([file], onProgress, 'company');
  });

  it('hands every other call to the api untouched', () => {
    const client = apiFor('company');
    expect(client.confirmReceipt).toBe(api.confirmReceipt);
    expect(client.createBatch).toBe(api.createBatch);
    expect(client.moveGroup).toBe(api.moveGroup);
    expect(client.rules).toBe(api.rules);
    expect(client.imageUrl).toBe(api.imageUrl);
  });

  it('is one stable object, so it can sit in an effect’s dependency list', () => {
    expect(apiFor('company')).toBe(apiFor('company'));
  });

  it('follows a method that is replaced on the api after the client was first made', async () => {
    const first = apiFor('company');
    const replaced = vi.spyOn(api, 'confirmReceipt').mockResolvedValue({} as never);
    await first.confirmReceipt('r1', {});
    expect(replaced).toHaveBeenCalledWith('r1', {});
  });
});
