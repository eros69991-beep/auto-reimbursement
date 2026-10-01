import type { Analysis, Receipt, Rule } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { listRules, recordCorrection, saveRule } from '../src/learning.js';
import { confirmReceipt, updateReceipt } from '../src/receipts.js';
import { sampleReceipt } from './support.js';

// 试点反馈 1：武汉仓（百慕达订货小程序）的订单一直被识别成食材。
// 固定规则保存即生效、按「包含」匹配；「套用到待处理」只改仍保持识别原样的待处理凭证。

function wuhanAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    amount: '624.61',
    category: '食材',
    merchant: null,
    date: '2026-09-25',
    confidence: { amount: 0.99, category: 0.5 },
    ambiguous: false,
    keywords: ['订单列表'],
    evidence: '订单列表 武汉仓 实付 624.61',
    ...overrides,
  };
}

function pendingReceipt(id: string, overrides: Partial<Receipt> = {}): Receipt {
  return sampleReceipt({
    id,
    status: 'pending',
    pendingReasons: ['category_uncertain'],
    analysis: wuhanAnalysis(),
    recognizedFen: 62461,
    paidFen: 62461,
    category: '食材',
    ...overrides,
  });
}

const fixedRuleBody = {
  kind: 'keyword',
  key: ' 武汉仓 ',
  originalCategory: null,
  category: '百慕达食材',
  confirmations: 0,
  strong: false,
  source: 'manual',
};

describe('fixed rules over HTTP', () => {
  let store: Store;
  let config: Config;

  beforeEach(() => {
    store = openStore(':memory:');
    config = loadConfig({}, process.cwd());
  });

  afterEach(() => {
    store.close();
  });

  it('saves a fixed rule without any confirmations and normalizes its text', async () => {
    const response = await request(createApp({ store, config }))
      .put('/api/rules/fixed-wuhan')
      .send(fixedRuleBody);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'fixed-wuhan',
      key: '武汉仓',
      category: '百慕达食材',
      source: 'manual',
      strong: false,
    });
  });

  it('rejects fixed rules shorter than two characters with a readable message', async () => {
    const response = await request(createApp({ store, config }))
      .put('/api/rules/too-short')
      .send({ ...fixedRuleBody, key: '仓' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'RULE_KEY_TOO_SHORT',
      message: '固定规则的文字至少要 2 个字',
    });
    expect(listRules(store)).toEqual([]);
  });

  it('rejects an unknown rule source', async () => {
    const response = await request(createApp({ store, config }))
      .put('/api/rules/odd')
      .send({ ...fixedRuleBody, source: 'robot' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_RULE');
  });

  it('reapplies rules only to pending receipts still exactly as recognized', async () => {
    const untouched = pendingReceipt('wuhan');
    const categoryEdited = pendingReceipt('category-edited', { category: '肉类' });
    const amountEdited = pendingReceipt('amount-edited', { paidFen: 60000 });
    const duplicate = pendingReceipt('duplicate', {
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: ['wuhan'],
    });
    const awaitingConfirmation = pendingReceipt('awaiting-confirmation', { pendingReasons: [] });
    const ready = sampleReceipt({ id: 'ready', analysis: wuhanAnalysis(), category: '食材' });
    for (const receipt of [untouched, categoryEdited, amountEdited, duplicate, awaitingConfirmation, ready]) {
      store.put('receipts', receipt);
    }
    const application = createApp({ store, config });

    expect((await request(application).put('/api/rules/fixed-wuhan').send(fixedRuleBody)).status).toBe(200);
    const reapplied = await request(application).post('/api/rules/reapply');
    expect(reapplied.status).toBe(200);
    expect(reapplied.body).toEqual({ affected: 1 });

    expect(store.get('receipts', 'wuhan')).toMatchObject({
      status: 'ready',
      category: '百慕达食材',
      pendingReasons: [],
      ruleMatch: { mode: 'applied', ruleId: 'fixed-wuhan', key: '武汉仓', category: '百慕达食材' },
    });
    for (const receipt of [categoryEdited, amountEdited, duplicate, awaitingConfirmation, ready]) {
      expect(store.get('receipts', receipt.id)).toEqual(receipt);
    }

    // 幂等：再套用一次没有变化
    expect((await request(application).post('/api/rules/reapply')).body).toEqual({ affected: 0 });
  });

  it('keeps an incomplete screenshot pending when reapplying, only taking the rule category', async () => {
    store.put(
      'receipts',
      pendingReceipt('half', {
        analysis: wuhanAnalysis({ amount: null, incomplete: true, confidence: { amount: 0.1, category: 0.5 } }),
        recognizedFen: null,
        paidFen: null,
        pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
      }),
    );
    const application = createApp({ store, config });
    // 没有规则时，重新套用不会改动它
    expect((await request(application).post('/api/rules/reapply')).body).toEqual({ affected: 0 });

    expect((await request(application).put('/api/rules/fixed-wuhan').send(fixedRuleBody)).status).toBe(200);
    expect((await request(application).post('/api/rules/reapply')).body).toEqual({ affected: 1 });
    expect(store.get('receipts', 'half')).toMatchObject({
      status: 'pending',
      category: '百慕达食材',
      pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
    });
  });

  it('turns a rule conflict into a suggestion that survives reapplying', async () => {
    store.put('rules', {
      id: 'merchant:武汉仓',
      kind: 'merchant',
      key: '武汉仓',
      originalCategory: '食材',
      category: '百慕达食材',
      confirmations: 3,
      strong: true,
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    store.put(
      'receipts',
      pendingReceipt('drinks', {
        analysis: wuhanAnalysis({ category: '酒水', merchant: '武汉仓', confidence: { amount: 0.99, category: 0.99 } }),
        category: '酒水',
        merchant: '武汉仓',
        pendingReasons: ['rule_conflict'],
      }),
    );

    const response = await request(createApp({ store, config })).post('/api/rules/reapply');
    expect(response.body).toEqual({ affected: 1 });
    expect(store.get('receipts', 'drinks')).toMatchObject({
      status: 'pending',
      category: '酒水',
      pendingReasons: ['rule_conflict'],
      ruleMatch: { mode: 'suggested', category: '百慕达食材' },
    });
  });
});

describe('rule notes on receipts', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const applied = { mode: 'applied', ruleId: 'fixed-wuhan', key: '武汉仓', category: '百慕达食材' } as const;
  const suggested = { mode: 'suggested', ruleId: 'merchant:武汉仓', key: '武汉仓', category: '百慕达食材' } as const;

  it('drops the rule note when a person changes the category', () => {
    store.put('receipts', sampleReceipt({ id: 'r', category: '百慕达食材', ruleMatch: applied }));
    expect(updateReceipt(store, 'r', { category: '酒水' }).ruleMatch).toBeNull();
  });

  it('keeps an applied rule note when the category is confirmed unchanged', () => {
    store.put('receipts', pendingReceipt('r', { category: '百慕达食材', pendingReasons: ['amount_uncertain'], ruleMatch: applied }));
    expect(confirmReceipt(store, 'r', { paidFen: 62461, category: '百慕达食材' }).ruleMatch).toEqual(applied);
  });

  it('clears a suggestion once a person resolves the conflict', () => {
    store.put('receipts', pendingReceipt('r', { category: '酒水', pendingReasons: ['rule_conflict'], ruleMatch: suggested }));
    expect(confirmReceipt(store, 'r', { paidFen: 62461, category: '酒水' }).ruleMatch).toBeNull();
  });
});

describe('learning never rewrites a fixed rule', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('keeps a learned rule that was promoted to a fixed rule', () => {
    const promoted: Rule = {
      id: 'merchant:武汉仓',
      kind: 'merchant',
      key: '武汉仓',
      originalCategory: '食材',
      category: '百慕达食材',
      confirmations: 5,
      strong: true,
      updatedAt: '2026-09-30T00:00:00.000Z',
      source: 'manual',
    };
    const saved = saveRule(store, promoted);
    expect(saved).toMatchObject({ source: 'manual', strong: false, confirmations: 5 });

    store.put('receipts', pendingReceipt('drinks', { merchant: '武汉仓', analysis: wuhanAnalysis({ merchant: '武汉仓' }) }));
    expect(recordCorrection(store, 'drinks', '酒水')).toEqual(saved);
    expect(listRules(store)).toEqual([saved]);
  });
});
