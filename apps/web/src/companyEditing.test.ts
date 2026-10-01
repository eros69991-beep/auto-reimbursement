import { describe, expect, it } from 'vitest';

import { AMOUNT_RULE, MAX_LINES, buildLines, draftsFromLines, mergedAmount, parseAmountInput, parsePeriodInput, readPayee, showFen, sumLinesFen, type LineDraft } from './companyEditing';

function row(id: number, category: LineDraft['category'], period: string, amount: string): LineDraft {
  return { id, category, period, amount };
}

describe('amount typed into a company form', () => {
  it.each([
    ['12909.49', 1_290_949],
    ['12,909.49', 1_290_949],
    ['¥12,909.49', 1_290_949],
    [' 12 909.49 ', 1_290_949],
    ['１２，９０９．４９', 1_290_949],
    ['12909', 1_290_900],
    ['12909.4', 1_290_940],
    ['0.01', 1],
    ['9999999999.99', 999_999_999_999],
    ['9,999,999,999.99', 999_999_999_999],
    ['1,234,567.89', 123_456_789],
    ['1 234 567.89', 123_456_789],
    ['1,000', 100_000],
    ['¥ 12,909.49', 1_290_949],
    ['￥12,909.49', 1_290_949],
    ['12,909.4', 1_290_940],
    ['100', 10_000],
  ])('reads %s as %d fen', (text, fen) => {
    expect(parseAmountInput(text)).toBe(fen);
  });

  it.each(['', '  ', '0', '0.00', '-5', 'abc', '12.345', '12909.', '.5', '1e3', '12元', '10000000000.00'])('refuses %j', (text) => {
    expect(parseAmountInput(text)).toBeNull();
  });

  // 逗号当小数点（114,66 就是 114.66 元）：去掉逗号会变成 11466 元，差 100 倍，所以一律不认
  it.each(['114,66', '12,34', '1,00', '1,000,00', '12 34', '1,2345', ',100', '100,', '1,,000', '1.234,56', '1,234.567', '¥', '12909.49¥', '1 2 3', '０,５０', '1234,567', '12345 678', '1234,500', '0,500', '01,234', '1,234 567', '1 234,567', '1 234.567,89'])('refuses %j instead of guessing where the decimal point is', (text) => {
    expect(parseAmountInput(text)).toBeNull();
  });
});

describe('showing an amount in the editor', () => {
  it('shows an ordinary amount as it will be written on the form', () => {
    expect(showFen(1_290_949)).toBe('12909.49');
    expect(showFen(0)).toBe('0.00');
    expect(showFen(999_999_999_999)).toBe('9999999999.99');
  });

  it('says "too large" instead of throwing when the amount is beyond what can be recorded', () => {
    expect(showFen(1_000_000_000_000)).toBe('金额过大');
    expect(showFen(2_000_000_000_000)).toBe('金额过大');
  });
});

describe('putting the items of a notice back into one amount', () => {
  it('adds the items, leaving out the ones that were never filled in', () => {
    expect(mergedAmount([row(0, '店面租金', '2026-09', '22,814.10'), row(1, '物业费', '', '50.69'), row(2, '', '', ''), row(3, '', '', '  ')])).toEqual({ fen: 2_286_479 });
  });

  it('gives 0 for a form where nothing was filled in yet', () => {
    expect(mergedAmount([row(0, '', '', ''), row(1, '', '', '')])).toEqual({ fen: 0 });
  });

  it('does not quietly count an amount it cannot read as 0, and names the item', () => {
    expect(mergedAmount([row(0, '店面租金', '', '100.00'), row(1, '物业费', '', '5o.69')])).toEqual({ error: '第 2 项的金额不对，请先改好再合回一项' });
    expect(mergedAmount([row(0, '店面租金', '', '114,66'), row(1, '物业费', '', '1.00')])).toEqual({ error: '第 1 项的金额不对，请先改好再合回一项' });
    expect(mergedAmount([row(0, '店面租金', '', '0'), row(1, '物业费', '', '1.00')])).toEqual({ error: '第 1 项的金额不对，请先改好再合回一项' });
  });

  it('refuses a total beyond what can be recorded', () => {
    expect(mergedAmount([row(0, '店面租金', '', '9999999999.99'), row(1, '物业费', '', '0.01')])).toEqual({ error: '合计金额过大，请检查' });
    expect(mergedAmount([row(0, '店面租金', '', '9999999999.98'), row(1, '物业费', '', '0.01')])).toEqual({ fen: 999_999_999_999 });
  });
});

describe('cost month typed into a company form', () => {
  it('treats empty text as "no month"', () => {
    expect(parsePeriodInput('')).toBeNull();
    expect(parsePeriodInput('   ')).toBeNull();
  });

  it.each([
    ['2026-07', '2026-07'],
    ['2026-7', '2026-07'],
    ['2026年7月', '2026-07'],
    ['2026年07月', '2026-07'],
    ['2026/7', '2026-07'],
    ['2026.07', '2026-07'],
    ['202607', '2026-07'],
    [' 2026-12 ', '2026-12'],
  ])('normalises %s to %s — the only shape the server takes', (text, expected) => {
    expect(parsePeriodInput(text)).toBe(expected);
  });

  it.each(['2026-13', '2026-00', '1999-01', 'July', '2026', '7月'])('rejects %j', (text) => {
    expect(parsePeriodInput(text)).toBe('invalid');
  });
});

describe('lines of a notice', () => {
  const notice = [
    row(0, '店面租金', '2026-09', '22,814.10'),
    row(1, '物业费', '2026-09', '5069.80'),
    row(2, '水费', '2026-07', '48.86'),
    row(3, '电费', '2026-07', '11466.87'),
    row(4, '空调能源费', '2026-07', '162.00'),
  ];

  it('adds up the amounts that can be read and counts a bad amount as zero', () => {
    expect(sumLinesFen(notice)).toBe(3_956_163);
    expect(sumLinesFen([row(0, '水费', '', '10.00'), row(1, '电费', '', '十块'), row(2, '电费', '', '')])).toBe(1000);
    expect(sumLinesFen([])).toBe(0);
  });

  it('turns the lines a receipt already has into rows, and none into no rows', () => {
    expect(draftsFromLines(undefined)).toEqual([]);
    expect(draftsFromLines([
      { category: '店面租金', fen: 2_281_410, period: '2026-09' },
      { category: '其他公账支出', fen: 5 },
    ])).toEqual([
      { id: 0, category: '店面租金', period: '2026-09', amount: '22814.10' },
      { id: 1, category: '其他公账支出', period: '', amount: '0.05' },
    ]);
  });

  it('builds what the server wants: fen as integers, months as YYYY-MM, no period when there is none', () => {
    expect(buildLines([...notice, row(5, '其他公账支出', '', '1')])).toEqual({
      lines: [
        { category: '店面租金', fen: 2_281_410, period: '2026-09' },
        { category: '物业费', fen: 506_980, period: '2026-09' },
        { category: '水费', fen: 4_886, period: '2026-07' },
        { category: '电费', fen: 1_146_687, period: '2026-07' },
        { category: '空调能源费', fen: 16_200, period: '2026-07' },
        { category: '其他公账支出', fen: 100 },
      ],
    });
    const built = buildLines([row(0, '水费', '', '1'), row(1, '电费', '', '2')]);
    expect(built).toEqual({ lines: [{ category: '水费', fen: 100 }, { category: '电费', fen: 200 }] });
    expect(JSON.stringify(built)).not.toContain('period');
  });

  it('writes a month typed in another style the way the server reads it', () => {
    expect(buildLines([row(0, '水费', '2026年7月', '1'), row(1, '电费', '2026/7', '2')])).toEqual({
      lines: [{ category: '水费', fen: 100, period: '2026-07' }, { category: '电费', fen: 200, period: '2026-07' }],
    });
  });

  it('needs at least two rows and at most twenty', () => {
    expect(buildLines([])).toEqual({ error: '至少要有 2 项；只有一项的话请点「合回一项」' });
    expect(buildLines([row(0, '水费', '', '1')])).toEqual({ error: '至少要有 2 项；只有一项的话请点「合回一项」' });
    const categories = ['肉款', '品牌管理费', '店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出'] as const;
    const months = ['2026-01', '2026-02', '2026-03'];
    const many = (count: number): LineDraft[] => Array.from({ length: count }, (_, index) => row(index, categories[index % 8]!, months[Math.floor(index / 8)]!, '1'));
    expect('lines' in buildLines(many(MAX_LINES))).toBe(true);
    expect(buildLines(many(MAX_LINES + 1))).toEqual({ error: `最多拆成 ${MAX_LINES} 项` });
  });

  it('names the row that has no category, no amount or a bad month', () => {
    expect(buildLines([row(0, '水费', '', '1'), row(1, '', '', '1')])).toEqual({ error: '第 2 项请选择分类' });
    expect(buildLines([row(0, '水费', '', '1'), row(1, '电费', '', ''), row(2, '', '', '')])).toEqual({ error: `第 2 项的金额不对：${AMOUNT_RULE}` });
    expect(buildLines([row(0, '水费', '', '0'), row(1, '电费', '', '1')])).toEqual({ error: `第 1 项的金额不对：${AMOUNT_RULE}` });
    expect(buildLines([row(0, '水费', '', '1'), row(1, '电费', '2026-13', '1')])).toEqual({ error: '第 2 项的费用月份请写成 2026-07 这样' });
  });

  it('tells the user the decimal point is a dot when an amount it cannot read is turned down', () => {
    const refused = buildLines([row(0, '水费', '', '114,66'), row(1, '电费', '', '1')]);

    expect(refused).toEqual({ error: expect.stringContaining('第 1 项的金额不对') });
    expect(AMOUNT_RULE).toContain('小数点用「.」');
    expect(AMOUNT_RULE).toContain('大于 0');
    expect(AMOUNT_RULE).toContain('两位小数');
  });

  it('refuses the same category in the same month twice, but not in different months or with and without a month', () => {
    expect(buildLines([row(0, '电费', '2026-07', '1'), row(1, '水费', '2026-07', '1'), row(2, '电费', '2026-07', '2')]))
      .toEqual({ error: '第 1 项和第 3 项的分类、月份都一样，请合并成一项' });
    expect(buildLines([row(0, '电费', '', '1'), row(1, '电费', '', '2')]))
      .toEqual({ error: '第 1 项和第 2 项的分类、月份都一样，请合并成一项' });
    // 写法不同、月份相同，规范之后才算重复
    expect(buildLines([row(0, '电费', '2026-07', '1'), row(1, '电费', '2026年7月', '2')]))
      .toEqual({ error: '第 1 项和第 2 项的分类、月份都一样，请合并成一项' });
    expect('lines' in buildLines([row(0, '电费', '2026-06', '1'), row(1, '电费', '2026-07', '2')])).toBe(true);
    expect('lines' in buildLines([row(0, '电费', '', '1'), row(1, '电费', '2026-07', '2')])).toBe(true);
  });

  it('refuses a total that is beyond what can be recorded even when every row is fine', () => {
    expect(buildLines([row(0, '肉款', '', '9999999999.99'), row(1, '电费', '', '9999999999.99')])).toEqual({ error: '合计金额过大，请检查' });
  });
});

describe('payee typed into a company form', () => {
  it('is "none" when all three are empty — that removes the payee', () => {
    expect(readPayee({ name: '', bank: '', account: '' })).toEqual({ payee: null });
    expect(readPayee({ name: '  ', bank: ' ', account: ' - ' })).toEqual({ payee: null });
  });

  it('keeps only what was filled in, without the spaces around it', () => {
    expect(readPayee({ name: ' 示例公司 ', bank: '', account: '' })).toEqual({ payee: { name: '示例公司' } });
    expect(readPayee({ name: '', bank: '示例银行', account: '' })).toEqual({ payee: { bank: '示例银行' } });
    expect(readPayee({ name: '示例公司', bank: '示例银行', account: '1234567890123456789' }))
      .toEqual({ payee: { name: '示例公司', bank: '示例银行', account: '1234567890123456789' } });
  });

  it('takes the spaces, dashes and full-width digits out of the account number', () => {
    expect(readPayee({ name: '', bank: '', account: '6217 0000 1234 5678 901' })).toEqual({ payee: { account: '6217000012345678901' } });
    expect(readPayee({ name: '', bank: '', account: '6217-0000-1234-5678-901' })).toEqual({ payee: { account: '6217000012345678901' } });
    expect(readPayee({ name: '', bank: '', account: '６２１７００００１２３４５６７８９０１' })).toEqual({ payee: { account: '6217000012345678901' } });
    expect(readPayee({ name: '', bank: '', account: 'cn12 ab34 56' })).toEqual({ payee: { account: 'cn12ab3456' } });
  });

  it('accepts 6 to 34 letters or digits and nothing else', () => {
    expect('payee' in readPayee({ name: '', bank: '', account: '123456' })).toBe(true);
    expect('payee' in readPayee({ name: '', bank: '', account: '1'.repeat(34) })).toBe(true);
    const message = '银行账号应为 6–34 位数字或字母（空格和横线会自动去掉）';
    expect(readPayee({ name: '', bank: '', account: '12345' })).toEqual({ error: message });
    expect(readPayee({ name: '', bank: '', account: '1'.repeat(35) })).toEqual({ error: message });
    expect(readPayee({ name: '', bank: '', account: '1234567890123456#' })).toEqual({ error: message });
    expect(readPayee({ name: '', bank: '', account: '账号1234567890' })).toEqual({ error: message });
  });

  it('refuses a bad account even when the name and bank are fine', () => {
    expect(readPayee({ name: '示例公司', bank: '示例银行', account: '12345' })).toHaveProperty('error');
  });
});
