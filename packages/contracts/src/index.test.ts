import { describe, expect, it } from 'vitest';

import { formGroupLabel, formatFen, netFen, parseFen, receiptCaption } from './index';

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
