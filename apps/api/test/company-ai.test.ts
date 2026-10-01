import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPANY_CATEGORIES,
  type Analysis,
  type Receipt,
  type Rule,
} from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMPANY_PROMPT, RECEIPT_PROMPT } from '../src/ai/prompt.js';
import { createAnalyzer } from '../src/ai/openai-compatible.js';
import { AiError, type ReceiptAnalyzer } from '../src/ai/types.js';
import { validateAnalysis, validateCompanyAnalysis } from '../src/ai/validate.js';
import { createApp } from '../src/app.js';
import {
  categoryForLabel,
  cleanPayee,
  companyCategoryFromText,
  looksLikeAccountNumber,
  scrubAccountNumbers,
  splitIntoLines,
} from '../src/company.js';
import { loadConfig, type Config } from '../src/config.js';
import { applyAnalysis, reapplyRules } from '../src/decision.js';
import { openStore, type Store } from '../src/db.js';
import { createQueue } from '../src/queue.js';
import { sampleReceipt } from './support.js';

// 账号都是编出来的，不是任何真实账户
const FAKE_ACCOUNT_A = '1234567890123456789';
const FAKE_ACCOUNT_B = '9876543210987654321';

/** 回单：付给肉类供应商的货款 */
const meatReceipt: Analysis = {
  amount: '12909.49',
  category: '肉款',
  merchant: '上海新沣食品销售有限公司',
  date: '2026-09-03',
  confidence: { amount: 0.99, category: 0.92 },
  ambiguous: false,
  keywords: ['新沣', '货款'],
  evidence: '收款人 上海新沣食品销售有限公司 金额 12,909.49 用途 货款',
  payee: { name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: FAKE_ACCOUNT_B },
};

/** 收费通知单：租金和物业费是 9 月，水费、电费、空调能源费是 7 月，合计 39,561.63 */
const notice: Analysis = {
  amount: '39561.63',
  category: null,
  merchant: '武汉丝路合创商业管理有限公司',
  date: null,
  confidence: { amount: 0.97, category: 0.6 },
  ambiguous: false,
  keywords: ['收费通知单', '租金', '物业费'],
  evidence: '费用合计 39,561.63',
  payee: { name: '武汉丝路合创商业管理有限公司', bank: '中信银行武汉分行营业部', account: FAKE_ACCOUNT_A },
  lines: [
    { label: '租金', amount: '22814.10', period: '2026-09' },
    { label: '物业费', amount: '5069.80', period: '2026-09' },
    { label: '水费', amount: '48.86', period: '2026-07' },
    { label: '电费', amount: '11466.87', period: '2026-07' },
    { label: '空调能源费', amount: '162.00', period: '2026-07' },
  ],
};

const noticeLines = [
  { category: '店面租金', fen: 2281410, period: '2026-09' },
  { category: '物业费', fen: 506980, period: '2026-09' },
  { category: '水费', fen: 4886, period: '2026-07' },
  { category: '电费', fen: 1146687, period: '2026-07' },
  { category: '空调能源费', fen: 16200, period: '2026-07' },
];

function manualRule(key: string, category: Rule['category']): Rule {
  return {
    id: `manual:${category}:${key}`,
    kind: 'keyword',
    key,
    originalCategory: null,
    category,
    confirmations: 0,
    strong: false,
    updatedAt: '2026-09-01T00:00:00.000Z',
    source: 'manual',
  };
}

describe('company labels and categories', () => {
  it.each([
    ['租金', '店面租金'],
    ['房租', '店面租金'],
    ['物业费', '物业费'],
    ['物业管理费', '物业费'],
    ['商场管理费', '物业费'],
    ['品牌管理费', '品牌管理费'],
    ['品牌使用费', '品牌管理费'],
    ['加盟费', '品牌管理费'],
    ['水费', '水费'],
    ['热水费', '水费'],
    ['电费', '电费'],
    ['公共区域电费', '电费'],
    ['空调能源费', '空调能源费'],
    ['空调费', '空调能源费'],
    ['空调电费', '空调能源费'],
    ['能耗费', '空调能源费'],
    [' 空调 能源费 ', '空调能源费'],
  ] as const)('maps the fee item %s to %s', (label, category) => {
    expect(categoryForLabel(label)).toBe(category);
  });

  it.each(['水电费', '水电空调', '垃圾清运费', '装修款', '', '合计'])(
    'does not guess a category for %s',
    (label) => {
      expect(categoryForLabel(label)).toBeNull();
    },
  );

  it('keeps the eight company categories and knows short names, but not store categories', () => {
    for (const category of COMPANY_CATEGORIES) expect(companyCategoryFromText(category)).toBe(category);
    expect(companyCategoryFromText('租金')).toBe('店面租金');
    expect(companyCategoryFromText('品牌费')).toBe('品牌管理费');
    expect(companyCategoryFromText(' 电费 ')).toBe('电费');
    for (const other of ['耗材', '食材', '肉类', '', null, undefined, 12, {}]) {
      expect(companyCategoryFromText(other)).toBeNull();
    }
    expect(COMPANY_CATEGORIES).toEqual(['肉款', '品牌管理费', '店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出']);
  });
});

describe('splitting a fee notice into lines', () => {
  it('turns the notice into five lines with their months, water, electricity and air conditioning kept apart', () => {
    const split = splitIntoLines(notice)!;
    expect(split.lines).toEqual(noticeLines);
    expect(split.sumFen).toBe(3956163);
    expect(split.hasFallback).toBe(false);
  });

  it('merges lines of the same category and month, and keeps different months apart', () => {
    const split = splitIntoLines({
      ...notice,
      lines: [
        { label: '电费', amount: '100.00', period: '2026-07' },
        { label: '电费（二号表）', amount: '20.50', period: '2026-07' },
        { label: '电费', amount: '30.00', period: '2026-06' },
        { label: '租金', amount: '1000.00' },
      ],
    })!;
    expect(split.lines).toEqual([
      { category: '电费', fen: 12050, period: '2026-07' },
      { category: '电费', fen: 3000, period: '2026-06' },
      { category: '店面租金', fen: 100000 },
    ]);
    expect(split.sumFen).toBe(12050 + 3000 + 100000);
  });

  it('files an unknown fee item under 其他公账支出 and says so', () => {
    const split = splitIntoLines({
      ...notice,
      lines: [
        { label: '租金', amount: '1000.00', period: '2026-09' },
        { label: '垃圾清运费', amount: '80.00', period: '2026-09' },
      ],
    })!;
    expect(split.lines.map((line) => line.category)).toEqual(['店面租金', '其他公账支出']);
    expect(split.hasFallback).toBe(true);
  });

  it('ignores a single unrecognised line, keeps a single recognised one, skips bad amounts', () => {
    expect(splitIntoLines({ ...notice, lines: [{ label: '货款', amount: '12909.49' }] })).toBeNull();
    expect(splitIntoLines({ ...notice, lines: [{ label: '租金', amount: '1.00', period: '2026-09' }] })?.lines).toEqual([
      { category: '店面租金', fen: 100, period: '2026-09' },
    ]);
    expect(
      splitIntoLines({
        ...notice,
        lines: [
          { label: '租金', amount: '0.00' },
          { label: '物业费', amount: 'abc' },
          { label: '电费', amount: '5.00' },
          { label: '水费', amount: '3.00' },
        ],
      })?.lines,
    ).toEqual([
      { category: '电费', fen: 500 },
      { category: '水费', fen: 300 },
    ]);
    expect(splitIntoLines({ ...notice, lines: [] })).toBeNull();
    const { lines: _lines, ...withoutLines } = notice;
    expect(splitIntoLines(withoutLines)).toBeNull();
  });
});

describe('payee and account numbers', () => {
  it('cleans the payee down to what can be read', () => {
    expect(cleanPayee({ name: '  武汉丝路合创商业管理有限公司 ', bank: '中信银行\n武汉分行营业部', account: '1234 5678-9012 3456 789' })).toEqual({
      name: '武汉丝路合创商业管理有限公司',
      bank: '中信银行 武汉分行营业部',
      account: FAKE_ACCOUNT_A,
    });
    expect(cleanPayee({ account: 6222020000001234 })).toEqual({ account: '6222020000001234' });
    // 看不懂的部分丢掉，别的留下
    expect(cleanPayee({ name: '某公司', bank: '', account: '账号待补' })).toEqual({ name: '某公司' });
    expect(cleanPayee({ name: '长'.repeat(101), account: '12345' })).toBeUndefined();
    for (const nothing of [null, undefined, 'x', [], {}, { name: '', bank: null, account: null }]) {
      expect(cleanPayee(nothing)).toBeUndefined();
    }
  });

  it('wipes account-like numbers from free text but leaves amounts, dates and short numbers alone', () => {
    expect(scrubAccountNumbers(`账号 ${FAKE_ACCOUNT_A} 金额 12,909.49`)).toBe('账号 **** 金额 12,909.49');
    expect(scrubAccountNumbers('卡号 6222 0212 3456 7890')).toBe('卡号 ****');
    expect(scrubAccountNumbers('日期 2026-09-03 20260903 金额 5069.80 合计 39561.63')).toBe(
      '日期 2026-09-03 20260903 金额 5069.80 合计 39561.63',
    );
    expect(looksLikeAccountNumber(FAKE_ACCOUNT_A)).toBe(true);
    expect(looksLikeAccountNumber('6222 0212 3456 7890')).toBe(true);
    expect(looksLikeAccountNumber('租金')).toBe(false);
    // 带 g 标记的正则不能在两次调用之间留下状态
    expect(looksLikeAccountNumber(FAKE_ACCOUNT_A)).toBe(true);
    expect(looksLikeAccountNumber(FAKE_ACCOUNT_A)).toBe(true);
  });
});

describe('validating a company recognition result', () => {
  const clean = {
    amount: '12909.49',
    category: '肉款',
    merchant: '上海新沣食品销售有限公司',
    date: '2026-09-03',
    confidence: { amount: 0.99, category: 0.92 },
    ambiguous: false,
    keywords: ['新沣', '货款'],
    evidence: '收款人 上海新沣食品销售有限公司',
  };

  it('accepts a clean bank-receipt result unchanged', () => {
    expect(validateCompanyAnalysis(clean)).toEqual(clean);
    expect(validateCompanyAnalysis({ ...clean, incomplete: false, orderNo: 'A-1', lines: [], period: null, payee: null })).toEqual({
      ...clean,
      incomplete: false,
      orderNo: 'A-1',
    });
  });

  it.each([
    ['12,909.49', '12909.49'],
    ['¥6,785.00', '6785.00'],
    ['￥1,234.5', '1234.5'],
    ['6785.00元', '6785.00'],
    ['人民币 39,561.63', '39561.63'],
    ['RMB 100', '100'],
    ['12909.490', '12909.49'],
    [12909.49, '12909.49'],
    [6785, '6785.00'],
  ])('normalises the amount %s to %s', (amount, expected) => {
    expect(validateCompanyAnalysis({ ...clean, amount }).amount).toBe(expected);
  });

  it('treats an empty amount as missing, and refuses an amount it cannot read', () => {
    expect(validateCompanyAnalysis({ ...clean, amount: '' }).amount).toBeNull();
    expect(validateCompanyAnalysis({ ...clean, amount: null }).amount).toBeNull();
    for (const amount of ['abc', '12.345', '-5.00', -5, Number.NaN, {}]) {
      expect(() => validateCompanyAnalysis({ ...clean, amount })).toThrow('INVALID_RESPONSE');
    }
  });

  it('knows the company categories and turns anything else into "not recognised" instead of failing', () => {
    expect(validateCompanyAnalysis({ ...clean, category: '租金' }).category).toBe('店面租金');
    expect(validateCompanyAnalysis({ ...clean, category: '空调能源费' }).category).toBe('空调能源费');
    for (const category of ['耗材', '食材', '随便写的', '', null, 7]) {
      expect(validateCompanyAnalysis({ ...clean, category }).category).toBeNull();
    }
  });

  it('reads dates written the way banks print them', () => {
    expect(validateCompanyAnalysis({ ...clean, date: '2026年9月3日' }).date).toBe('2026-09-03');
    expect(validateCompanyAnalysis({ ...clean, date: '2026年09月03日' }).date).toBe('2026-09-03');
    expect(validateCompanyAnalysis({ ...clean, date: '2026/09/03' }).date).toBe('2026-09-03');
    expect(validateCompanyAnalysis({ ...clean, date: '' }).date).toBeNull();
    expect(() => validateCompanyAnalysis({ ...clean, date: '二〇二六年九月' })).toThrow('INVALID_RESPONSE');
    expect(() => validateCompanyAnalysis({ ...clean, date: '2026-02-30' })).toThrow('INVALID_RESPONSE');
  });

  it('reads the month, and drops one it cannot read', () => {
    expect(validateCompanyAnalysis({ ...clean, period: '2026年7月' }).period).toBe('2026-07');
    expect(validateCompanyAnalysis({ ...clean, period: '2026-7' }).period).toBe('2026-07');
    for (const period of ['7月', '下个月', '2026-13', 7, null, '']) {
      expect(Object.hasOwn(validateCompanyAnalysis({ ...clean, period }), 'period')).toBe(false);
    }
  });

  it('keeps the payee, and the account only there', () => {
    const result = validateCompanyAnalysis({
      ...clean,
      payee: { name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: '9876 5432 1098 7654 321' },
      merchant: `上海新沣食品销售有限公司 ${FAKE_ACCOUNT_B}`,
      keywords: ['新沣', FAKE_ACCOUNT_B, '6222 0212 3456 7890', '货款'],
      evidence: `收款人账号 ${FAKE_ACCOUNT_B} 金额 12,909.49`,
    });
    expect(result.payee).toEqual({ name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: FAKE_ACCOUNT_B });
    expect(result.merchant).toBe('上海新沣食品销售有限公司 ****');
    expect(result.keywords).toEqual(['新沣', '货款']);
    expect(result.evidence).toBe('收款人账号 **** 金额 12,909.49');
    expect(JSON.stringify({ ...result, payee: undefined })).not.toContain(FAKE_ACCOUNT_B);
  });

  it('reads the fee lines of a notice leniently', () => {
    const result = validateCompanyAnalysis({
      ...clean,
      amount: '39,561.63',
      category: null,
      lines: [
        { label: '租金', amount: '22,814.10', period: '2026年9月' },
        { label: ' 水费 ', amount: 48.86, period: '2026-07' },
        { label: '电费', amount: '¥11,466.87', period: '看不清' },
        { label: '', amount: '1.00' },
        { label: '合计', amount: '免费' },
        { label: '减免', amount: '-5.00' },
        { label: '零头', amount: '0.00' },
        'not an object',
        null,
      ],
    });
    expect(result.lines).toEqual([
      { label: '租金', amount: '22814.10', period: '2026-09' },
      { label: '水费', amount: '48.86', period: '2026-07' },
      { label: '电费', amount: '11466.87' },
    ]);
    for (const lines of [[], null, 'x', {}, [{ label: '', amount: '1' }]]) {
      expect(Object.hasOwn(validateCompanyAnalysis({ ...clean, lines }), 'lines')).toBe(false);
    }
    const many = Array.from({ length: 30 }, (_, index) => ({ label: `项目${index}`, amount: '1.00' }));
    expect(validateCompanyAnalysis({ ...clean, lines: many }).lines).toHaveLength(20);
  });

  it('is as strict as the store validator about everything else', () => {
    for (const input of [
      { ...clean, extra: true },
      { ...clean, confidence: { amount: 2, category: 0.5 } },
      { ...clean, confidence: { amount: 0.9 } },
      { ...clean, ambiguous: true },
      { ...clean, keywords: 'x' },
      { ...clean, merchant: 5 },
      null,
      'text',
      [],
    ]) {
      expect(() => validateCompanyAnalysis(input)).toThrow('INVALID_RESPONSE');
    }
    expect(validateCompanyAnalysis({ ...clean, ambiguous: true, amount: null }).ambiguous).toBe(true);
  });

  it('leaves the store validator alone: no lines, payee, month or company categories there', () => {
    const storeResult = {
      amount: '36.33', category: '耗材', merchant: '店铺', date: null,
      confidence: { amount: 0.98, category: 0.94 }, ambiguous: false, keywords: [], evidence: '',
    };
    expect(validateAnalysis(storeResult)).toEqual(storeResult);
    for (const extra of [{ lines: [] }, { payee: { name: 'x' } }, { period: '2026-07' }, { category: '肉款' }, { category: '电费' }]) {
      expect(() => validateAnalysis({ ...storeResult, ...extra })).toThrow('INVALID_RESPONSE');
    }
  });
});

describe('the company prompt', () => {
  it('names the company categories and asks for the payee, month and fee lines — not the store ones', () => {
    for (const category of COMPANY_CATEGORIES) expect(COMPANY_PROMPT).toContain(category);
    for (const word of ['payee', 'lines', 'period', '收款人', '账号', '电子回单', '收费通知单', '不要合并']) {
      expect(COMPANY_PROMPT).toContain(word);
    }
    for (const storeOnly of ['百慕达', '员工餐', '租金及管理费', '耗材']) {
      expect(COMPANY_PROMPT).not.toContain(storeOnly);
    }
    // 店内的提示词没动
    expect(RECEIPT_PROMPT).not.toContain('公账');
    expect(RECEIPT_PROMPT).not.toContain('payee');
  });
});

describe('the analyzer picks the prompt and the checks by ledger', () => {
  const configured: Config = {
    dataDir: 'data',
    dbPath: 'data/app.sqlite',
    host: '127.0.0.1',
    port: 3000,
    corsOrigins: [],
    ai: { baseUrl: 'https://vision.example/v1', model: 'vision-model', apiKey: 'key' },
    concurrency: 4,
    accessCodeSha256: null,
    commitSha: null,
  };
  const image = { bytes: Buffer.from([1, 2, 3]), mime: 'image/png' as const };

  function fetchReturning(content: unknown): { fetcher: typeof fetch; prompts: string[] } {
    const prompts: string[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
      prompts.push(body.messages[0]!.content[0]!.text!);
      return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] });
    }) as typeof fetch;
    return { fetcher, prompts };
  }

  const bankResult = {
    amount: '12,909.49', category: '肉款', merchant: '上海新沣食品销售有限公司', date: '2026年9月3日',
    confidence: { amount: 0.99, category: 0.9 }, ambiguous: false, keywords: ['货款'], evidence: '金额 12,909.49',
    payee: { name: '上海新沣食品销售有限公司', account: FAKE_ACCOUNT_B },
  };

  it('uses the company prompt and validation for the company ledger', async () => {
    const { fetcher, prompts } = fetchReturning(bankResult);
    const result = await createAnalyzer(configured, fetcher).analyzeReceipt(image, { ledger: 'company' });
    expect(prompts).toEqual([COMPANY_PROMPT]);
    expect(result).toMatchObject({ amount: '12909.49', category: '肉款', date: '2026-09-03', payee: { account: FAKE_ACCOUNT_B } });
  });

  it('keeps the store prompt and the strict store validation otherwise', async () => {
    for (const options of [undefined, {}, { ledger: 'store' as const }]) {
      const { fetcher, prompts } = fetchReturning(bankResult);
      await expect(createAnalyzer(configured, fetcher).analyzeReceipt(image, options)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      expect(prompts).toEqual([RECEIPT_PROMPT]);
    }
  });
});

describe('recognising company receipts', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  let counter = 0;
  function recognizing(ledger: 'company' | 'store' = 'company'): string {
    counter += 1;
    const id = `r-${counter}`;
    store.put(
      'receipts',
      sampleReceipt({
        id,
        ...(ledger === 'store' ? {} : { ledger }),
        status: 'recognizing',
        category: null,
        paidFen: null,
        recognizedFen: null,
        uploadOrder: counter,
        original: { ...sampleReceipt().original, id: `image-${id}`, sha256: String(counter).padStart(64, '0') },
      }),
    );
    return id;
  }

  it('a bank receipt becomes a ready single-category receipt with its payee', () => {
    const receipt = applyAnalysis(store, recognizing(), meatReceipt);
    expect(receipt).toMatchObject({
      status: 'ready',
      pendingReasons: [],
      category: '肉款',
      paidFen: 1290949,
      merchant: '上海新沣食品销售有限公司',
      payee: { name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: FAKE_ACCOUNT_B },
    });
    expect(Object.hasOwn(receipt, 'lines')).toBe(false);
    expect(Object.hasOwn(receipt, 'period')).toBe(false);
  });

  it('keeps the month written on a bank receipt', () => {
    const receipt = applyAnalysis(store, recognizing(), { ...meatReceipt, category: '店面租金', period: '2026-10' });
    expect(receipt).toMatchObject({ status: 'ready', category: '店面租金', period: '2026-10' });
  });

  it('puts a bank receipt whose purpose is unclear in pending, with the payee kept', () => {
    const receipt = applyAnalysis(store, recognizing(), { ...meatReceipt, confidence: { amount: 0.99, category: 0.4 } });
    expect(receipt).toMatchObject({ status: 'pending', pendingReasons: ['category_uncertain'], category: '肉款' });
    expect(receipt.payee?.account).toBe(FAKE_ACCOUNT_B);
    // 另一张：金额、日期和上一张不同，免得被当成疑似重复
    const noCategory = applyAnalysis(store, recognizing(), { ...meatReceipt, amount: '100.00', category: null });
    expect(noCategory).toMatchObject({ status: 'pending', pendingReasons: ['category_uncertain'], category: null });
  });

  it('turns the fee notice into five ready lines, each with its month, and keeps the raw reading', () => {
    const receipt = applyAnalysis(store, recognizing(), notice);
    expect(receipt).toMatchObject({
      status: 'ready',
      pendingReasons: [],
      paidFen: 3956163,
      recognizedFen: 3956163,
      category: '店面租金',
      lines: noticeLines,
      merchant: '武汉丝路合创商业管理有限公司',
      payee: { name: '武汉丝路合创商业管理有限公司', bank: '中信银行武汉分行营业部', account: FAKE_ACCOUNT_A },
    });
    // 月份在各项里，凭证本身没有
    expect(Object.hasOwn(receipt, 'period')).toBe(false);
    expect(receipt.analysis?.lines).toEqual(notice.lines);
    expect(store.get('receipts', receipt.id)).toEqual(receipt);
  });

  it('puts the notice in pending with lines_mismatch when the items do not add up to the total', () => {
    const receipt = applyAnalysis(store, recognizing(), { ...notice, amount: '39561.00' });
    expect(receipt).toMatchObject({ status: 'pending', pendingReasons: ['lines_mismatch'], paidFen: 3956100, lines: noticeLines });
  });

  it('puts the notice in pending when an item is not a fee it knows', () => {
    const receipt = applyAnalysis(store, recognizing(), {
      ...notice,
      amount: '1080.00',
      lines: [
        { label: '租金', amount: '1000.00', period: '2026-09' },
        { label: '垃圾清运费', amount: '80.00', period: '2026-09' },
      ],
    });
    expect(receipt).toMatchObject({
      status: 'pending',
      pendingReasons: ['category_uncertain'],
      lines: [
        { category: '店面租金', fen: 100000, period: '2026-09' },
        { category: '其他公账支出', fen: 8000, period: '2026-09' },
      ],
    });
  });

  it('shows both reasons when the notice has an unknown item and the sum is off', () => {
    const receipt = applyAnalysis(store, recognizing(), {
      ...notice,
      amount: '2000.00',
      lines: [
        { label: '租金', amount: '1000.00' },
        { label: '垃圾清运费', amount: '80.00' },
      ],
    });
    expect(receipt.pendingReasons).toEqual(['lines_mismatch', 'category_uncertain']);
  });

  it('holds the notice back for the usual amount reasons, and still keeps its lines', () => {
    expect(applyAnalysis(store, recognizing(), { ...notice, confidence: { amount: 0.5, category: 0.9 } })).toMatchObject({
      status: 'pending',
      pendingReasons: ['amount_uncertain'],
      lines: noticeLines,
    });
    expect(applyAnalysis(store, recognizing(), { ...notice, amount: null })).toMatchObject({
      status: 'pending',
      pendingReasons: ['amount_uncertain'],
      paidFen: null,
      lines: noticeLines,
    });
    expect(applyAnalysis(store, recognizing(), { ...notice, amount: null, ambiguous: true })).toMatchObject({
      status: 'pending',
      pendingReasons: ['ambiguous_amount'],
    });
    expect(applyAnalysis(store, recognizing(), { ...notice, amount: null, incomplete: true })).toMatchObject({
      status: 'pending',
      pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
      lines: noticeLines,
    });
    // 截图不完整时合计看不到，各项加起来对不上也不再多报一条
    expect(applyAnalysis(store, recognizing(), { ...notice, amount: '100.00', incomplete: true })).toMatchObject({
      pendingReasons: ['incomplete_screenshot'],
    });
  });

  it('uses the one recognised item of a one-item notice as a plain single-category receipt', () => {
    const receipt = applyAnalysis(store, recognizing(), {
      ...notice,
      amount: '22814.10',
      lines: [{ label: '租金', amount: '22814.10', period: '2026-09' }],
    });
    expect(receipt).toMatchObject({ status: 'ready', category: '店面租金', paidFen: 2281410, period: '2026-09' });
    expect(Object.hasOwn(receipt, 'lines')).toBe(false);
    // 合计和这一项对不上：照样要人看
    const off = applyAnalysis(store, recognizing(), { ...notice, amount: '30000.00', lines: [{ label: '租金', amount: '22814.10', period: '2026-09' }] });
    expect(off.pendingReasons).toEqual(['lines_mismatch']);
  });

  it('ignores a stray single unrecognised line on a bank receipt and goes by the category the model gave', () => {
    const receipt = applyAnalysis(store, recognizing(), { ...meatReceipt, lines: [{ label: '货款', amount: '12909.49' }] });
    expect(receipt).toMatchObject({ status: 'ready', category: '肉款' });
    expect(Object.hasOwn(receipt, 'lines')).toBe(false);
  });

  it('keeps water, electricity and air conditioning as separate lines even in the same month', () => {
    const receipt = applyAnalysis(store, recognizing(), {
      ...notice,
      amount: '11677.73',
      lines: [
        { label: '水费', amount: '48.86', period: '2026-07' },
        { label: '电费', amount: '11466.87', period: '2026-07' },
        { label: '空调能源费', amount: '162.00', period: '2026-07' },
      ],
    });
    expect(receipt.lines?.map((line) => line.category)).toEqual(['水费', '电费', '空调能源费']);
    expect(receipt).toMatchObject({ status: 'ready', category: '水费' });
  });

  it("does not let a company fixed rule turn a notice's lines into one category", () => {
    store.put('rules', manualRule('丝路合创', '店面租金'));
    const receipt = applyAnalysis(store, recognizing(), notice);
    expect(receipt.lines).toEqual(noticeLines);
    expect(receipt.ruleMatch ?? null).toBeNull();
    expect(receipt.status).toBe('ready');
  });

  it('still lets a company fixed rule decide a single-category bank receipt', () => {
    store.put('rules', manualRule('新沣', '肉款'));
    const receipt = applyAnalysis(store, recognizing(), { ...meatReceipt, category: null, confidence: { amount: 0.99, category: 0.1 } });
    expect(receipt).toMatchObject({ status: 'ready', category: '肉款', ruleMatch: { mode: 'applied', key: '新沣' } });
  });

  it('adds nothing company-only to a store receipt, even if the model sends it', () => {
    const receipt = applyAnalysis(store, recognizing('store'), {
      ...meatReceipt,
      category: '肉类',
      period: '2026-07',
      lines: notice.lines!,
    });
    expect(receipt.status).toBe('ready');
    for (const key of ['lines', 'period', 'payee', 'ledger']) expect(Object.hasOwn(receipt, key)).toBe(false);
  });

  it('does not change a multi-line receipt when rules are re-applied, and keeps its lines when settings change', () => {
    const mismatch = applyAnalysis(store, recognizing(), { ...notice, amount: '39561.00' });
    const unsure = applyAnalysis(store, recognizing(), { ...notice, amount: '39000.00', confidence: { amount: 0.9, category: 0.9 } });
    expect(unsure.pendingReasons).toEqual(['amount_uncertain', 'lines_mismatch']);
    store.put('rules', manualRule('丝路合创', '店面租金'));
    expect(reapplyRules(store, 'company')).toBe(0);
    expect(store.get('receipts', mismatch.id)).toEqual(mismatch);
    expect(store.get('receipts', unsure.id)).toEqual(unsure);
  });

  it('keeps a notice with an unknown item in pending when rules are re-applied, whatever the model or a rule says', () => {
    const unknownItem = applyAnalysis(store, recognizing(), {
      ...notice,
      amount: '1080.00',
      category: '店面租金',
      confidence: { amount: 0.97, category: 0.97 },
      lines: [
        { label: '租金', amount: '1000.00', period: '2026-09' },
        { label: '垃圾清运费', amount: '80.00', period: '2026-09' },
      ],
    });
    expect(unknownItem).toMatchObject({
      status: 'pending',
      pendingReasons: ['category_uncertain'],
      category: '店面租金',
    });
    // 模型对分类很有把握、设置页又有一条能命中的固定规则：按明细判断的凭证两样都不看，重新套用后原样不动
    store.put('rules', manualRule('丝路合创', '店面租金'));
    expect(reapplyRules(store, 'company')).toBe(0);
    expect(store.get('receipts', unknownItem.id)).toEqual(unknownItem);
  });

  it('forgets the lines, month and payee of an earlier reading when a receipt is recognised again', () => {
    const id = recognizing();
    store.put('receipts', {
      ...store.get('receipts', id)!,
      lines: [{ category: '电费', fen: 100 }, { category: '水费', fen: 200 }],
      period: '2026-01',
      payee: { name: '旧收款方', account: '123456' },
    });
    const receipt = applyAnalysis(store, id, { ...meatReceipt, payee: undefined });
    for (const key of ['lines', 'period', 'payee']) expect(Object.hasOwn(receipt, key)).toBe(false);
  });
});

describe('recognition through the queue', () => {
  let temp: string;
  let config: Config;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-company-ai-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
    store = openStore(':memory:');
  });

  afterEach(async () => {
    vi.useRealTimers();
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function picture(seed: number): Promise<Buffer> {
    return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: seed, g: 90, b: 160 } } })
      .png()
      .toBuffer();
  }

  it('hands company receipts to the analyzer with the ledger and store receipts without it', async () => {
    const calls: Array<{ args: unknown[] }> = [];
    const analyzer: ReceiptAnalyzer = {
      // 只在需要时才传第二个参数：店内的调用和以前一模一样
      analyzeReceipt: async (...args: unknown[]) => {
        calls.push({ args });
        return args.length > 1 ? meatReceipt : { ...meatReceipt, category: '肉类', payee: undefined };
      },
    };
    const queue = createQueue({
      store,
      config,
      analyzer,
      onAnalyzed: (id, result) => applyAnalysis(store, id, result),
    });
    const app = createApp({ store, config, queue });

    const storeUpload = await request(app).post('/api/receipts/upload').attach('files', await picture(10), 'a.png');
    const companyUpload = await request(app).post('/api/receipts/upload?ledger=company').attach('files', await picture(200), 'b.png');
    queue.start();
    await queue.drain();
    await queue.stop();

    expect(calls).toHaveLength(2);
    const storeCall = calls.find((call) => call.args.length === 1)!;
    const companyCall = calls.find((call) => call.args.length === 2)!;
    expect(storeCall.args).toHaveLength(1);
    expect(companyCall.args[1]).toEqual({ ledger: 'company' });
    expect(store.get('receipts', storeUpload.body.accepted[0].id)).toMatchObject({ status: 'ready', category: '肉类' });
    expect(store.get('receipts', companyUpload.body.accepted[0].id)).toMatchObject({
      status: 'ready',
      category: '肉款',
      ledger: 'company',
      payee: { account: FAKE_ACCOUNT_B },
    });
  });

  it('recognises a bank receipt and a fee notice end to end into the company pool', async () => {
    const meatPicture = await picture(30);
    const noticePicture = await picture(220);
    const results = new Map<string, Analysis>([
      [meatPicture.toString('base64'), meatReceipt],
      [noticePicture.toString('base64'), notice],
    ]);
    const analyzer: ReceiptAnalyzer = {
      analyzeReceipt: async (image, options) => {
        expect(options).toEqual({ ledger: 'company' });
        const found = results.get(image.bytes.toString('base64'));
        if (found === undefined) throw new AiError('INVALID_RESPONSE', false);
        return found;
      },
    };
    const queue = createQueue({
      store,
      config,
      analyzer,
      onAnalyzed: (id, result) => applyAnalysis(store, id, result),
    });
    const app = createApp({ store, config, queue });
    const upload = await request(app)
      .post('/api/receipts/upload?ledger=company')
      .attach('files', meatPicture, 'meat.png')
      .attach('files', noticePicture, 'notice.png');
    expect(upload.body.accepted).toHaveLength(2);
    queue.start();
    await queue.drain();
    await queue.stop();

    const pool = (await request(app).get('/api/receipts?view=pool&ledger=company')).body as Receipt[];
    expect(pool).toHaveLength(2);
    expect(pool.find((receipt) => receipt.category === '肉款')).toMatchObject({ paidFen: 1290949, status: 'ready' });
    expect(pool.find((receipt) => receipt.lines !== undefined)).toMatchObject({ paidFen: 3956163, lines: noticeLines });
    expect((await request(app).get('/api/receipts?view=pool')).body).toEqual([]);
    expect((await request(app).get('/api/receipts?view=pending&ledger=company')).body).toEqual([]);
  });
});
