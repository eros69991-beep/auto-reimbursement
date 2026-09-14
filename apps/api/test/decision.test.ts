import type { Analysis, Rule, Settings } from '@auto-reimbursement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAnalysis, decide } from '../src/decision.js';
import { openStore, type Store } from '../src/db.js';
import { sampleReceipt } from './support.js';

const settings: Settings = {
  id: 'default',
  department: '',
  dateMode: 'today',
  customDate: null,
  signerMode: 'text',
  signerName: '',
  signature: null,
  amountThreshold: 0.95,
  categoryThreshold: 0.9,
};

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    amount: '12.30',
    category: '耗材',
    merchant: null,
    date: null,
    confidence: { amount: 0.95, category: 0.9 },
    ambiguous: false,
    keywords: [],
    evidence: '',
    ...overrides,
  };
}

function strongRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    kind: 'merchant',
    key: 'acme store',
    originalCategory: '耗材',
    category: '耗材',
    confirmations: 3,
    strong: true,
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('confidence decisions', () => {
  it.each([
    [0.95, 0.9, false, 'ready'],
    [0.94, 0.9, false, 'pending'],
    [0.99, 0.99, true, 'pending'],
    [0.79, 0.99, false, 'pending'],
  ] as const)('decides %s/%s ambiguous=%s', (amount, category, ambiguous, status) => {
    expect(
      decide(
        analysis({ confidence: { amount, category }, ambiguous }),
        [],
        settings,
      ).status,
    ).toBe(status);
  });

  it('releases medium confidence only with an agreeing strong normalized merchant rule', () => {
    expect(
      decide(
        analysis({
          merchant: ' ＡＣＭＥ   STORE ',
          confidence: { amount: 0.8, category: 0.7 },
        }),
        [strongRule()],
        settings,
      ),
    ).toEqual({ status: 'ready', reasons: [], category: '耗材' });
  });

  it('releases medium confidence with an agreeing normalized keyword token rule', () => {
    expect(
      decide(
        analysis({
          confidence: { amount: 0.8, category: 0.7 },
          keywords: [' ＣＯＦＦＥＥ '],
        }),
        [strongRule({ kind: 'keyword', key: 'coffee' })],
        settings,
      ),
    ).toEqual({ status: 'ready', reasons: [], category: '耗材' });
  });

  it('releases medium confidence for a normalized exact keyword phrase', () => {
    expect(
      decide(
        analysis({
          confidence: { amount: 0.8, category: 0.7 },
          keywords: [' Ｃｏｆｆｅｅ   Ｂｅａｎｓ '],
        }),
        [strongRule({ kind: 'keyword', key: 'coffee beans' })],
        settings,
      ),
    ).toEqual({ status: 'ready', reasons: [], category: '耗材' });
  });

  it('does not release medium confidence for an incidental keyword word match', () => {
    expect(
      decide(
        analysis({
          confidence: { amount: 0.8, category: 0.7 },
          keywords: ['coffee beans'],
        }),
        [strongRule({ kind: 'keyword', key: 'coffee' })],
        settings,
      ),
    ).toEqual({
      status: 'pending',
      reasons: ['amount_uncertain', 'category_uncertain'],
      category: '耗材',
    });
  });

  it('does not release medium confidence from an unconfirmed rule', () => {
    expect(
      decide(
        analysis({
          merchant: 'ACME STORE',
          confidence: { amount: 0.8, category: 0.7 },
        }),
        [strongRule({ strong: false })],
        settings,
      ),
    ).toEqual({
      status: 'pending',
      reasons: ['amount_uncertain', 'category_uncertain'],
      category: '耗材',
    });
  });

  it('rejects conflicting matching strong rules before otherwise-high confidence release', () => {
    expect(
      decide(
        analysis({ merchant: 'ACME STORE', confidence: { amount: 0.99, category: 0.99 } }),
        [
          strongRule(),
          strongRule({ id: 'rule-2', category: '食材' }),
        ],
        settings,
      ),
    ).toEqual({
      status: 'pending',
      reasons: ['rule_conflict'],
      category: '耗材',
    });
  });

  it('rejects a matching strong rule that disagrees with the AI category', () => {
    expect(
      decide(
        analysis({ merchant: 'ACME STORE' }),
        [strongRule({ category: '食材' })],
        settings,
      ).reasons,
    ).toEqual(['rule_conflict']);
  });

  it.each([
    [analysis({ amount: null }), ['amount_uncertain'], '耗材'],
    [analysis({ category: null }), ['category_uncertain'], null],
    [
      analysis({ confidence: { amount: 0.799, category: 0.7 } }),
      ['amount_uncertain', 'category_uncertain'],
      '耗材',
    ],
    [
      analysis({ confidence: { amount: 0.8, category: 0.699 } }),
      ['amount_uncertain', 'category_uncertain'],
      '耗材',
    ],
  ] as const)('keeps %o pending with its observable uncertainty', (input, reasons, category) => {
    expect(decide(input, [], settings)).toEqual({
      status: 'pending',
      reasons,
      category,
    });
  });
});

describe('analysis application', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('copies only AI-provided amount fields and does not infer an amount from a rule', () => {
    const receipt = sampleReceipt({
      id: 'recognizing',
      status: 'recognizing',
      analysis: null,
      recognizedFen: null,
      paidFen: null,
      category: null,
      merchant: null,
      date: null,
    });
    store.put('receipts', receipt);
    store.put('rules', strongRule());

    const updated = applyAnalysis(
      store,
      receipt.id,
      analysis({ amount: null, merchant: 'ACME STORE' }),
    );

    expect(updated).toMatchObject({
      analysis: analysis({ amount: null, merchant: 'ACME STORE' }),
      recognizedFen: null,
      paidFen: null,
      category: '耗材',
      merchant: 'ACME STORE',
      status: 'pending',
      pendingReasons: ['amount_uncertain'],
    });
  });

  it('vetoes ready status and adds duplicate evidence after refinement', () => {
    const matching = sampleReceipt({
      id: 'historical',
      uploadOrder: 1,
      paidFen: 1230,
      merchant: 'ACME STORE',
      date: '2026-09-03',
      original: {
        ...sampleReceipt().original,
        id: 'historical-image',
        perceptualHash: '0000000000000001',
      },
    });
    const receipt = sampleReceipt({
      id: 'recognizing',
      uploadOrder: 2,
      status: 'recognizing',
      analysis: null,
      recognizedFen: null,
      paidFen: null,
      category: null,
      merchant: null,
      date: null,
      original: {
        ...sampleReceipt().original,
        id: 'recognizing-image',
        perceptualHash: '0000000000000000',
      },
    });
    store.put('receipts', matching);
    store.put('receipts', receipt);

    const updated = applyAnalysis(
      store,
      receipt.id,
      analysis({ merchant: 'acme store', date: '2026-09-03' }),
    );

    expect(updated).toMatchObject({
      recognizedFen: 1230,
      paidFen: 1230,
      category: '耗材',
      status: 'pending',
      pendingReasons: ['suspected_duplicate'],
      duplicateIds: ['historical'],
    });
  });

  it('rejects missing, immutable, and non-recognizing receipts without partial persistence', () => {
    const archived = sampleReceipt({
      id: 'archived',
      status: 'archived',
      archivedAt: '2026-09-03T00:00:00.000Z',
    });
    const pending = sampleReceipt({ id: 'pending', status: 'pending' });
    const generated = sampleReceipt({ id: 'generated', status: 'generated' });
    store.put('receipts', archived);
    store.put('receipts', pending);
    store.put('receipts', generated);

    expect(() => applyAnalysis(store, 'missing', analysis())).toThrow('RECEIPT_NOT_FOUND');
    expect(() => applyAnalysis(store, archived.id, analysis())).toThrow('INVALID_RECEIPT_STATE');
    expect(() => applyAnalysis(store, pending.id, analysis())).toThrow('INVALID_RECEIPT_STATE');
    expect(() => applyAnalysis(store, generated.id, analysis())).toThrow('INVALID_RECEIPT_STATE');
    expect(store.get('receipts', archived.id)).toEqual(archived);
    expect(store.get('receipts', pending.id)).toEqual(pending);
    expect(store.get('receipts', generated.id)).toEqual(generated);
  });

  it('rolls back the entire transition when the recognized amount is invalid', () => {
    const receipt = sampleReceipt({
      id: 'recognizing',
      status: 'recognizing',
      analysis: null,
      recognizedFen: null,
      paidFen: null,
      category: null,
    });
    store.put('receipts', receipt);

    expect(() => applyAnalysis(store, receipt.id, analysis({ amount: '12.345' }))).toThrow(
      'INVALID_AMOUNT',
    );
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
  });
});
