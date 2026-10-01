import { describe, expect, it } from 'vitest';

import {
  ALL_CATEGORIES,
  CATEGORIES,
  COMPANY_CATEGORIES,
  canMergeReceipt,
  categoriesFor,
  categoryLedger,
  formGroupLabel,
  formatFen,
  formatPeriod,
  isLedger,
  isPeriod,
  ledgerOf,
  netFen,
  parseFen,
  parsePeriod,
  receiptCaption,
  suggestMerges,
  type Analysis,
  type Receipt,
} from './index';

describe('exact money helpers', () => {
  it('calculates exact fen and rejects uncertain input', () => {
    expect(parseFen('36.33') + parseFen('17.30')).toBe(5363);
    expect(formatFen(5363)).toBe('53.63');
    expect(() => parseFen('1.001')).toThrow('INVALID_AMOUNT');
    expect(() => parseFen('1e2')).toThrow('INVALID_AMOUNT');
    expect(netFen({ paidFen: 30000, refundFen: 8000 })).toBe(22000);
  });

  it.each(['-1', '+1', '1,00', '.50', '1.', '', ' 1', '1 '])(
    'rejects the invalid amount format %j',
    (value) => {
      expect(() => parseFen(value)).toThrow('INVALID_AMOUNT');
    },
  );

  it('accepts the maximum amount and rejects overflow', () => {
    expect(parseFen('9999999999.99')).toBe(999999999999);
    expect(() => parseFen('10000000000.00')).toThrow('AMOUNT_OVERFLOW');
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    'rejects invalid integer fen values when formatting %j',
    (value) => {
      expect(() => formatFen(value)).toThrow('INVALID_AMOUNT');
    },
  );

  it('pads accepted decimal forms exactly', () => {
    expect(parseFen('0')).toBe(0);
    expect(parseFen('1.2')).toBe(120);
    expect(formatFen(0)).toBe('0.00');
    expect(formatFen(999999999999)).toBe('9999999999.99');
  });

  it.each([
    { paidFen: null, refundFen: 0 },
    { paidFen: 1000, refundFen: -1 },
    { paidFen: 1000, refundFen: 1001 },
    { paidFen: 1000, refundFen: 1.5 },
  ])('rejects invalid refund state %#', (receipt) => {
    expect(() => netFen(receipt)).toThrow('INVALID_REFUND');
  });

  it('allows a full refund to net to zero', () => {
    expect(netFen({ paidFen: 1000, refundFen: 1000 })).toBe(0);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 1000000000000])(
    'rejects invalid paid fen %s before calculating net',
    (paidFen) => {
      expect(() => netFen({ paidFen, refundFen: 0 })).toThrow(
        'INVALID_REFUND',
      );
    },
  );

  it('allows the maximum paid fen boundary', () => {
    expect(netFen({ paidFen: 999999999999, refundFen: 0 })).toBe(
      999999999999,
    );
  });
});

describe('form group labels', () => {
  it('writes the plain category name unless the category continues from an earlier form', () => {
    expect(formGroupLabel({ category: '食材' })).toBe('食材');
    expect(formGroupLabel({ category: '食材', part: 1 })).toBe('食材');
    expect(formGroupLabel({ category: '食材', part: 2 })).toBe('食材（续）');
    expect(formGroupLabel({ category: '百慕达食材', part: 3 })).toBe('百慕达食材（续）');
  });
});

describe('receipt caption', () => {
  it('says which form, which receipt of the category, its amount and the category total', () => {
    expect(receiptCaption({
      sheetNumber: 1,
      group: { category: '食材', totalFen: 74148 },
      position: 2,
      count: 3,
      netFen: 1988,
    })).toBe('第 1 张报销单 · 食材 第 2/3 张 · 本张 19.88 · 食材合计 741.48');
  });

  it('counts and totals each part of a category that continues on the next form separately', () => {
    expect(receiptCaption({
      sheetNumber: 2,
      group: { category: '食材', part: 2, totalFen: 100020 },
      position: 10,
      count: 10,
      netFen: 10009,
    })).toBe('第 2 张报销单 · 食材（续） 第 10/10 张 · 本张 100.09 · 食材（续）合计 1000.20');
    expect(receiptCaption({
      sheetNumber: 1,
      group: { category: '食材', part: 1, totalFen: 300000 },
      position: 1,
      count: 30,
      netFen: 10000,
    })).toBe('第 1 张报销单 · 食材 第 1/30 张 · 本张 100.00 · 食材合计 3000.00');
  });
});

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    amount: '588.00',
    category: '百慕达食材',
    merchant: '武汉仓',
    date: '2026-09-03',
    confidence: { amount: 0.99, category: 0.98 },
    ambiguous: false,
    keywords: [],
    evidence: '',
    ...overrides,
  };
}

function receipt(order: number, overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: `r${order}`,
    original: {
      id: `image-${order}`,
      path: `2026-09/originals/image-${order}.png`,
      mime: 'image/png',
      sha256: '0'.repeat(64),
      perceptualHash: '0000000000000000',
      bytes: 100,
      width: 10,
      height: 10,
      deletedAt: null,
    },
    refundImages: [],
    month: '2026-09',
    uploadedAt: '2026-09-03T10:00:00.000Z',
    uploadOrder: order,
    analysis: analysis(),
    recognizedFen: 58800,
    paidFen: 58800,
    refundFen: 0,
    category: '百慕达食材',
    merchant: '武汉仓',
    date: '2026-09-03',
    status: 'ready',
    pendingReasons: [],
    duplicateIds: [],
    duplicateOverride: false,
    attempts: 0,
    nextAttemptAt: null,
    batchId: null,
    archivedAt: null,
    statusBeforeArchive: null,
    deletedAt: null,
    ...overrides,
  };
}

// 只有商品清单、读不出实付金额的那一半
function half(order: number, overrides: Partial<Receipt> = {}): Receipt {
  return receipt(order, {
    status: 'pending',
    pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
    analysis: analysis({ amount: null, incomplete: true }),
    recognizedFen: null,
    paidFen: null,
    ...overrides,
  });
}

describe('canMergeReceipt', () => {
  it('allows receipts that are pending or ready and not yet used anywhere', () => {
    expect(canMergeReceipt(receipt(1))).toBe(true);
    expect(canMergeReceipt(half(1))).toBe(true);
  });

  it.each<[string, Partial<Receipt>]>([
    ['being recognized', { status: 'recognizing' }],
    ['in a report', { status: 'generated', batchId: 'batch-1' }],
    ['archived', { status: 'archived', archivedAt: '2026-09-30T00:00:00.000Z' }],
    ['deleted', { deletedAt: '2026-09-04T00:00:00.000Z' }],
    ['refunded', { refundFen: 100 }],
    ['holding refund images', { refundImages: [receipt(9).original] }],
    ['already merged from others', { mergedFrom: ['a', 'b'] }],
    ['hidden by a merge', { mergedInto: 'merged' }],
    ['without its original image', { original: { ...receipt(1).original, deletedAt: '2026-09-30T00:00:00.000Z' } }],
  ])('refuses a receipt that is %s', (_name, overrides) => {
    expect(canMergeReceipt(receipt(1, overrides))).toBe(false);
  });
});

describe('suggestMerges', () => {
  it('suggests two neighbours of one upload when one of them has no payment amount', () => {
    expect(suggestMerges([half(1), receipt(2, { status: 'pending', pendingReasons: ['category_uncertain'] })])).toEqual([
      { receiptIds: ['r1', 'r2'], basis: ['merchant', 'date'] },
    ]);
  });

  it('puts the receipts left to right in upload order, whatever order they are passed in', () => {
    const suggestions = suggestMerges([receipt(8), half(7)]);
    expect(suggestions).toEqual([{ receiptIds: ['r7', 'r8'], basis: ['merchant', 'date'] }]);
    expect(suggestMerges([half(7), receipt(8)])).toEqual(suggestions);
  });

  it('counts an ambiguous amount and an AI-flagged screenshot as incomplete too', () => {
    const ambiguous = receipt(1, {
      status: 'pending',
      analysis: analysis({ amount: null, ambiguous: true }),
    });
    expect(suggestMerges([ambiguous, receipt(2)])).toHaveLength(1);
    const flagged = receipt(1, { analysis: analysis({ incomplete: true }) });
    expect(suggestMerges([flagged, receipt(2)])).toHaveLength(1);
  });

  it('stays quiet when both receipts look complete', () => {
    expect(suggestMerges([receipt(1), receipt(2)])).toEqual([]);
  });

  it('needs the same merchant or date, and never pairs conflicting ones', () => {
    expect(
      suggestMerges([half(1, { merchant: '甲店', analysis: analysis({ amount: null, merchant: '甲店' }) }), receipt(2)]),
    ).toEqual([]);
    expect(suggestMerges([half(1, { date: '2026-09-01' }), receipt(2)])).toEqual([]);
    // 一边缺商户（或日期）时，只要另一项相同、没有冲突就可以
    expect(suggestMerges([half(1, { merchant: null }), receipt(2)])).toEqual([
      { receiptIds: ['r1', 'r2'], basis: ['date'] },
    ]);
    expect(suggestMerges([half(1, { date: null }), receipt(2)])).toEqual([
      { receiptIds: ['r1', 'r2'], basis: ['merchant'] },
    ]);
    // 两项都对不上（没有任何相同的依据）不提示
    expect(suggestMerges([half(1, { merchant: null }), receipt(2, { date: null })])).toEqual([]);
  });

  it('compares merchants ignoring spaces, case and full-width characters', () => {
    expect(
      suggestMerges([half(1, { merchant: ' ＷＵＨＡＮ 仓 ' }), receipt(2, { merchant: 'wuhan仓' })])[0]?.basis,
    ).toContain('merchant');
  });

  it('only pairs receipts uploaded within ten minutes of each other', () => {
    expect(
      suggestMerges([half(1), receipt(2, { uploadedAt: '2026-09-03T10:10:00.000Z' })]),
    ).toHaveLength(1);
    expect(
      suggestMerges([half(1), receipt(2, { uploadedAt: '2026-09-03T10:10:01.000Z' })]),
    ).toEqual([]);
  });

  it('looks at neighbours up to three places away because uploads run in parallel', () => {
    const fillers = (from: number, count: number): Receipt[] =>
      Array.from({ length: count }, (_value, index) =>
        receipt(from + index, { merchant: `别的店${index}`, date: '2026-08-01', analysis: analysis({ merchant: `别的店${index}`, date: '2026-08-01' }) }));
    expect(suggestMerges([half(1), ...fillers(2, 2), receipt(4)])).toEqual([
      { receiptIds: ['r1', 'r4'], basis: ['merchant', 'date'] },
    ]);
    expect(suggestMerges([half(1), ...fillers(2, 3), receipt(5)])).toEqual([]);
  });

  it('uses each receipt in at most one suggestion and prefers the nearest partner', () => {
    expect(suggestMerges([half(1), half(2), half(3)])).toEqual([
      { receiptIds: ['r1', 'r2'], basis: ['merchant', 'date'] },
    ]);
    const four = suggestMerges([half(1), half(2), half(3), half(4)]);
    expect(four.map((suggestion) => suggestion.receiptIds)).toEqual([
      ['r1', 'r2'],
      ['r3', 'r4'],
    ]);
  });

  it('trusts matching order numbers over everything else', () => {
    const a = half(1, { merchant: null, date: null, analysis: analysis({ amount: null, merchant: null, date: null, orderNo: 'WH-001' }) });
    const b = receipt(2, { merchant: null, date: null, analysis: analysis({ merchant: null, date: null, orderNo: ' wh-001 ' }) });
    expect(suggestMerges([a, b])).toEqual([{ receiptIds: ['r1', 'r2'], basis: ['orderNo'] }]);
    // 订单号相同的两张，即使都看起来完整也是同一单
    const complete = receipt(1, { analysis: analysis({ orderNo: 'WH-001' }) });
    expect(suggestMerges([complete, b])).toEqual([{ receiptIds: ['r1', 'r2'], basis: ['orderNo'] }]);
  });

  it('never pairs receipts whose order numbers differ, even if everything else matches', () => {
    const a = half(1, { analysis: analysis({ amount: null, incomplete: true, orderNo: 'WH-001' }) });
    const b = receipt(2, { analysis: analysis({ orderNo: 'WH-002' }) });
    expect(suggestMerges([a, b])).toEqual([]);
  });

  it('prefers the partner with the same order number over a nearer look-alike', () => {
    const a = half(1, { analysis: analysis({ amount: null, incomplete: true, orderNo: 'WH-001' }) });
    const nearer = receipt(2, { analysis: analysis({ orderNo: null }) });
    const same = receipt(3, { analysis: analysis({ orderNo: 'WH-001' }) });
    expect(suggestMerges([a, nearer, same])).toEqual([
      { receiptIds: ['r1', 'r3'], basis: ['orderNo'] },
    ]);
  });

  it('skips receipts that cannot be merged or have not been read yet, and repeated ids', () => {
    expect(suggestMerges([half(1), receipt(2, { batchId: 'batch-1', status: 'generated' })])).toEqual([]);
    expect(suggestMerges([half(1), receipt(2, { deletedAt: '2026-09-04T00:00:00.000Z' })])).toEqual([]);
    expect(suggestMerges([half(1), receipt(2, { analysis: null })])).toEqual([]);
    expect(suggestMerges([half(1), receipt(2, { mergedFrom: ['x', 'y'] })])).toEqual([]);
    // 待处理和报销池两份列表里的同一张只算一次
    expect(suggestMerges([half(1), receipt(2), receipt(2), half(1)])).toEqual([
      { receiptIds: ['r1', 'r2'], basis: ['merchant', 'date'] },
    ]);
  });
});

describe('ledgers and company categories', () => {
  it('keeps the two ledgers\' categories apart and knows which ledger a category belongs to', () => {
    expect(COMPANY_CATEGORIES).toEqual([
      '肉款',
      '品牌管理费',
      '店面租金',
      '物业费',
      '水费',
      '电费',
      '空调能源费',
      '其他公账支出',
    ]);
    expect(CATEGORIES.some((category) => (COMPANY_CATEGORIES as readonly string[]).includes(category))).toBe(false);
    expect(ALL_CATEGORIES).toHaveLength(CATEGORIES.length + COMPANY_CATEGORIES.length);
    expect(categoriesFor('store')).toBe(CATEGORIES);
    expect(categoriesFor('company')).toBe(COMPANY_CATEGORIES);
    for (const category of CATEGORIES) expect(categoryLedger(category)).toBe('store');
    for (const category of COMPANY_CATEGORIES) expect(categoryLedger(category)).toBe('company');
    // 店内原有的「肉类」「租金及管理费」不动，也不会被当成公账分类
    expect(categoryLedger('肉类')).toBe('store');
    expect(categoryLedger('租金及管理费')).toBe('store');
  });

  it('treats a row without a ledger, or with one it does not know, as the store', () => {
    expect(ledgerOf({})).toBe('store');
    expect(ledgerOf({ ledger: 'store' })).toBe('store');
    expect(ledgerOf({ ledger: 'company' })).toBe('company');
    expect(ledgerOf(null)).toBe('store');
    expect(ledgerOf(undefined)).toBe('store');
    expect(ledgerOf({ ledger: 'other' as never })).toBe('store');
    expect(isLedger('store')).toBe(true);
    expect(isLedger('company')).toBe(true);
    for (const value of ['', 'Company', 'both', null, undefined, 1, {}]) expect(isLedger(value)).toBe(false);
  });
});

describe('expense months', () => {
  it('accepts only YYYY-MM from 2000 to 2099 with a month from 01 to 12', () => {
    for (const value of ['2026-07', '2026-09', '2000-01', '2099-12', '2026-10', '2026-12']) {
      expect(isPeriod(value)).toBe(true);
    }
    for (const value of [
      '2026-7',
      '2026-00',
      '2026-13',
      '1999-12',
      '2100-01',
      '2026-07-01',
      '2026年7月',
      ' 2026-07',
      '2026-07 ',
      '',
      null,
      undefined,
      202607,
    ]) {
      expect(isPeriod(value)).toBe(false);
    }
  });

  it('reads the ways a month is written on bank receipts and fee notices', () => {
    const accepted: Array<[string, string]> = [
      ['2026-07', '2026-07'],
      ['2026-7', '2026-07'],
      ['2026年7月', '2026-07'],
      ['2026年07月', '2026-07'],
      ['2026年 7 月', '2026-07'],
      ['2026年12月', '2026-12'],
      ['2026/7', '2026-07'],
      ['2026/07', '2026-07'],
      ['2026.07', '2026-07'],
      ['2026.7月', '2026-07'],
      ['202607', '2026-07'],
      ['２０２６年９月', '2026-09'],
      ['  2026-09  ', '2026-09'],
    ];
    for (const [written, period] of accepted) expect(parsePeriod(written)).toBe(period);
  });

  it('does not guess when a month cannot be read', () => {
    for (const value of [
      '',
      '7月',
      '2026',
      '2026年',
      '2026年0月',
      '2026年13月',
      '2026-13',
      '2026-00',
      '1999年7月',
      '2026年7月1日',
      '2026-07-15',
      '上个月',
      null,
      undefined,
      202607,
      {},
    ]) {
      expect(parsePeriod(value)).toBeNull();
    }
  });

  it('writes a month the way the payment form shows it', () => {
    expect(formatPeriod('2026-07')).toBe('2026年7月');
    expect(formatPeriod('2026-09')).toBe('2026年9月');
    expect(formatPeriod('2026-12')).toBe('2026年12月');
    expect(formatPeriod('2031-01')).toBe('2031年1月');
    for (const written of ['2026年7月', '2026-7', '202609']) {
      expect(isPeriod(parsePeriod(written))).toBe(true);
      expect(formatPeriod(parsePeriod(written)!)).toMatch(/^2026年(7|9)月$/);
    }
  });
});
