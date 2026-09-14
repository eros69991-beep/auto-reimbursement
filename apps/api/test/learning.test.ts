import type { Analysis, Category, Rule } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import {
  listRules,
  normalizeFeature,
  recordCorrection,
  saveRule,
} from '../src/learning.js';
import { confirmReceipt, updateReceipt } from '../src/receipts.js';
import { sampleReceipt } from './support.js';

function analyzedReceipt(
  id: string,
  overrides: Partial<Analysis> = {},
) {
  const analysis: Analysis = {
    amount: '10.00',
    category: '日常用品',
    merchant: '某供应商',
    date: null,
    confidence: { amount: 0.99, category: 0.8 },
    ambiguous: false,
    keywords: [],
    evidence: '',
    ...overrides,
  };
  return sampleReceipt({
    id,
    analysis,
    paidFen: null,
    category: null,
    merchant: analysis.merchant,
    status: 'pending',
    pendingReasons: ['amount_uncertain', 'category_uncertain'],
  });
}

describe('local correction learning', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('promotes only after three consistent confirmed corrections', () => {
    for (let n = 1; n <= 3; n += 1) {
      store.put(
        'receipts',
        analyzedReceipt(String(n), { merchant: '  某供应商  ' }),
      );
      recordCorrection(store, String(n), '耗材');
    }

    expect(listRules(store)[0]).toMatchObject({
      key: '某供应商',
      category: '耗材',
      confirmations: 3,
      strong: true,
    });
  });

  it('resets a rule when a later confirmed correction chooses a different category', () => {
    store.put('receipts', analyzedReceipt('first'));
    store.put('receipts', analyzedReceipt('second'));
    recordCorrection(store, 'first', '耗材');
    recordCorrection(store, 'second', '食材');

    expect(listRules(store)).toHaveLength(1);
    expect(listRules(store)[0]).toMatchObject({
      category: '食材',
      confirmations: 1,
      strong: false,
      originalCategory: '日常用品',
    });
  });

  it('does not create a rule without a merchant or usable keyword', () => {
    store.put(
      'receipts',
      analyzedReceipt('empty-feature', {
        merchant: null,
        keywords: ['  ', '　'],
      }),
    );

    expect(recordCorrection(store, 'empty-feature', '耗材')).toBeNull();
    expect(listRules(store)).toEqual([]);
  });

  it('counts a receipt at most once for its final category', () => {
    store.put('receipts', analyzedReceipt('repeat'));

    recordCorrection(store, 'repeat', '耗材');
    recordCorrection(store, 'repeat', '耗材');

    expect(listRules(store)[0]).toMatchObject({ confirmations: 1, strong: false });
  });

  it('normalizes vendor-neutral merchant and keyword features', () => {
    expect(normalizeFeature(' ＡＣＭＥ　 Store  ')).toBe('acme store');
    store.put(
      'receipts',
      analyzedReceipt('keyword', { merchant: null, keywords: ['　咖 啡　'] }),
    );

    expect(recordCorrection(store, 'keyword', '酒水')).toMatchObject({
      kind: 'keyword',
      key: '咖 啡',
      category: '酒水',
    });
  });

  it('uses a usable receipt merchant when the AI merchant is only whitespace', () => {
    const receipt = analyzedReceipt('merchant-fallback', {
      merchant: '　 ',
      keywords: ['coffee'],
    });
    store.put('receipts', { ...receipt, merchant: '  Fallback Store  ' });

    expect(recordCorrection(store, receipt.id, '酒水')).toMatchObject({
      kind: 'merchant',
      key: 'fallback store',
    });
  });

  it('validates manually saved rule confirmations and strong state', () => {
    const rule: Rule = {
      id: 'manual',
      kind: 'merchant',
      key: 'manual vendor',
      originalCategory: '耗材',
      category: '耗材',
      confirmations: 2,
      strong: false,
      updatedAt: '2026-09-03T00:00:00.000Z',
    };
    expect(saveRule(store, rule)).toEqual(rule);
    expect(() => saveRule(store, { ...rule, confirmations: -1 })).toThrow(
      'INVALID_CONFIRMATIONS',
    );
    expect(() => saveRule(store, { ...rule, strong: true })).toThrow(
      'INVALID_STRONG_RULE',
    );
  });

  it('records learning only after explicit confirmation and preserves original analysis', () => {
    const receipt = analyzedReceipt('confirm', { merchant: '  Provider Switch Shop ' });
    store.put('receipts', receipt);

    const edited = updateReceipt(store, receipt.id, {
      paidFen: 1000,
      category: '耗材',
    });
    expect(edited.status).toBe('pending');
    expect(listRules(store)).toEqual([]);

    const confirmed = confirmReceipt(store, receipt.id);
    expect(confirmed).toMatchObject({
      status: 'ready',
      paidFen: 1000,
      category: '耗材',
      pendingReasons: [],
      analysis: receipt.analysis,
    });
    expect(listRules(store)[0]).toMatchObject({
      key: 'provider switch shop',
      category: '耗材',
      confirmations: 1,
    });
  });

  it('rejects edits to archived receipts and confirmation with incomplete duplicate state', () => {
    const archived = analyzedReceipt('archived');
    const duplicate = analyzedReceipt('duplicate');
    store.put('receipts', { ...archived, status: 'archived' });
    store.put('receipts', {
      ...duplicate,
      paidFen: 1000,
      category: '耗材',
      duplicateIds: ['prior'],
    });

    expect(() => updateReceipt(store, archived.id, { paidFen: 1000 })).toThrow(
      'IMMUTABLE_RECEIPT',
    );
    expect(() => confirmReceipt(store, duplicate.id)).toThrow(
      'UNRESOLVED_DUPLICATE',
    );
  });
});

describe('correction HTTP routes', () => {
  let store: Store;
  let config: Config;

  beforeEach(() => {
    store = openStore(':memory:');
    config = loadConfig({}, process.cwd());
  });

  afterEach(() => {
    store.close();
  });

  it('edits, confirms, lists, updates, and deletes rules through the API', async () => {
    store.put('receipts', analyzedReceipt('http'));
    const application = createApp({ store, config });

    const edited = await request(application).patch('/api/receipts/http').send({
      paidFen: 1000,
      category: '耗材',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe('pending');

    const confirmed = await request(application).post('/api/receipts/http/confirm');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('ready');

    const listed = await request(application).get('/api/rules');
    expect(listed.status).toBe(200);
    const rule = listed.body[0] as Rule;
    const updated = await request(application)
      .put(`/api/rules/${rule.id}`)
      .send({ ...rule, confirmations: 3, strong: true });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ confirmations: 3, strong: true });

    const removed = await request(application).delete(`/api/rules/${rule.id}`);
    expect(removed.status).toBe(204);
    expect((await request(application).get('/api/rules')).body).toEqual([]);
    expect(store.get('receipts', 'http')).not.toBeNull();
  });

  it('maps an under-confirmed strong rule to client validation', async () => {
    const rule: Rule = { id: 'under-confirmed', kind: 'keyword', key: 'coffee', originalCategory: null, category: '酒水', confirmations: 2, strong: true, updatedAt: '2026-09-03T00:00:00.000Z' };
    const response = await request(createApp({ store, config })).put('/api/rules/under-confirmed').send(rule);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_STRONG_RULE');
  });

  it('rejects unknown categories without changing the receipt', async () => {
    const receipt = analyzedReceipt('invalid-category');
    store.put('receipts', receipt);

    const response = await request(createApp({ store, config }))
      .patch('/api/receipts/invalid-category')
      .send({ category: 'unknown' as Category });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CATEGORY');
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
  });

  it.each(['null', '[]', '"invalid"', '0', 'false', '{}'])(
    'rejects PATCH body %s without changing a receipt',
    async (body) => {
      const receipt = sampleReceipt({ id: `invalid-patch-${body}`, status: 'ready' });
      store.put('receipts', receipt);

      const response = await request(createApp({ store, config }))
        .patch(`/api/receipts/${receipt.id}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_RECEIPT_PATCH');
      expect(store.get('receipts', receipt.id)).toEqual(receipt);
    },
  );
});
