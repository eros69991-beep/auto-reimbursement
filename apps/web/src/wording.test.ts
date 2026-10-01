import { describe, expect, it } from 'vitest';

import { LEDGER_NAMES, sayFor } from './wording';

describe('wording for the two ledgers', () => {
  const store = sayFor('store');
  const company = sayFor('company');

  it('shows the store wording exactly as written', () => {
    for (const text of ['本期报销池', '生成报销单', '上传凭证', '确认可报销', '部门', '报销人', '历史报销单', '生成预览', '撤销并退回报销池']) {
      expect(store(text)).toBe(text);
    }
  });

  it.each([
    ['本期报销池', '本期付款池'],
    ['报销池汇总', '付款池汇总'],
    ['生成报销单', '生成付款单'],
    ['历史报销单', '历史付款单'],
    ['上传凭证', '上传回单'],
    ['确认可报销', '确认可付款'],
    ['全选可报销（3 张）', '全选可付款（3 张）'],
    ['加入本次报销', '加入本次付款'],
    ['移出本次报销池', '移出本次付款池'],
    ['撤销本单报销', '撤销本单付款'],
    ['部门', '付款单位'],
    ['报销人', '经办人'],
    ['签名人', '经办人'],
    ['锁定：部门 甲、报销人 乙', '锁定：付款单位 甲、经办人 乙'],
    ['已生成 PDF，报销单已定稿，部门、日期、签名人与备注不可直接修改。', '已生成 PDF，付款单已定稿，付款单位、日期、经办人与备注不可直接修改。'],
    ['请先在报销池生成报销单，或从历史报销单中选择一个批次。', '请先在付款池生成付款单，或从历史付款单中选择一个批次。'],
    ['已生成报销单', '已生成付款单'],
    ['删除凭证', '删除回单'],
    ['可报销', '可付款'],
  ])('says %s as %s in the company ledger', (text, expected) => {
    expect(company(text)).toBe(expected);
  });

  it('replaces every occurrence of a word, not just the first one', () => {
    expect(company('报销单、报销单、报销单')).toBe('付款单、付款单、付款单');
    expect(company('报销 报销池 报销人 报销')).toBe('付款 付款池 经办人 付款');
  });

  it('gives the preview page its own name', () => {
    expect(store('生成预览')).toBe('生成预览');
    expect(company('生成预览')).toBe('付款单预览');
  });

  it('keeps the name of the full PDF preview readable', () => {
    expect(store('完整报销 PDF 预览')).toBe('完整报销 PDF 预览');
    expect(company('完整报销 PDF 预览')).toBe('完整付款单 PDF 预览');
  });

  it('leaves text that has none of those words alone', () => {
    expect(company('待处理')).toBe('待处理');
    expect(company('设置')).toBe('设置');
    expect(company('查看已移出 / 回收站')).toBe('查看已移出 / 回收站');
  });

  it('can be applied twice without changing the result again', () => {
    for (const text of ['本期报销池', '确认可报销', '部门 报销人 凭证']) {
      expect(company(company(text))).toBe(company(text));
    }
  });

  it('never renames the store area itself when it shows up in a sentence', () => {
    // 后台在店内和公账的凭证混到一起时的报错，两个区的名字都在句子里
    expect(company('店内报销和公账付款的凭证不能放在同一张单上')).toBe('店内报销和公账付款的回单不能放在同一张单上');
    expect(company('店内报销和公账付款的凭证不能合并')).toBe('店内报销和公账付款的回单不能合并');
    expect(company('店内报销、店内报销，报销')).toBe('店内报销、店内报销，付款');
    expect(store('店内报销和公账付款的凭证不能合并')).toBe('店内报销和公账付款的凭证不能合并');
  });

  it('names the two areas', () => {
    expect(LEDGER_NAMES).toEqual({ store: '店内报销', company: '公账付款' });
  });
});
