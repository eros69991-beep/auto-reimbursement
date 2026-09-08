import { describe, expect, it } from 'vitest';

import { formatFen, netFen, parseFen } from './index';

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
});
