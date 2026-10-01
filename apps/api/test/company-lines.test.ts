import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formGroupLabel,
  type Batch,
  type Category,
  type FormGroup,
  type FormSheet,
  type Payee,
  type Receipt,
  type ReceiptLine,
  type Snapshot,
} from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createBatch,
  moveBatchGroup,
  poolTotals,
  updateBatchLayout,
} from '../src/batches.js';
import { MAX_LINES, parseLinesInput, parsePayeeInput, parsePeriodInput } from '../src/company.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { listRules } from '../src/learning.js';
import { confirmReceipt, updateReceipt } from '../src/receipts.js';
import { isEligible } from '../src/refunds.js';
import { linesCaption, orderedAttachments } from '../src/render/attachments.js';
import { createFormDocument, drawForm, formMetrics, sheetAttachmentCount } from '../src/render/form.js';
import {
  groupItems,
  moveGroup,
  packGroups,
  type LayoutMetrics,
} from '../src/render/layout.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { sampleReceipt } from './support.js';

// 假的银行账号：真通知单上的号码不出现在代码、测试和文档里。
const ACCOUNT_A = '1234567890123456789';
const ACCOUNT_B = '9876543210987654321';

// 收费通知单（武汉远洋里）的五项，合计 39,561.63
const noticeLines: ReceiptLine[] = [
  { category: '店面租金', fen: 2281410, period: '2026-09' },
  { category: '物业费', fen: 506980, period: '2026-09' },
  { category: '水费', fen: 4886, period: '2026-07' },
  { category: '电费', fen: 1146687, period: '2026-07' },
  { category: '空调能源费', fen: 16200, period: '2026-07' },
];
const NOTICE_FEN = 3956163;
const MEAT_FEN = 1290949;
const BRAND_FEN = 678500;

const noticePayee: Payee = { name: '武汉丝路合创商业管理有限公司', bank: '中信银行武汉分行营业部', account: ACCOUNT_A };
const meatPayee: Payee = { name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: ACCOUNT_B };

// 测试用的量尺：每个字符宽 5，摘要栏宽 130（放得下 3 个 5 位金额），一行高 20，表体 5 行。
const metrics: LayoutMetrics = {
  summaryWidth: 130,
  bodyHeight: 100,
  lineHeight: 10,
  groupPadding: 10,
  maxSheetFen: 999999999,
  measure: (text) => text.length * 5,
};

function snap(
  receiptId: string,
  uploadOrder: number,
  category: Category,
  netFen: number,
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    receiptId,
    uploadOrder,
    category,
    netFen,
    paidFen: netFen,
    refundFen: 0,
    original: sampleReceipt().original,
    refundImages: [],
    ...extra,
  };
}

function companyReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return sampleReceipt({ ledger: 'company', category: '肉款', ...overrides });
}

/** 两张回单加一张通知单：肉款、品牌管理费、通知单（五项） */
function exampleReceipts(): Receipt[] {
  return [
    companyReceipt({ id: 'meat', uploadOrder: 1, category: '肉款', paidFen: MEAT_FEN, recognizedFen: MEAT_FEN, payee: meatPayee }),
    companyReceipt({
      id: 'brand',
      uploadOrder: 2,
      category: '品牌管理费',
      paidFen: BRAND_FEN,
      recognizedFen: BRAND_FEN,
      payee: { name: '武汉市火门品牌管理有限公司', bank: '中国工商银行武汉分行', account: ACCOUNT_B },
    }),
    companyReceipt({
      id: 'notice',
      uploadOrder: 3,
      category: '店面租金',
      paidFen: NOTICE_FEN,
      recognizedFen: NOTICE_FEN,
      lines: noticeLines,
      payee: noticePayee,
    }),
  ];
}

function labels(sheets: FormSheet[]): string[][] {
  return sheets.map((sheet) => sheet.groups.map((group) => formGroupLabel(group)));
}

describe('reading what a person typed', () => {
  const two = (extra: Record<string, unknown> = {}): unknown[] => [
    { category: '电费', fen: 100, ...extra },
    { category: '水费', fen: 200 },
  ];

  it('takes two to twenty items and nothing outside that', () => {
    expect(MAX_LINES).toBe(20);
    expect(parseLinesInput(two())).toEqual([{ category: '电费', fen: 100 }, { category: '水费', fen: 200 }]);
    const months = Array.from({ length: 20 }, (_, index) => ({
      category: '电费',
      fen: index + 1,
      period: `${2026 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
    }));
    expect(parseLinesInput(months)).toHaveLength(20);
    expect(() => parseLinesInput([...months, { category: '水费', fen: 1 }])).toThrow('INVALID_LINES');
    expect(() => parseLinesInput(months.slice(0, 1))).toThrow('INVALID_LINES');
    expect(() => parseLinesInput(undefined)).toThrow('INVALID_LINES');
    expect(() => parseLinesInput(null)).toThrow('INVALID_LINES');
  });

  it('takes an amount from one fen up to the largest the form can write', () => {
    expect(parseLinesInput([{ category: '电费', fen: 1 }, { category: '水费', fen: 999_999_999_999 }])).toHaveLength(2);
    for (const fen of [0, -1, 1_000_000_000_000, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1.5, '1', null, undefined]) {
      expect(() => parseLinesInput([{ category: '电费', fen }, { category: '水费', fen: 1 }])).toThrow('INVALID_LINES');
    }
  });

  it('copies only the category, the amount and the month, and keeps the order given', () => {
    const lines = parseLinesInput([
      { category: '水费', fen: 5, period: '2026-07', note: 'x', merchant: 'y' },
      { category: '电费', fen: 7, period: null },
    ]);
    expect(lines).toEqual([{ category: '水费', fen: 5, period: '2026-07' }, { category: '电费', fen: 7 }]);
    expect(Object.keys(lines[1]!)).toEqual(['category', 'fen']);
  });

  it('reads a month as YYYY-MM, or as none', () => {
    expect(parsePeriodInput('2026-07')).toBe('2026-07');
    for (const none of [undefined, null, '']) expect(parsePeriodInput(none)).toBeNull();
    for (const bad of ['2026-7', '2026年7月', '2026-13', ' 2026-07', 202607, {}, []]) {
      expect(() => parsePeriodInput(bad)).toThrow('INVALID_PERIOD');
    }
  });

  it('reads a payee leniently about spaces and strictly about everything else', () => {
    expect(parsePayeeInput({ name: ' 甲  公司 ', bank: ' 某银行 ', account: ' 6222-0200 0000 1234 ' })).toEqual({
      name: '甲 公司',
      bank: '某银行',
      account: '6222020000001234',
    });
    expect(parsePayeeInput({ bank: '某银行' })).toEqual({ bank: '某银行' });
    expect(parsePayeeInput(null)).toBeNull();
    expect(parsePayeeInput({})).toBeNull();
    expect(parsePayeeInput({ name: '', bank: '  ', account: ' - ' })).toBeNull();
    expect(parsePayeeInput({ name: null, bank: undefined, account: null })).toBeNull();
    // 长度：户名、开户行 100 字，账号 6 到 34 位
    expect(parsePayeeInput({ name: '长'.repeat(100) })?.name).toHaveLength(100);
    expect(parsePayeeInput({ account: '123456' })?.account).toBe('123456');
    expect(parsePayeeInput({ account: '1'.repeat(34) })?.account).toHaveLength(34);
    for (const payee of [{ name: '长'.repeat(101) }, { bank: '长'.repeat(101) }, { account: '12345' }, { account: '1'.repeat(35) }, { account: '1234 56*8' }, { account: 123456 }, { name: 1 }, [], 'x', 5, true]) {
      expect(() => parsePayeeInput(payee)).toThrow('INVALID_PAYEE');
    }
  });
});

describe('rows are a category and a month', () => {
  it('puts each item of a fee notice on its own row, labelled with its month', () => {
    const groups = groupItems([
      snap('meat', 1, '肉款', MEAT_FEN),
      snap('brand', 2, '品牌管理费', BRAND_FEN),
      snap('notice', 3, '店面租金', NOTICE_FEN, { lines: noticeLines }),
    ]);
    expect(groups.map((group) => formGroupLabel(group))).toEqual([
      '肉款',
      '品牌管理费',
      '店面租金（2026年9月）',
      '物业费（2026年9月）',
      '水费（2026年7月）',
      '电费（2026年7月）',
      '空调能源费（2026年7月）',
    ]);
    expect(groups.slice(2)).toEqual(
      noticeLines.map((line) => ({
        category: line.category,
        period: line.period,
        receiptIds: ['notice'],
        amountsFen: [line.fen],
        totalFen: line.fen,
      })),
    );
    // 各行加起来正好是三张凭证的合计
    expect(groups.reduce((sum, group) => sum + group.totalFen, 0)).toBe(MEAT_FEN + BRAND_FEN + NOTICE_FEN);
  });

  it('keeps the same category in different months on different rows, and the same month on one row', () => {
    const groups = groupItems([
      snap('d', 4, '电费', 40000),
      snap('a', 1, '电费', 10000, { period: '2026-07' }),
      snap('c', 3, '电费', 30000, { period: '2026-07' }),
      snap('b', 2, '电费', 20000, { period: '2026-08' }),
    ]);
    expect(groups.map((group) => [formGroupLabel(group), group.receiptIds, group.amountsFen, group.totalFen])).toEqual([
      ['电费（2026年7月）', ['a', 'c'], [10000, 30000], 40000],
      ['电费（2026年8月）', ['b'], [20000], 20000],
      ['电费', ['d'], [40000], 40000],
    ]);
  });

  it('puts an item of a notice on the row of a single-category receipt with the same category and month', () => {
    const groups = groupItems([
      snap('single', 1, '电费', 500, { period: '2026-07' }),
      snap('notice', 2, '店面租金', NOTICE_FEN, { lines: noticeLines }),
    ]);
    const electricity = groups.find((group) => group.category === '电费')!;
    expect(electricity).toEqual({
      category: '电费',
      period: '2026-07',
      receiptIds: ['single', 'notice'],
      amountsFen: [500, 1146687],
      totalFen: 1147187,
    });
    expect(groups).toHaveLength(5);
  });

  it('never lists a receipt twice on one row, even when its items repeat a category and month', () => {
    const groups = groupItems([
      snap('x', 1, '电费', 350, {
        lines: [
          { category: '电费', fen: 100, period: '2026-07' },
          { category: '水费', fen: 50, period: '2026-07' },
          { category: '电费', fen: 250, period: '2026-07' },
        ],
      }),
    ]);
    expect(groups.map((group) => [group.category, group.receiptIds, group.amountsFen, group.totalFen])).toEqual([
      ['电费', ['x'], [350], 350],
      ['水费', ['x'], [50], 50],
    ]);
  });

  it('leaves store rows exactly as before: no month, same keys', () => {
    const [group] = groupItems([snap('a', 1, '耗材', 1000), snap('b', 2, '耗材', 2000)]);
    expect(Object.keys(group!)).toEqual(['category', 'receiptIds', 'amountsFen', 'totalFen']);
    expect(group).toEqual({ category: '耗材', receiptIds: ['a', 'b'], amountsFen: [1000, 2000], totalFen: 3000 });
  });
});

describe('packing rows onto forms', () => {
  const example = (): Snapshot[] => [
    snap('meat', 1, '肉款', MEAT_FEN),
    snap('brand', 2, '品牌管理费', BRAND_FEN),
    snap('notice', 3, '店面租金', NOTICE_FEN, { lines: noticeLines }),
  ];

  it('keeps the rows of a fee notice together on one form when they fit on a fresh one', () => {
    const groups = groupItems(example());
    expect(labels(packGroups(groups, metrics, new Set(['notice'])))).toEqual([
      ['肉款', '品牌管理费'],
      ['店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）', '电费（2026年7月）', '空调能源费（2026年7月）'],
    ]);
  });

  it('fills forms in order as before when no receipt is to be kept together', () => {
    const groups = groupItems(example());
    expect(labels(packGroups(groups, metrics))).toEqual([
      ['肉款', '品牌管理费', '店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）'],
      ['电费（2026年7月）', '空调能源费（2026年7月）'],
    ]);
    expect(labels(packGroups(groups, metrics, new Set()))).toEqual(labels(packGroups(groups, metrics)));
  });

  it('does not start a new form when the rows of the notice still fit on the current one', () => {
    const groups = groupItems([
      snap('meat', 1, '肉款', MEAT_FEN),
      snap('notice', 2, '店面租金', 300000, {
        lines: [
          { category: '店面租金', fen: 100000, period: '2026-09' },
          { category: '物业费', fen: 100000, period: '2026-09' },
          { category: '水费', fen: 100000, period: '2026-07' },
        ],
      }),
    ]);
    expect(labels(packGroups(groups, metrics, new Set(['notice'])))).toEqual([
      ['肉款', '店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）'],
    ]);
  });

  it('lets a notice with more items than one form holds run over onto the next form', () => {
    const lines: ReceiptLine[] = (['店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出'] as const).map(
      (category) => ({ category, fen: 100000, period: '2026-09' }),
    );
    const groups = groupItems([snap('meat', 1, '肉款', MEAT_FEN), snap('notice', 2, '店面租金', 600000, { lines })]);
    expect(packGroups(groups, metrics, new Set(['notice'])).map((sheet) => sheet.groups.length)).toEqual([5, 2]);
  });

  it('keeps each notice together, one after another', () => {
    const notice = (id: string, order: number, categories: Category[]): Snapshot =>
      snap(id, order, categories[0]!, categories.length * 100000, {
        lines: categories.map((category) => ({ category, fen: 100000, period: '2026-09' })),
      });
    const groups = groupItems([
      notice('n1', 1, ['店面租金', '物业费']),
      notice('n2', 2, ['水费', '电费']),
      notice('n3', 3, ['空调能源费', '其他公账支出']),
    ]);
    expect(
      packGroups(groups, metrics, new Set(['n1', 'n2', 'n3'])).map((sheet) => sheet.groups.map((group) => group.category)),
    ).toEqual([
      ['店面租金', '物业费', '水费', '电费'],
      ['空调能源费', '其他公账支出'],
    ]);
  });

  it('treats notices that share a row as one block', () => {
    const groups = groupItems([
      snap('a', 1, '肉款', 100000),
      snap('b', 2, '品牌管理费', 100000),
      snap('c', 3, '店面租金', 100000),
      snap('n1', 4, '电费', 200000, {
        lines: [
          { category: '电费', fen: 100000, period: '2026-07' },
          { category: '水费', fen: 100000, period: '2026-07' },
        ],
      }),
      snap('n2', 5, '水费', 200000, {
        lines: [
          { category: '水费', fen: 100000, period: '2026-07' },
          { category: '空调能源费', fen: 100000, period: '2026-07' },
        ],
      }),
    ]);
    expect(
      packGroups(groups, metrics, new Set(['n1', 'n2'])).map((sheet) => sheet.groups.map((group) => group.category)),
    ).toEqual([
      ['肉款', '品牌管理费', '店面租金'],
      ['电费', '水费', '空调能源费'],
    ]);
  });

  it('does not glue unrelated rows to a notice just because they sit between its rows', () => {
    // 通知单的一项落在了更早出现的「品牌管理费」那一行里，另一项「店面租金」排在最后：中间的肉款、水费、
    // 其他公账支出、电费和通知单没有关系，不能因为后面的店面租金是通知单的一项，就把紧挨着的电费和它当成一块、
    // 一起换到下一张（那样第一张只剩 4 行）
    const groups = groupItems([
      snap('brand', 1, '品牌管理费', 100000),
      snap('meat', 2, '肉款', 100000),
      snap('water', 3, '水费', 100000),
      snap('other', 4, '其他公账支出', 100000),
      snap('power', 5, '电费', 100000),
      snap('notice', 6, '店面租金', 200000, {
        lines: [
          { category: '品牌管理费', fen: 100000 },
          { category: '店面租金', fen: 100000, period: '2026-09' },
        ],
      }),
    ]);
    expect(labels(packGroups(groups, metrics, new Set(['notice'])))).toEqual([
      ['品牌管理费', '肉款', '水费', '其他公账支出', '电费'],
      ['店面租金（2026年9月）'],
    ]);
  });

  it('only keeps together the rows of the receipts it is told about', () => {
    // 手工拼的几行：电费和店面租金这两相邻的行里有同一个凭证 dup。没点名 dup 就照常一行一行排；点了名才整块换页
    const row = (category: Category, receiptId: string): FormGroup => ({
      category,
      receiptIds: [receiptId],
      amountsFen: [100000],
      totalFen: 100000,
    });
    const groups = [
      row('肉款', 'a'),
      row('品牌管理费', 'b'),
      row('水费', 'c'),
      row('其他公账支出', 'd'),
      row('电费', 'dup'),
      row('店面租金', 'dup'),
    ];
    expect(labels(packGroups(groups, metrics, new Set(['someone-else'])))).toEqual([
      ['肉款', '品牌管理费', '水费', '其他公账支出', '电费'],
      ['店面租金'],
    ]);
    expect(labels(packGroups(groups, metrics, new Set(['dup'])))).toEqual([
      ['肉款', '品牌管理费', '水费', '其他公账支出'],
      ['电费', '店面租金'],
    ]);
  });

  it('keeps the month on every part of a row that has to run over onto the next form', () => {
    // 一行里 20 个金额，每行写 3 个，要 7 行，一张单放不下（5 行）：拆成两部分，两部分都带月份
    const items = Array.from({ length: 20 }, (_, index) => snap(`r${index}`, index + 1, '电费', 1000 + index, { period: '2026-07' }));
    const sheets = packGroups(groupItems(items), metrics);
    expect(sheets).toHaveLength(2);
    expect(sheets.map((sheet) => sheet.groups.map((group) => [group.period, group.part, formGroupLabel(group)]))).toEqual([
      [['2026-07', 1, '电费（2026年7月）']],
      [['2026-07', 2, '电费（2026年7月）（续）']],
    ]);
    expect(sheets.flatMap((sheet) => sheet.groups).reduce((sum, group) => sum + group.totalFen, 0)).toBe(
      items.reduce((sum, item) => sum + item.netFen, 0),
    );
  });
});

describe('moving a row by category and month', () => {
  const sheets = (): FormSheet[] => {
    const rows = groupItems([
      snap('a', 1, '电费', 10000, { period: '2026-07' }),
      snap('b', 2, '电费', 20000, { period: '2026-08' }),
      snap('c', 3, '肉款', 30000),
    ]);
    return packGroups(rows, metrics);
  };

  it('moves only the row of the month asked for', () => {
    const moved = moveGroup(sheets(), '电费', 1, metrics, '2026-08');
    expect(labels(moved)).toEqual([['电费（2026年7月）', '肉款'], ['电费（2026年8月）']]);
    expect(labels(moveGroup(sheets(), '电费', 1, metrics, '2026-07'))).toEqual([['电费（2026年8月）', '肉款'], ['电费（2026年7月）']]);
  });

  it('refuses a month the category does not have on this batch', () => {
    expect(() => moveGroup(sheets(), '电费', 1, metrics, '2026-09')).toThrow('INVALID_LAYOUT');
    expect(() => moveGroup(sheets(), '电费', 1, metrics)).toThrow('INVALID_LAYOUT');
    expect(() => moveGroup(sheets(), '肉款', 1, metrics, '2026-07')).toThrow('INVALID_LAYOUT');
  });

  it('still moves a store row, which has no month', () => {
    const rows = packGroups(groupItems([snap('a', 1, '耗材', 1000), snap('b', 2, '食材', 2000)]), metrics);
    expect(labels(moveGroup(rows, '耗材', 1, metrics))).toEqual([['食材'], ['耗材']]);
  });
});

describe('company batches, totals and eligibility', () => {
  let store: Store;
  const now = new Date('2026-09-04T00:00:00.000Z');

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function create(ids: string[]): Batch {
    return createBatch(store, ids, resolveOptions(getSettings(store), now), now);
  }

  it('spreads a notice over its categories in the pool totals and counts it once', () => {
    const storeReceipt = sampleReceipt({ id: 'store', category: '耗材', paidFen: 1200, recognizedFen: 1200, uploadOrder: 9 });
    const receipts = [...exampleReceipts(), storeReceipt, companyReceipt({ id: 'waiting', status: 'pending', uploadOrder: 10 })];
    expect(poolTotals(receipts, 'company')).toEqual({
      count: 3,
      totalFen: MEAT_FEN + BRAND_FEN + NOTICE_FEN,
      byCategory: {
        肉款: MEAT_FEN,
        品牌管理费: BRAND_FEN,
        店面租金: 2281410,
        物业费: 506980,
        水费: 4886,
        电费: 1146687,
        空调能源费: 16200,
        其他公账支出: 0,
      },
    });
    expect(poolTotals(receipts, 'store')).toMatchObject({ count: 1, totalFen: 1200 });
  });

  it('adds up two notices that both have an electricity bill', () => {
    const second = companyReceipt({
      id: 'notice-2',
      uploadOrder: 4,
      paidFen: 300,
      recognizedFen: 300,
      lines: [
        { category: '电费', fen: 100, period: '2026-08' },
        { category: '水费', fen: 200, period: '2026-08' },
      ],
    });
    const totals = poolTotals([...exampleReceipts(), second], 'company');
    expect(totals.byCategory['电费']).toBe(1146687 + 100);
    expect(totals.byCategory['水费']).toBe(4886 + 200);
    expect(totals.count).toBe(4);
  });

  it('does not let a notice whose items do not add up to its amount into the pool', () => {
    const off = companyReceipt({ id: 'off', paidFen: NOTICE_FEN - 100, recognizedFen: NOTICE_FEN - 100, lines: noticeLines });
    expect(isEligible(off)).toBe(false);
    expect(isEligible({ ...off, paidFen: NOTICE_FEN })).toBe(true);
    expect(poolTotals([off], 'company')).toMatchObject({ count: 0, totalFen: 0 });
    store.put('receipts', off);
    expect(() => create(['off'])).toThrow('NOT_ELIGIBLE');
    expect(store.get('receipts', 'off')?.status).toBe('ready');
  });

  it('makes the payment sheets for two bank receipts and a notice: one form for the receipts, one for the notice', () => {
    for (const receipt of exampleReceipts()) store.put('receipts', receipt);
    const batch = create(['notice', 'meat', 'brand']);
    expect(batch.ledger).toBe('company');
    expect(batch.totalFen).toBe(MEAT_FEN + BRAND_FEN + NOTICE_FEN);
    expect(batch.items.map((item) => item.receiptId)).toEqual(['meat', 'brand', 'notice']);
    expect(labels(batch.sheets)).toEqual([
      ['肉款', '品牌管理费'],
      ['店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）', '电费（2026年7月）', '空调能源费（2026年7月）'],
    ]);
    expect(batch.sheets.map((sheet) => sheet.groups.reduce((sum, group) => sum + group.totalFen, 0))).toEqual([
      MEAT_FEN + BRAND_FEN,
      NOTICE_FEN,
    ]);
    // 凭证快照带着明细、收款方；单分类的回单带收款方
    const [meat, brand, notice] = batch.items;
    expect(notice).toMatchObject({ category: '店面租金', lines: noticeLines, payee: noticePayee, netFen: NOTICE_FEN });
    expect(meat).toMatchObject({ category: '肉款', payee: meatPayee });
    expect(Object.hasOwn(meat!, 'lines')).toBe(false);
    expect(brand!.payee?.name).toBe('武汉市火门品牌管理有限公司');
    for (const id of ['meat', 'brand', 'notice']) {
      expect(store.get('receipts', id)).toMatchObject({ status: 'generated', batchId: batch.id });
    }
    // 快照是拷贝：之后凭证上的明细怎么变，已生成的单据不变
    expect(notice!.lines).not.toBe(store.get('receipts', 'notice')!.lines);
  });

  it('writes the month of a single-category receipt into its snapshot and row', () => {
    store.put('receipts', companyReceipt({ id: 'rent', category: '店面租金', paidFen: 100, recognizedFen: 100, period: '2026-09' }));
    store.put('receipts', companyReceipt({ id: 'rent-none', category: '店面租金', paidFen: 200, recognizedFen: 200, uploadOrder: 2 }));
    const batch = create(['rent', 'rent-none']);
    expect(batch.items[0]).toMatchObject({ period: '2026-09' });
    expect(Object.hasOwn(batch.items[1]!, 'period')).toBe(false);
    expect(labels(batch.sheets)).toEqual([['店面租金（2026年9月）', '店面租金']]);
  });

  it('leaves the snapshot of a store receipt exactly as before', () => {
    store.put('receipts', sampleReceipt({ id: 'store', paidFen: 500, category: '耗材' }));
    const batch = create(['store']);
    expect(Object.keys(batch.items[0]!).sort()).toEqual(
      ['category', 'merchant', 'netFen', 'original', 'paidFen', 'receiptId', 'refundFen', 'refundImages', 'uploadOrder'],
    );
    expect(Object.hasOwn(batch, 'ledger')).toBe(false);
    expect(Object.keys(batch.sheets[0]!.groups[0]!)).toEqual(['category', 'receiptIds', 'amountsFen', 'totalFen']);
  });

  it('moves a row by month on a draft payment sheet, and refuses a month that is not on it', () => {
    store.put('receipts', companyReceipt({ id: 'e7', category: '电费', paidFen: 1000, recognizedFen: 1000, period: '2026-07' }));
    store.put('receipts', companyReceipt({ id: 'e8', category: '电费', paidFen: 2000, recognizedFen: 2000, period: '2026-08', uploadOrder: 2 }));
    store.put('receipts', companyReceipt({ id: 'meat', paidFen: 3000, recognizedFen: 3000, uploadOrder: 3 }));
    const batch = create(['e7', 'e8', 'meat']);
    expect(labels(batch.sheets)).toEqual([['电费（2026年7月）', '电费（2026年8月）', '肉款']]);

    const moved = moveBatchGroup(store, batch.id, '电费', 1, '2026-08');
    expect(labels(moved.sheets)).toEqual([['电费（2026年7月）', '肉款'], ['电费（2026年8月）']]);
    expect(store.get('batches', batch.id)!.sheets).toEqual(moved.sheets);
    expect(() => moveBatchGroup(store, batch.id, '电费', 1)).toThrow('INVALID_LAYOUT');
    expect(() => moveBatchGroup(store, batch.id, '电费', 1, '2026-12')).toThrow('INVALID_LAYOUT');
  });

  it('accepts a hand-arranged layout only when every row keeps its category and month', () => {
    store.put('receipts', companyReceipt({ id: 'e7', category: '电费', paidFen: 1000, recognizedFen: 1000, period: '2026-07' }));
    store.put('receipts', companyReceipt({ id: 'e8', category: '电费', paidFen: 2000, recognizedFen: 2000, period: '2026-08', uploadOrder: 2 }));
    const batch = create(['e7', 'e8']);
    const [july, august] = batch.sheets[0]!.groups as [FormGroup, FormGroup];
    const sheet = (groups: FormGroup[]): FormSheet[] => [
      { id: 'sheet-001', noteId: null, groups: [groups[0]!] },
      { id: 'sheet-002', noteId: null, groups: [groups[1]!] },
    ];

    const swapped = updateBatchLayout(store, batch.id, sheet([august, july]));
    expect(labels(swapped.sheets)).toEqual([['电费（2026年8月）'], ['电费（2026年7月）']]);

    const wrongMonth = sheet([{ ...august, period: '2026-09' }, july]);
    expect(() => updateBatchLayout(store, batch.id, wrongMonth)).toThrow('INVALID_LAYOUT');
    const noMonth = sheet([{ category: august.category, receiptIds: august.receiptIds, amountsFen: august.amountsFen, totalFen: august.totalFen }, july]);
    expect(() => updateBatchLayout(store, batch.id, noMonth)).toThrow('INVALID_LAYOUT');
    const badFormat = sheet([{ ...august, period: '2026-8' }, july]);
    expect(() => updateBatchLayout(store, batch.id, badFormat)).toThrow('INVALID_LAYOUT');
    // 同一行（同分类同月份）排两次、缺一行也不行
    expect(() => updateBatchLayout(store, batch.id, sheet([july, july]))).toThrow('INVALID_LAYOUT');
    expect(() => updateBatchLayout(store, batch.id, [{ id: 'sheet-001', noteId: null, groups: [july] }])).toThrow('INVALID_LAYOUT');
  });
});

describe('the pages behind a payment sheet', () => {
  let store: Store;
  const now = new Date('2026-09-04T00:00:00.000Z');

  beforeEach(() => {
    store = openStore(':memory:');
    for (const receipt of exampleReceipts()) store.put('receipts', receipt);
  });

  afterEach(() => {
    store.close();
  });

  function example(): Batch {
    return createBatch(store, ['meat', 'brand', 'notice'], resolveOptions(getSettings(store), now), now);
  }

  it('attaches the notice once, on the form its rows are on, and says which items it carries', () => {
    const batch = example();
    const [first, second] = batch.sheets as [FormSheet, FormSheet];

    const firstPages = orderedAttachments(batch, first);
    expect(firstPages.map((page) => [page.receiptId, page.kind])).toEqual([['meat', 'original'], ['brand', 'original']]);
    expect(firstPages[0]!.label).toBe('第 1 张报销单 · 肉款 第 1/1 张 · 本张 12909.49 · 肉款合计 12909.49\n原始凭证');

    const secondPages = orderedAttachments(batch, second);
    expect(secondPages).toHaveLength(1);
    expect(secondPages[0]!.receiptId).toBe('notice');
    expect(secondPages[0]!.kind).toBe('original');
    expect(secondPages[0]!.label).toBe(
      [
        '第 2 张报销单 · 本张凭证 39561.63，含 5 项',
        '店面租金（2026年9月） 22814.10 · 物业费（2026年9月） 5069.80 · 水费（2026年7月） 48.86',
        '电费（2026年7月） 11466.87 · 空调能源费（2026年7月） 162.00',
        '原始凭证',
      ].join('\n'),
    );
    // 「单据及附件共 N 页」也只数一次：这张单 1 页单据 + 1 页通知单
    expect(sheetAttachmentCount(batch, second)).toBe(1);
    expect(sheetAttachmentCount(batch, first)).toBe(2);
  });

  it('attaches the notice on each form that carries some of its rows, saying how many are on that form', () => {
    const batch = example();
    const doc = createFormDocument();
    const rows = groupItems(batch.items);
    const sheets = packGroups(rows, formMetrics(doc));
    doc.destroy();
    const split: Batch = { ...batch, sheets };
    expect(labels(split.sheets).map((sheet) => sheet.length)).toEqual([5, 2]);

    const [first, second] = split.sheets as [FormSheet, FormSheet];
    expect(orderedAttachments(split, first).map((page) => page.receiptId)).toEqual(['meat', 'brand', 'notice']);
    expect(orderedAttachments(split, second).map((page) => page.receiptId)).toEqual(['notice']);
    expect(orderedAttachments(split, first)[2]!.label.split('\n')[0]).toBe('第 1 张报销单 · 本张凭证 39561.63，含 5 项（本张单据上 3 项）');
    expect(orderedAttachments(split, second)[0]!.label.split('\n')).toEqual([
      '第 2 张报销单 · 本张凭证 39561.63，含 5 项（本张单据上 2 项）',
      '电费（2026年7月） 11466.87 · 空调能源费（2026年7月） 162.00',
      '原始凭证',
    ]);
  });

  it('lists the rows of a notice three to a line', () => {
    const caption = linesCaption(
      1,
      { lines: noticeLines, netFen: NOTICE_FEN },
      noticeLines.map((line) => ({
        group: { category: line.category, period: line.period, receiptIds: ['notice'], amountsFen: [line.fen], totalFen: line.fen },
        position: 1,
        count: 1,
        fen: line.fen,
      })),
    );
    expect(caption.split('\n')).toHaveLength(3);
  });

  it('prints every row of a notice, with its month and amount, on the payment sheet', async () => {
    const batch = example();
    const sheet = batch.sheets[1]!;
    const doc = createFormDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    drawForm(doc, batch, sheet, null);
    doc.end();
    const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const compact = content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('').replace(/\s+/g, '');
    for (const text of [
      '店面租金（2026年9月）',
      '物业费（2026年9月）',
      '水费（2026年7月）',
      '电费（2026年7月）',
      '空调能源费（2026年7月）',
      '22814.10',
      '5069.80',
      '48.86',
      '11466.87',
      '162.00',
      '3956163',
    ]) {
      expect(compact).toContain(text);
    }
  });
});

describe('editing the items of a company receipt', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  /** 识别出来、各项加起来和合计对不上的通知单 */
  function mismatched(overrides: Partial<Receipt> = {}): Receipt {
    const receipt = companyReceipt({
      id: 'notice',
      status: 'pending',
      pendingReasons: ['lines_mismatch'],
      category: '店面租金',
      paidFen: NOTICE_FEN - 100,
      recognizedFen: NOTICE_FEN - 100,
      lines: noticeLines,
      payee: noticePayee,
      merchant: '武汉丝路合创商业管理有限公司',
      ...overrides,
    });
    store.put('receipts', receipt);
    return receipt;
  }

  function single(overrides: Partial<Receipt> = {}): Receipt {
    const receipt = companyReceipt({
      id: 'single',
      status: 'pending',
      pendingReasons: ['category_uncertain'],
      category: null,
      paidFen: 100000,
      recognizedFen: 100000,
      merchant: '上海新沣食品销售有限公司',
      ...overrides,
    });
    store.put('receipts', receipt);
    return receipt;
  }

  describe('confirming', () => {
    it('confirms a notice once its total matches its items', () => {
      mismatched();
      const confirmed = confirmReceipt(store, 'notice', { paidFen: NOTICE_FEN });
      expect(confirmed).toMatchObject({ status: 'ready', pendingReasons: [], paidFen: NOTICE_FEN, category: '店面租金' });
      expect(confirmed.lines).toEqual(noticeLines);
      expect(isEligible(confirmed)).toBe(true);
    });

    it('refuses to confirm a notice whose items still do not add up to its total', () => {
      mismatched();
      expect(() => confirmReceipt(store, 'notice')).toThrow('LINES_SUM_MISMATCH');
      expect(() => confirmReceipt(store, 'notice', { merchant: '另一个名字' })).toThrow('LINES_SUM_MISMATCH');
      expect(store.get('receipts', 'notice')).toMatchObject({ status: 'pending', merchant: '武汉丝路合创商业管理有限公司' });
    });

    it('takes the total from the items when new items are given without a total', () => {
      mismatched();
      const lines: ReceiptLine[] = [
        { category: '店面租金', fen: 2281410, period: '2026-09' },
        { category: '电费', fen: 1146687, period: '2026-07' },
      ];
      const confirmed = confirmReceipt(store, 'notice', { lines });
      expect(confirmed).toMatchObject({ status: 'ready', paidFen: 3428097, category: '店面租金' });
      expect(confirmed.lines).toEqual(lines);
    });

    it('takes the first item as the category and keeps the months in the items', () => {
      single({ period: '2026-08' });
      const confirmed = confirmReceipt(store, 'single', {
        lines: [
          { category: '电费', fen: 60000, period: '2026-07' },
          { category: '水费', fen: 40000, period: '2026-07' },
        ],
      });
      expect(confirmed).toMatchObject({ category: '电费', paidFen: 100000, status: 'ready' });
      expect(Object.hasOwn(confirmed, 'period')).toBe(false);
    });

    it('accepts items of the same category in different months, and items without a month', () => {
      single();
      const lines: ReceiptLine[] = [
        { category: '电费', fen: 30000, period: '2026-07' },
        { category: '电费', fen: 30000, period: '2026-08' },
        { category: '电费', fen: 40000 },
      ];
      expect(confirmReceipt(store, 'single', { lines }).lines).toEqual(lines);
    });

    it('accepts a total that agrees with the new items and refuses one that does not', () => {
      single();
      const lines: ReceiptLine[] = [
        { category: '电费', fen: 60000 },
        { category: '水费', fen: 40000 },
      ];
      expect(() => confirmReceipt(store, 'single', { lines, paidFen: 100001 })).toThrow('LINES_SUM_MISMATCH');
      expect(store.get('receipts', 'single')?.lines).toBeUndefined();
      expect(confirmReceipt(store, 'single', { lines, paidFen: 100000 })).toMatchObject({ status: 'ready', paidFen: 100000 });
    });

    it('refuses to change only the total of a notice, or only its category to a different one', () => {
      mismatched({ paidFen: NOTICE_FEN, recognizedFen: NOTICE_FEN });
      expect(() => confirmReceipt(store, 'notice', { paidFen: NOTICE_FEN + 1 })).toThrow('LINES_SUM_MISMATCH');
      expect(() => confirmReceipt(store, 'notice', { category: '肉款' })).toThrow('INVALID_CATEGORY');
      expect(confirmReceipt(store, 'notice', { category: '店面租金', paidFen: NOTICE_FEN })).toMatchObject({ status: 'ready' });
    });

    it('turns a notice back into a single-category receipt when its items are removed', () => {
      mismatched();
      const confirmed = confirmReceipt(store, 'notice', { lines: null, category: '店面租金', paidFen: NOTICE_FEN });
      expect(confirmed).toMatchObject({ status: 'ready', category: '店面租金', paidFen: NOTICE_FEN });
      expect(Object.hasOwn(confirmed, 'lines')).toBe(false);
      // 回到单分类后，月份可以单独给
      single();
      const withMonth = confirmReceipt(store, 'single', { category: '肉款', period: '2026-09' });
      expect(withMonth.period).toBe('2026-09');
    });

    it('does not learn a rule from a receipt with several items, and still learns from a single-category one', () => {
      mismatched();
      confirmReceipt(store, 'notice', { paidFen: NOTICE_FEN });
      expect(listRules(store)).toEqual([]);
      single();
      confirmReceipt(store, 'single', { category: '肉款' });
      expect(listRules(store).map((rule) => [rule.id, rule.category])).toEqual([['company:merchant:上海新沣食品销售有限公司', '肉款']]);
    });

    it('forgets the rule note of a receipt when its items change', () => {
      single({
        ruleMatch: { mode: 'suggested', ruleId: 'company:merchant:x', key: 'x', category: '肉款' },
      });
      const confirmed = confirmReceipt(store, 'single', {
        lines: [
          { category: '肉款', fen: 50000 },
          { category: '其他公账支出', fen: 50000 },
        ],
      });
      expect(confirmed.ruleMatch).toBeNull();
    });

    it('forgets a fixed rule that decided the category when the items change, even though the first item keeps the category', () => {
      // 固定规则（applied）把凭证归成了肉款；人把它拆成「肉款 + 其他」，分类还是肉款，但这张凭证已经不是规则说的那一整笔了
      const applied = { mode: 'applied', ruleId: 'company:merchant:x', key: 'x', category: '肉款' } as const;
      single({ category: '肉款', ruleMatch: applied });
      const split = updateReceipt(store, 'single', {
        lines: [
          { category: '肉款', fen: 60000 },
          { category: '其他公账支出', fen: 40000 },
        ],
      });
      expect(split).toMatchObject({ category: '肉款', paidFen: 100000 });
      expect(split.ruleMatch).toBeNull();
    });

    it('keeps the rule note when only the month or the payee is edited', () => {
      const applied = { mode: 'applied', ruleId: 'company:merchant:x', key: 'x', category: '肉款' } as const;
      single({ category: '肉款', ruleMatch: applied });
      const edited = updateReceipt(store, 'single', { period: '2026-09', payee: { name: '上海新沣食品销售有限公司' } });
      expect(edited.ruleMatch).toEqual(applied);
    });
  });

  describe('what is refused', () => {
    const bad = (lines: unknown): ReceiptLine[] => lines as ReceiptLine[];

    it('refuses items that are not at least two valid ones', () => {
      single();
      const refused = (lines: unknown, code: string): void => {
        expect(() => confirmReceipt(store, 'single', { lines: bad(lines) })).toThrow(code);
        expect(store.get('receipts', 'single')).toMatchObject({ status: 'pending' });
      };
      refused([], 'INVALID_LINES');
      refused([{ category: '电费', fen: 100000 }], 'INVALID_LINES');
      refused(Array.from({ length: 21 }, (_, index) => ({ category: '电费', fen: 1, period: `2026-${String((index % 12) + 1).padStart(2, '0')}` })), 'INVALID_LINES');
      refused('电费', 'INVALID_LINES');
      refused([{ category: '电费', fen: 50000 }, null], 'INVALID_LINES');
      refused([{ category: '电费', fen: 50000 }, [1]], 'INVALID_LINES');
      // 分类：不是公账分类（店内的分类也不行）、缺失
      refused([{ category: '电费', fen: 50000 }, { category: '耗材', fen: 50000 }], 'INVALID_LINES');
      refused([{ category: '电费', fen: 50000 }, { fen: 50000 }], 'INVALID_LINES');
      // 金额：要大于 0 的整数分
      refused([{ category: '电费', fen: 100000 }, { category: '水费', fen: 0 }], 'INVALID_LINES');
      refused([{ category: '电费', fen: 100001 }, { category: '水费', fen: -1 }], 'INVALID_LINES');
      refused([{ category: '电费', fen: 50000.5 }, { category: '水费', fen: 49999.5 }], 'INVALID_LINES');
      refused([{ category: '电费', fen: '50000' }, { category: '水费', fen: 50000 }], 'INVALID_LINES');
      refused([{ category: '电费', fen: 1e12 }, { category: '水费', fen: 1 }], 'INVALID_LINES');
      // 月份
      refused([{ category: '电费', fen: 50000, period: '2026-7' }, { category: '水费', fen: 50000 }], 'INVALID_PERIOD');
      refused([{ category: '电费', fen: 50000, period: '2026年7月' }, { category: '水费', fen: 50000 }], 'INVALID_PERIOD');
      refused([{ category: '电费', fen: 50000, period: 202607 }, { category: '水费', fen: 50000 }], 'INVALID_PERIOD');
      // 同分类同月份重复（都没有月份也算）
      refused([{ category: '电费', fen: 50000, period: '2026-07' }, { category: '电费', fen: 50000, period: '2026-07' }], 'DUPLICATE_LINE');
      refused([{ category: '电费', fen: 50000 }, { category: '电费', fen: 50000, period: '' }], 'DUPLICATE_LINE');
    });

    it('takes an empty or null month as no month', () => {
      single();
      const confirmed = confirmReceipt(store, 'single', {
        lines: [
          { category: '电费', fen: 50000, period: '' },
          { category: '水费', fen: 50000, period: null as unknown as string },
        ],
      });
      expect(confirmed.lines).toEqual([
        { category: '电费', fen: 50000 },
        { category: '水费', fen: 50000 },
      ]);
    });

    it('refuses a month beside items, because the months are in the items', () => {
      mismatched({ paidFen: NOTICE_FEN });
      expect(() => confirmReceipt(store, 'notice', { period: '2026-09' })).toThrow('INVALID_PERIOD');
      expect(() =>
        confirmReceipt(store, 'notice', { period: '2026-09', lines: noticeLines }),
      ).toThrow('INVALID_PERIOD');
      // 去掉月份（null）不算给月份
      expect(confirmReceipt(store, 'notice', { period: null })).toMatchObject({ status: 'ready' });
    });

    it('keeps the receipt as it was when a confirmation is refused', () => {
      mismatched();
      const before = store.get('receipts', 'notice');
      expect(() => confirmReceipt(store, 'notice', { lines: [{ category: '电费', fen: 1 }] as ReceiptLine[] })).toThrow('INVALID_LINES');
      expect(store.get('receipts', 'notice')).toEqual(before);
    });

    it('does not take items, a month or a payee on a store receipt', () => {
      store.put('receipts', sampleReceipt({ id: 'store', status: 'pending', category: '耗材' }));
      for (const patch of [
        { lines: [{ category: '电费', fen: 50 }, { category: '水费', fen: 50 }] as ReceiptLine[] },
        { period: '2026-07' },
        { payee: { name: '某公司' } },
        { lines: null },
        { period: null },
        { payee: null },
      ]) {
        expect(() => confirmReceipt(store, 'store', { paidFen: 100, category: '耗材', ...patch })).toThrow('INVALID_RECEIPT_PATCH');
        expect(() => updateReceipt(store, 'store', patch)).toThrow('INVALID_RECEIPT_PATCH');
      }
      expect(store.get('receipts', 'store')).toMatchObject({ status: 'pending' });
    });
  });

  describe('month and payee', () => {
    it('sets and clears the month of a single-category receipt', () => {
      single({ category: '肉款' });
      expect(updateReceipt(store, 'single', { period: '2026-09' }).period).toBe('2026-09');
      expect(updateReceipt(store, 'single', { period: '2026-10' }).period).toBe('2026-10');
      expect(Object.hasOwn(updateReceipt(store, 'single', { period: null }), 'period')).toBe(false);
      single({ category: '肉款', period: '2026-09' });
      expect(Object.hasOwn(updateReceipt(store, 'single', { period: '' }), 'period')).toBe(false);
      for (const period of ['2026-9', '2026年9月', '9月', '2026-13', '2026-00', '1999-09']) {
        expect(() => updateReceipt(store, 'single', { period })).toThrow('INVALID_PERIOD');
      }
    });

    it('sets the payee, tidies it, and clears it with null or when every part is empty', () => {
      single({ category: '肉款' });
      const set = updateReceipt(store, 'single', {
        payee: { name: '  上海新沣食品销售有限公司 ', bank: '中国工商银行  上海分行', account: '1234 5678-9012 3456 789' },
      });
      expect(set.payee).toEqual({ name: '上海新沣食品销售有限公司', bank: '中国工商银行 上海分行', account: '1234567890123456789' });
      // 整个换掉，不是合并：没给的项就是没有
      expect(updateReceipt(store, 'single', { payee: { name: '另一家公司' } }).payee).toEqual({ name: '另一家公司' });
      expect(Object.hasOwn(updateReceipt(store, 'single', { payee: null }), 'payee')).toBe(false);
      updateReceipt(store, 'single', { payee: { name: '另一家公司' } });
      expect(Object.hasOwn(updateReceipt(store, 'single', { payee: { name: ' ', bank: '', account: null as unknown as string } }), 'payee')).toBe(false);
      // 账号可以带字母（有些银行账号带），6 位起
      expect(updateReceipt(store, 'single', { payee: { account: 'AB123456' } }).payee).toEqual({ account: 'AB123456' });
    });

    it('refuses a payee it cannot make sense of instead of dropping it quietly', () => {
      single({ category: '肉款', payee: { name: '原来的收款方' } });
      const refused = (payee: unknown): void => {
        expect(() => updateReceipt(store, 'single', { payee: payee as Payee })).toThrow('INVALID_PAYEE');
        expect(store.get('receipts', 'single')?.payee).toEqual({ name: '原来的收款方' });
      };
      refused({ account: '12345' });
      refused({ account: 'x'.repeat(35) });
      refused({ account: '6222 0200 0000 12*4' });
      refused({ account: 1234567890123456 });
      refused({ name: '长'.repeat(101) });
      refused({ bank: '长'.repeat(101) });
      refused({ name: 123 });
      refused(['名字']);
      refused('某公司');
    });

    it('keeps the items and the amount when only the payee is saved on a notice that does not add up yet', () => {
      mismatched();
      const saved = updateReceipt(store, 'notice', { payee: { ...noticePayee, account: ACCOUNT_B } });
      expect(saved).toMatchObject({ status: 'pending', paidFen: NOTICE_FEN - 100, lines: noticeLines });
      expect(saved.payee?.account).toBe(ACCOUNT_B);
      // 要确认时才查各项之和
      expect(() => confirmReceipt(store, 'notice')).toThrow('LINES_SUM_MISMATCH');
    });

    it('keeps the payee when a receipt is confirmed with other changes', () => {
      single();
      store.put('receipts', { ...store.get('receipts', 'single')!, payee: meatPayee });
      expect(confirmReceipt(store, 'single', { category: '肉款' }).payee).toEqual(meatPayee);
    });
  });
});

describe('editing items over HTTP', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-lines-'));
    store = openStore(':memory:');
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  const app = (): ReturnType<typeof createApp> => createApp({ store, config });

  function pendingNotice(): void {
    store.put(
      'receipts',
      companyReceipt({
        id: 'notice',
        status: 'pending',
        pendingReasons: ['lines_mismatch'],
        category: '店面租金',
        paidFen: NOTICE_FEN - 100,
        recognizedFen: NOTICE_FEN - 100,
        lines: noticeLines,
        payee: noticePayee,
      }),
    );
  }

  it('confirms a notice with corrected items, a month for each and the payee, in one request', async () => {
    pendingNotice();
    const response = await request(app())
      .post('/api/receipts/notice/confirm')
      .send({
        lines: [
          { category: '店面租金', fen: 2281410, period: '2026-09' },
          { category: '物业费', fen: 506980, period: '2026-09' },
          { category: '水费', fen: 4886, period: '2026-07' },
          { category: '电费', fen: 1146687, period: '2026-07' },
          { category: '空调能源费', fen: 16200, period: '2026-07' },
        ],
        payee: { name: '武汉丝路合创商业管理有限公司', bank: '中信银行武汉分行营业部', account: ACCOUNT_B },
      });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', paidFen: NOTICE_FEN, category: '店面租金' });
    expect(response.body.lines).toEqual(noticeLines);
    expect(response.body.payee.account).toBe(ACCOUNT_B);
  });

  it('takes just the items, or just a payee, or just a month, as an edit', async () => {
    pendingNotice();
    const onlyLines = await request(app())
      .post('/api/receipts/notice/confirm')
      .send({ lines: noticeLines.map((line) => ({ ...line, fen: line.fen })) });
    expect(onlyLines.status).toBe(200);
    expect(onlyLines.body).toMatchObject({ status: 'ready', paidFen: NOTICE_FEN });
    store.put('receipts', companyReceipt({ id: 'a', status: 'pending', pendingReasons: [] }));
    const onlyPayee = await request(app()).post('/api/receipts/a/confirm').send({ payee: meatPayee });
    expect([onlyPayee.status, onlyPayee.body.status]).toEqual([200, 'ready']);
    store.put('receipts', companyReceipt({ id: 'b', status: 'pending', pendingReasons: [] }));
    const onlyPeriod = await request(app()).post('/api/receipts/b/confirm').send({ period: '2026-09' });
    expect([onlyPeriod.status, onlyPeriod.body.period]).toEqual([200, '2026-09']);
  });

  it('answers with a clear error for every way an edit can be wrong', async () => {
    pendingNotice();
    const send = (path: string, body: unknown): Promise<request.Response> =>
      request(app()).post(`/api/receipts/notice/${path}`).send(body as object);

    const sum = await send('confirm', {});
    expect(sum.status).toBe(409);
    expect(sum.body.code).toBe('LINES_SUM_MISMATCH');
    expect(sum.body.message).toContain('合计');

    const few = await send('confirm', { lines: [{ category: '电费', fen: 1 }] });
    expect([few.status, few.body.code]).toEqual([400, 'INVALID_LINES']);
    const notArray = await send('confirm', { lines: 'x' });
    expect([notArray.status, notArray.body.code]).toEqual([400, 'INVALID_LINES']);
    const twice = await send('confirm', {
      lines: [{ category: '电费', fen: 1, period: '2026-07' }, { category: '电费', fen: 1, period: '2026-07' }],
    });
    expect([twice.status, twice.body.code]).toEqual([400, 'DUPLICATE_LINE']);
    const period = await send('confirm', { period: 7 });
    expect([period.status, period.body.code]).toEqual([400, 'INVALID_PERIOD']);
    const payeeShape = await send('confirm', { payee: [] });
    expect([payeeShape.status, payeeShape.body.code]).toEqual([400, 'INVALID_PAYEE']);
    const payee = await send('confirm', { payee: { account: '12' } });
    expect([payee.status, payee.body.code]).toEqual([400, 'INVALID_PAYEE']);
    expect(payee.body.message).toContain('银行账号');
    const empty = await send('confirm', { unknown: 1 });
    expect([empty.status, empty.body.code]).toEqual([400, 'INVALID_RECEIPT_PATCH']);
    expect(store.get('receipts', 'notice')).toMatchObject({ status: 'pending' });
  });

  it('saves a payee or a month with PATCH, which only asks for one of the fields', async () => {
    store.put('receipts', companyReceipt({ id: 'meat', status: 'pending', pendingReasons: [] }));
    const payee = await request(app()).patch('/api/receipts/meat').send({ payee: meatPayee });
    expect(payee.status).toBe(200);
    expect(payee.body).toMatchObject({ status: 'pending', payee: meatPayee });
    const month = await request(app()).patch('/api/receipts/meat').send({ period: '2026-09' });
    expect(month.status).toBe(200);
    expect(month.body.period).toBe('2026-09');
    const cleared = await request(app()).patch('/api/receipts/meat').send({ period: null, payee: null });
    expect(cleared.status).toBe(200);
    expect(Object.hasOwn(cleared.body, 'period')).toBe(false);
    expect(Object.hasOwn(cleared.body, 'payee')).toBe(false);
  });

  it('refuses items, a month and a payee on a store receipt over HTTP', async () => {
    store.put('receipts', sampleReceipt({ id: 'store', status: 'pending' }));
    for (const body of [{ period: '2026-07' }, { payee: { name: '某公司' } }, { lines: null }]) {
      const response = await request(app()).patch('/api/receipts/store').send(body);
      expect([response.status, response.body.code]).toEqual([400, 'INVALID_RECEIPT_PATCH']);
    }
  });

  it('reports the pool totals of a notice by item', async () => {
    for (const receipt of exampleReceipts()) store.put('receipts', receipt);
    const totals = await request(app()).get('/api/pool/totals?ledger=company');
    expect(totals.body.count).toBe(3);
    expect(totals.body.byCategory).toMatchObject({ 店面租金: 2281410, 水费: 4886, 电费: 1146687, 空调能源费: 16200, 肉款: MEAT_FEN });
    expect((await request(app()).get('/api/pool/totals')).body).toMatchObject({ count: 0, totalFen: 0 });
  });

  it('makes a payment sheet from a notice over HTTP, and moves a row by its month', async () => {
    store.put('receipts', companyReceipt({ id: 'e7', category: '电费', paidFen: 1000, recognizedFen: 1000, period: '2026-07' }));
    store.put('receipts', companyReceipt({ id: 'e8', category: '电费', paidFen: 2000, recognizedFen: 2000, period: '2026-08', uploadOrder: 2 }));
    store.put('receipts', companyReceipt({ id: 'meat', paidFen: 3000, recognizedFen: 3000, uploadOrder: 3 }));
    const created = await request(app())
      .post('/api/batches')
      .send({ receiptIds: ['e7', 'e8', 'meat'], options: resolveOptions(getSettings(store), new Date()) });
    expect(created.status).toBe(201);
    const batch = created.body as Batch;
    expect(batch.ledger).toBe('company');
    expect(labels(batch.sheets)).toEqual([['电费（2026年7月）', '电费（2026年8月）', '肉款']]);

    const moved = await request(app())
      .post(`/api/batches/${batch.id}/move`)
      .send({ category: '电费', direction: 1, period: '2026-08' });
    expect(moved.status).toBe(200);
    expect(labels(moved.body.sheets)).toEqual([['电费（2026年7月）', '肉款'], ['电费（2026年8月）']]);

    // 同分类要带上月份才知道挪哪一行；月份写法不对是请求错误
    const noMonth = await request(app()).post(`/api/batches/${batch.id}/move`).send({ category: '电费', direction: 1 });
    expect([noMonth.status, noMonth.body.code]).toEqual([400, 'INVALID_LAYOUT']);
    for (const period of ['2026-8', '2026年8月', 8, '']) {
      const bad = await request(app()).post(`/api/batches/${batch.id}/move`).send({ category: '电费', direction: 1, period });
      expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_MOVE']);
    }
    // 月份写 null 和不写一样
    const nullMonth = await request(app()).post(`/api/batches/${batch.id}/move`).send({ category: '肉款', direction: 1, period: null });
    expect(nullMonth.status).toBe(200);
    expect(labels(nullMonth.body.sheets)).toEqual([['电费（2026年7月）'], ['电费（2026年8月）', '肉款']]);
  });
});
