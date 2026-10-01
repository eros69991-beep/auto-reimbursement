import { describe, expect, it } from 'vitest';

import { receipt } from './test/fixtures';
import { receiptAmountText, receiptLabel } from './receiptLabel';

describe('receiptLabel', () => {
  it('writes 分类 · 金额', () => {
    expect(receiptLabel(receipt({ category: '食材', paidFen: 12000, refundFen: 0 }))).toBe('食材 · 120.00');
  });

  it('shows the amount actually spent: refunds already registered on old data are deducted', () => {
    const refunded = receipt({ category: '食材', paidFen: 12000, refundFen: 8000 });
    expect(receiptAmountText(refunded)).toBe('40.00');
    expect(receiptLabel(refunded)).toBe('食材 · 40.00');
    // 全额退款：实际花的钱是 0，照实显示（报销池里它不可勾选）
    expect(receiptAmountText(receipt({ paidFen: 2000, refundFen: 2000 }))).toBe('0.00');
  });

  it('says what is still unknown instead of showing blanks or internal ids', () => {
    expect(receiptLabel(receipt({ category: null, paidFen: 3633 }))).toBe('分类待确认 · 36.33');
    expect(receiptLabel(receipt({ category: '耗材', paidFen: null }))).toBe('耗材 · 金额待确认');
    expect(receiptLabel(receipt({ category: null, paidFen: null }))).toBe('分类待确认 · 金额待确认');
  });

  it('degrades on dirty legacy data (refund larger than the amount paid) instead of throwing', () => {
    const dirty = receipt({ category: '耗材', paidFen: 2000, refundFen: 3000 });
    expect(receiptAmountText(dirty)).toBe('金额异常，请重新填写');
    expect(receiptLabel(dirty)).toBe('耗材 · 金额异常，请重新填写');
  });

  it('names the month of a company receipt, and counts the items of a notice that was split', () => {
    expect(receiptLabel(receipt({ category: '电费', period: '2026-07', paidFen: 1146687 }))).toBe('电费（2026年7月） · 11466.87');
    expect(receiptLabel(receipt({ category: '肉款', paidFen: 1290949 }))).toBe('肉款 · 12909.49');
    const notice = receipt({
      category: '店面租金',
      paidFen: 3956163,
      lines: [{ category: '店面租金', fen: 2281410, period: '2026-09' }, { category: '电费', fen: 1146687, period: '2026-07' }],
    });
    expect(receiptLabel(notice)).toBe('含 2 项 · 39561.63');
    // 没有分类、没有金额也照常说清还缺什么
    expect(receiptLabel(receipt({ category: null, paidFen: null }))).toBe('分类待确认 · 金额待确认');
  });

  it('never uses the merchant name or the id', () => {
    const label = receiptLabel(receipt({ id: 'internal-id-123', merchant: '某某商户' }));
    expect(label).not.toContain('某某商户');
    expect(label).not.toContain('internal-id-123');
  });
});
