import { describe, expect, it } from 'vitest';

import { chineseUppercase } from '../src/uppercase.js';

describe('chineseUppercase', () => {
  it.each([
    [0, '零元整'],
    [1, '零元壹分'],
    [10, '零元壹角'],
    [100, '壹元整'],
    [101, '壹元零壹分'],
    [110, '壹元壹角'],
    [100100, '壹仟零壹元整'],
    [1000100, '壹万零壹元整'],
    [100000001, '壹佰万元零壹分'],
    [123456789, '壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分'],
  ])('formats %s as %s', (fen, text) => {
    expect(chineseUppercase(fen)).toBe(text);
  });

  it.each([10000000100, 100100000])('formats large amount %s', (fen) => {
    expect(chineseUppercase(fen)).toBe(
      fen === 10000000100 ? '壹亿零壹元整' : '壹佰万壹仟元整',
    );
  });

  it.each([-1, 1.5, 1_000_000_000_000, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity])(
    'rejects invalid fen %s',
    (fen) => {
      expect(() => chineseUppercase(fen)).toThrow('INVALID_AMOUNT');
    },
  );
});
