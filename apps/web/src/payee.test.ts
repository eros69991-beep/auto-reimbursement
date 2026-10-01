import { describe, expect, it } from 'vitest';

import { payeeRows } from './payee';

describe('payee rows', () => {
  it('lists name, bank and account, in that order, under the labels of the screen', () => {
    expect(payeeRows({ account: '1234567890123456789', name: '示例公司', bank: '示例银行' })).toEqual([
      ['收款户名', '示例公司'],
      ['开户银行', '示例银行'],
      ['银行账号', '1234567890123456789'],
    ]);
  });

  it('leaves out what is missing or empty', () => {
    expect(payeeRows({ name: '示例公司' })).toEqual([['收款户名', '示例公司']]);
    expect(payeeRows({ bank: '示例银行', account: '1234567890123456789' })).toEqual([
      ['开户银行', '示例银行'],
      ['银行账号', '1234567890123456789'],
    ]);
    expect(payeeRows({ name: '', bank: '示例银行', account: '' })).toEqual([['开户银行', '示例银行']]);
  });

  it('gives nothing for no payee, or for a payee with nothing in it', () => {
    expect(payeeRows(undefined)).toEqual([]);
    expect(payeeRows({})).toEqual([]);
    expect(payeeRows({ name: '', bank: '', account: '' })).toEqual([]);
  });
});
