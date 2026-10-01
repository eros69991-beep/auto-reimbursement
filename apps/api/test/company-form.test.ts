import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Batch,
  type FormGroup,
  type ImageRef,
  type Payee,
  type Receipt,
  type ReceiptLine,
  type Settings,
} from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBatch } from '../src/batches.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { linesCaption, orderedAttachments } from '../src/render/attachments.js';
import {
  COMPANY_NOTE_STYLES,
  STORE_NOTE_STYLE,
  createFormDocument,
  drawForm,
  formWords,
  layoutNote,
  snapToLine,
} from '../src/render/form.js';
import { renderBatchPdf } from '../src/render/pdf.js';
import { getSettings, resolveOptions, saveSettings } from '../src/settings.js';
import { safePath } from '../src/storage.js';
import { sampleReceipt } from './support.js';

// 假的银行账号：真通知单上的号码不出现在代码、测试和文档里。
const ACCOUNT_A = '1234567890123456789';
const ACCOUNT_B = '9876543210987654321';
const ACCOUNT_C = '6217000012345678901';

const meatPayee: Payee = { name: '上海新沣食品销售有限公司', bank: '中国工商银行上海分行', account: ACCOUNT_A };
const brandPayee: Payee = { name: '武汉市火门品牌管理有限公司', bank: '中国工商银行武汉分行江汉支行', account: ACCOUNT_B };
const noticePayee: Payee = { name: '武汉丝路合创商业管理有限公司', bank: '中信银行武汉分行营业部', account: ACCOUNT_C };

const noticeLines: ReceiptLine[] = [
  { category: '店面租金', fen: 2281410, period: '2026-09' },
  { category: '物业费', fen: 506980, period: '2026-09' },
  { category: '水费', fen: 4886, period: '2026-07' },
  { category: '电费', fen: 1146687, period: '2026-07' },
  { category: '空调能源费', fen: 16200, period: '2026-07' },
];

const COMPANY = '武汉市火门里餐饮管理有限公司';
const now = new Date('2026-09-30T04:00:00.000Z');

// 版式尺寸（毫米）；PDF 里的坐标是 pt
const geometry = JSON.parse(readFileSync(join(__dirname, '../assets/form-geometry.json'), 'utf8')) as {
  page: { height: number };
  table: { y: number; notesSplitY: number };
};
const mm = (value: number): number => (value * 72) / 25.4;

// ---- 读 PDF：每页的文字和字号 ----

interface Item {
  str: string;
  /** 字号（pt） */
  size: number;
  /** 基线的纵坐标（pt，PDF 坐标，从页面底边往上数） */
  y: number;
}

async function readPages(bytes: Buffer): Promise<Item[][]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  return Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.flatMap((item) => (
      'str' in item && item.str.trim() !== '' ? [{ str: item.str, size: item.height, y: item.transform[5] as number }] : []
    ));
  }));
}

/** 只画报销单页（不带凭证附件页），每页一个数组。 */
async function drawPages(batch: Batch): Promise<Item[][]> {
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  for (const sheet of batch.sheets) drawForm(doc, batch, sheet, null);
  doc.end();
  return readPages(await done);
}

const compact = (items: Item[]): string => items.map((item) => item.str).join('').replace(/\s+/g, '');
const count = (text: string, part: string): number => text.split(part).length - 1;

// ---- 造数据 ----

function companyReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return sampleReceipt({ ledger: 'company', category: '肉款', ...overrides });
}

function build(receipts: Receipt[], options: { note?: string; department?: string } = {}): Batch {
  const store = openStore(':memory:');
  try {
    for (const receipt of receipts) store.put('receipts', receipt);
    const settings: Settings = {
      ...getSettings(store),
      companyDepartment: options.department ?? COMPANY,
      signerName: '张三',
    };
    const batch = createBatch(store, receipts.map((receipt) => receipt.id), resolveOptions(settings, now, 'company'), now);
    if (options.note === undefined) return batch;
    return {
      ...batch,
      notes: [{ id: 'note', name: '备注', content: options.note }],
      sheets: batch.sheets.map((sheet) => ({ ...sheet, noteId: 'note' })),
    };
  } finally {
    store.close();
  }
}

/** 两张回单加一张通知单：第 1 张单 [肉款、品牌管理费]，第 2 张单 [通知单的 5 项]。 */
function exampleReceipts(): Receipt[] {
  return [
    companyReceipt({ id: 'meat', uploadOrder: 1, category: '肉款', paidFen: 1290949, recognizedFen: 1290949, payee: meatPayee }),
    companyReceipt({ id: 'brand', uploadOrder: 2, category: '品牌管理费', paidFen: 678500, recognizedFen: 678500, payee: brandPayee }),
    companyReceipt({
      id: 'notice',
      uploadOrder: 3,
      category: '店面租金',
      paidFen: 3956163,
      recognizedFen: 3956163,
      lines: noticeLines,
      payee: noticePayee,
    }),
  ];
}

function storeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return sampleReceipt({ category: '耗材', paidFen: 3633, ...overrides });
}

function buildStore(receipts: Receipt[], note?: string): Batch {
  const store = openStore(':memory:');
  try {
    for (const receipt of receipts) store.put('receipts', receipt);
    const batch = createBatch(
      store,
      receipts.map((receipt) => receipt.id),
      { department: '运营部', date: '2026-09-30', signerMode: 'text', signerName: '李四', signature: null },
      now,
    );
    if (note === undefined) return batch;
    return {
      ...batch,
      notes: [{ id: 'note', name: '备注', content: note }],
      sheets: batch.sheets.map((sheet) => ({ ...sheet, noteId: 'note' })),
    };
  } finally {
    store.close();
  }
}

describe('the words printed on the form', () => {
  it('prints the payment words on a company form, none of the reimbursement words', async () => {
    const [page] = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100, payee: meatPayee })]));
    const text = compact(page!);
    for (const word of ['公账付款单', `付款单位：${COMPANY}`, '付款项目', '经办人张三']) {
      expect(text).toContain(word);
    }
    for (const word of ['费用报销单', '报销部门', '报销项目', '报销人']) {
      expect(text).not.toContain(word);
    }
  });

  it('keeps the reimbursement words on a store form', async () => {
    const [page] = await drawPages(buildStore([storeReceipt({ id: 'a' })]));
    const text = compact(page!);
    for (const word of ['费用报销单', '报销部门：运营部', '报销项目', '报销人李四']) {
      expect(text).toContain(word);
    }
    for (const word of ['公账', '付款单位', '付款项目', '经办人']) {
      expect(text).not.toContain(word);
    }
  });

  it('uses the same number of characters for every printed word so the layout does not move', () => {
    const store = formWords({});
    const company = formWords({ ledger: 'company' });
    expect(store.title).toBe('费用报销单');
    expect(company.title).toBe('公账付款单');
    for (const key of ['title', 'department', 'project', 'signer'] as const) {
      expect([...company[key]]).toHaveLength([...store[key]].length);
    }
  });

  it('writes a notice caption for the company ledger unless told otherwise', () => {
    const rows = [{
      group: { category: '电费' as const, period: '2026-07', receiptIds: ['n'], amountsFen: [100], totalFen: 100 },
      position: 1,
      count: 1,
      fen: 100,
    }];
    const item = { lines: [{ category: '电费' as const, fen: 100, period: '2026-07' }], netFen: 100 };
    expect(linesCaption(1, item, rows).split('\n')[0]).toBe('第 1 张付款单 · 本张凭证 1.00，含 1 项');
    expect(linesCaption(1, item, rows, 'company').split('\n')[0]).toBe('第 1 张付款单 · 本张凭证 1.00，含 1 项');
    expect(linesCaption(1, item, rows, 'store').split('\n')[0]).toBe('第 1 张报销单 · 本张凭证 1.00，含 1 项');
  });

  it('says 付款单 in the headers of the attachment pages of a company form, 报销单 in a store form', () => {
    const company = build(exampleReceipts());
    expect(company.ledger).toBe('company');
    const labels = company.sheets.flatMap((sheet) => orderedAttachments(company, sheet).map((page) => page.label.split('\n')[0]!));
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label).toMatch(/^第 [12] 张付款单 · /);
    }
    const store = buildStore([storeReceipt({ id: 'a' })]);
    expect(orderedAttachments(store, store.sheets[0]!)[0]!.label.split('\n')[0]).toMatch(/^第 1 张报销单 · /);
  });
});

describe('the payment unit setting', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('is optional, and the form options take it from there for the company ledger only', () => {
    const base = getSettings(store);
    expect(Object.hasOwn(base, 'companyDepartment')).toBe(false);
    const saved = saveSettings(store, { ...base, department: '火门·美式烤肉', companyDepartment: COMPANY });
    expect(getSettings(store).companyDepartment).toBe(COMPANY);
    expect(resolveOptions(saved, now, 'company').department).toBe(COMPANY);
    expect(resolveOptions(saved, now, 'store').department).toBe('火门·美式烤肉');
    expect(resolveOptions(saved, now).department).toBe('火门·美式烤肉');
    // 没设置：付款单位留空，打印后手写，不拿店内的部门名顶替
    const storeOnly = saveSettings(store, { ...base, department: '火门·美式烤肉' });
    expect(Object.hasOwn(storeOnly, 'companyDepartment')).toBe(false);
    expect(resolveOptions(storeOnly, now, 'company').department).toBe('');
    expect(resolveOptions(storeOnly, now, 'store').department).toBe('火门·美式烤肉');
  });

  it('accepts settings saved by an older page that does not send it', () => {
    const saved = saveSettings(store, { ...getSettings(store), department: '运营部' });
    expect(Object.hasOwn(saved, 'companyDepartment')).toBe(false);
    expect(getSettings(store).department).toBe('运营部');
  });

  it('accepts at most 100 characters and only a string', () => {
    const base = getSettings(store);
    expect(saveSettings(store, { ...base, companyDepartment: '公'.repeat(100) }).companyDepartment).toHaveLength(100);
    expect(() => saveSettings(store, { ...base, companyDepartment: '公'.repeat(101) })).toThrow('INVALID_SETTINGS');
    expect(() => saveSettings(store, { ...base, companyDepartment: 5 as unknown as string })).toThrow('INVALID_SETTINGS');
    expect(() => saveSettings(store, { ...base, companyDepartment: null as unknown as string })).toThrow('INVALID_SETTINGS');
    // 别的多余的键仍然不收
    expect(() => saveSettings(store, { ...base, companyDepartment: COMPANY, extra: 1 } as unknown as Settings)).toThrow('INVALID_SETTINGS');
  });
});

describe('the payees in the note box of a company form', () => {
  it('prints the payee of every receipt on the form, in the order they come, each as name, bank and account', async () => {
    const pages = await drawPages(build(exampleReceipts()));
    expect(pages).toHaveLength(2);
    const first = compact(pages[0]!);
    const second = compact(pages[1]!);
    expect(first).toContain(
      `收款户名：${meatPayee.name}开户银行：${meatPayee.bank}银行账号：${ACCOUNT_A}` +
        `收款户名：${brandPayee.name}开户银行：${brandPayee.bank}银行账号：${ACCOUNT_B}`,
    );
    expect(second).toContain(`收款户名：${noticePayee.name}开户银行：${noticePayee.bank}银行账号：${ACCOUNT_C}`);
    // 每张单只写自己这张单上的收款方
    expect(first).not.toContain(ACCOUNT_C);
    expect(second).not.toContain(ACCOUNT_A);
    expect(second).not.toContain(ACCOUNT_B);
  });

  it('writes a payee only once however many receipts and rows it has', async () => {
    const batch = build([
      companyReceipt({ id: 'a', uploadOrder: 1, category: '肉款', paidFen: 100000, payee: meatPayee }),
      companyReceipt({ id: 'b', uploadOrder: 2, category: '肉款', paidFen: 200000, payee: { ...meatPayee } }),
      companyReceipt({ id: 'c', uploadOrder: 3, category: '品牌管理费', paidFen: 300000, payee: { ...meatPayee } }),
    ]);
    const [page] = await drawPages(batch);
    expect(count(compact(page!), `收款户名：${meatPayee.name}`)).toBe(1);
    expect(count(compact(page!), ACCOUNT_A)).toBe(1);
  });

  it('writes two payees of the same name when their accounts differ', async () => {
    const batch = build([
      companyReceipt({ id: 'a', uploadOrder: 1, category: '肉款', paidFen: 100000, payee: meatPayee }),
      companyReceipt({ id: 'b', uploadOrder: 2, category: '品牌管理费', paidFen: 200000, payee: { ...meatPayee, account: ACCOUNT_B } }),
    ]);
    const [page] = await drawPages(batch);
    const text = compact(page!);
    expect(count(text, `收款户名：${meatPayee.name}`)).toBe(2);
    expect(text).toContain(`银行账号：${ACCOUNT_A}`);
    expect(text).toContain(`银行账号：${ACCOUNT_B}`);
  });

  it('writes two payees that differ only in the bank, and two that differ only in the name', async () => {
    const second = async (changed: Payee): Promise<string> => compact((await drawPages(build([
      companyReceipt({ id: 'a', uploadOrder: 1, category: '肉款', paidFen: 100000, payee: meatPayee }),
      companyReceipt({ id: 'b', uploadOrder: 2, category: '品牌管理费', paidFen: 200000, payee: { ...meatPayee, ...changed } }),
    ])))[0]!);
    const otherBank = await second({ bank: '中国建设银行武汉分行' });
    expect(count(otherBank, '收款户名：')).toBe(2);
    expect(count(otherBank, '开户银行：')).toBe(2);
    const otherName = await second({ name: '上海新沣食品销售有限公司二分公司' });
    expect(count(otherName, '收款户名：')).toBe(2);
    expect(count(otherName, '银行账号：')).toBe(2);
  });

  it('leaves out the lines a payee does not have, and writes nothing for receipts without a payee', async () => {
    const batch = build([
      companyReceipt({ id: 'a', uploadOrder: 1, category: '肉款', paidFen: 100000, payee: { account: ACCOUNT_A } }),
      companyReceipt({ id: 'b', uploadOrder: 2, category: '品牌管理费', paidFen: 200000, payee: { name: '只有户名的公司' } }),
      companyReceipt({ id: 'c', uploadOrder: 3, category: '店面租金', paidFen: 300000 }),
    ]);
    const [page] = await drawPages(batch);
    const text = compact(page!);
    expect(text).toContain(`银行账号：${ACCOUNT_A}收款户名：只有户名的公司`);
    expect(count(text, '收款户名')).toBe(1);
    expect(count(text, '银行账号')).toBe(1);
    expect(text).not.toContain('开户银行');
  });

  it('writes nothing in the note box when no receipt has a payee and no note is chosen', async () => {
    const [page] = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100000 })]));
    const text = compact(page!);
    for (const word of ['收款户名', '开户银行', '银行账号', '接续页']) expect(text).not.toContain(word);
  });

  it('writes the chosen note after the payees', async () => {
    const note = '请于本月5日前付款';
    const [page] = await drawPages(build(exampleReceipts().slice(0, 2), { note }));
    const text = compact(page!);
    expect(text.indexOf(note)).toBeGreaterThan(text.indexOf(`银行账号：${ACCOUNT_B}`));
    expect(text.indexOf(`银行账号：${ACCOUNT_B}`)).toBeGreaterThan(text.indexOf(`银行账号：${ACCOUNT_A}`));
  });

  it('leaves a blank line between two payees when there is room', async () => {
    const [page] = await drawPages(build(exampleReceipts().slice(0, 2)));
    const lines = page!.filter((item) => /^(收款户名|开户银行|银行账号)：/.test(item.str));
    expect(lines.map((item) => item.str.slice(0, 4))).toEqual(['收款户名', '开户银行', '银行账号', '收款户名', '开户银行', '银行账号']);
    const pitch = lines[0]!.y - lines[1]!.y;
    expect(pitch).toBeGreaterThan(0);
    // 同一家的几行是一个行距；两家之间多空一行
    for (const index of [1, 3, 4]) expect(lines[index]!.y - lines[index + 1]!.y).toBeCloseTo(pitch, 1);
    expect(lines[2]!.y - lines[3]!.y).toBeCloseTo(pitch * 2, 1);
  });

  it('leaves a blank line between the payees and the chosen note', async () => {
    const [page] = await drawPages(build(exampleReceipts().slice(0, 1), { note: '请于本月5日前付款' }));
    const lines = page!.filter((item) => /^(收款户名|开户银行|银行账号)：|^请于本月/.test(item.str));
    expect(lines.map((item) => item.str.slice(0, 4))).toEqual(['收款户名', '开户银行', '银行账号', '请于本月']);
    const pitch = lines[0]!.y - lines[1]!.y;
    expect(lines[1]!.y - lines[2]!.y).toBeCloseTo(pitch, 1);
    expect(lines[2]!.y - lines[3]!.y).toBeCloseTo(pitch * 2, 1);
  });

  it('closes the gap between the payees but keeps the one before the note when the box is tight', async () => {
    const batch = build([
      companyReceipt({ id: 'a', uploadOrder: 1, category: '肉款', paidFen: 1290949, payee: meatPayee }),
      companyReceipt({ id: 'b', uploadOrder: 2, category: '品牌管理费', paidFen: 678500, payee: brandPayee }),
    ], { note: '请于本月5日前付款\n用途：9 月肉款及品牌费' });
    const [page] = await drawPages(batch);
    const lines = page!.filter((item) => /^(收款户名|开户银行|银行账号)：|^请于本月|^用途/.test(item.str));
    expect(lines).toHaveLength(8);
    const pitch = lines[0]!.y - lines[1]!.y;
    for (const index of [1, 2, 3, 4, 6]) {
      expect(lines[index]!.y - lines[index + 1]!.y).toBeCloseTo(pitch, 1);
    }
    expect(lines[5]!.y - lines[6]!.y).toBeCloseTo(pitch * 2, 1);
    expect(lines[0]!.size).toBeLessThan(10);
  });

  it('writes the chosen note alone when there are no payees', async () => {
    const note = '请于本月5日前付款';
    const [page] = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100000 })], { note }));
    const items = page!.filter((item) => item.str.includes(note));
    expect(items).toHaveLength(1);
    // 只有备注、字数少：一直是 10pt，和店内一样
    expect(items[0]!.size).toBe(10);
  });

  it('prints a payee of a store receipt nowhere: only the company ledger has this note', async () => {
    const batch = buildStore([storeReceipt({ id: 'a' })]);
    const withPayee: Batch = {
      ...batch,
      items: batch.items.map((item) => ({ ...item, payee: meatPayee })),
    };
    const [page] = await drawPages(withPayee);
    const text = compact(page!);
    expect(text).not.toContain('收款户名');
    expect(text).not.toContain(ACCOUNT_A);
  });
});

describe('the size of the note on a company form', () => {
  const payeeItems = (page: Item[]): Item[] => page.filter((item) => /^(收款户名|开户银行|银行账号)：/.test(item.str));

  it('stays at 10pt when one payee fits, and shrinks when two have to share the box', async () => {
    const one = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100000, payee: noticePayee })]));
    expect(new Set(payeeItems(one[0]!).map((item) => item.size))).toEqual(new Set([10]));

    const two = await drawPages(build(exampleReceipts().slice(0, 2)));
    const sizes = payeeItems(two[0]!).map((item) => item.size);
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]!).toBeLessThan(10);
    expect(sizes[0]!).toBeGreaterThanOrEqual(6.5);
  });

  it('never goes below 6.5pt', async () => {
    const many = Array.from({ length: 5 }, (_, index) => companyReceipt({
      id: `p${index}`,
      uploadOrder: index + 1,
      category: (['肉款', '品牌管理费', '店面租金', '物业费', '其他公账支出'] as const)[index]!,
      paidFen: 100000 + index,
      payee: { name: `第${index + 1}家供应商有限公司`, bank: '中国工商银行股份有限公司武汉江汉路支行', account: `62170000123456789${index}${index}` },
    }));
    const [page] = await drawPages(build(many));
    const sizes = payeeItems(page!).map((item) => item.size);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBe(6.5);
  });

  // 备注栏每个字号放几行（行高 + 行距）：10pt 5 行，9pt 6 行，8pt 7 行，7pt 8 行，6.5pt 9 行。
  // 下面每一种内容恰好落在一个字号上，逐个量字号和行距。
  const lineHeight = (size: number): number => {
    const doc = createFormDocument();
    try {
      doc.fontSize(size);
      return doc.currentLineHeight(true);
    } finally {
      doc.destroy();
    }
  };
  const full = (n: number): Payee => ({ name: `第${n}家供应商有限公司`, bank: '中国工商银行武汉分行', account: `62170000123456789${n}${n}` });
  const noBank = (n: number): Payee => ({ name: `第${n}家供应商有限公司`, account: `62170000123456789${n}${n}` });
  const SHORT_NOTE = '请于本月5日前付款';

  it.each([
    { size: 10, gap: 4, payees: [full(1)], note: undefined, lines: '3 行' },
    { size: 9, gap: 3.5, payees: [full(1)], note: `${SHORT_NOTE}\n用途：9 月肉款`, lines: '3 行 + 空行 + 2 行 = 6 行' },
    { size: 8, gap: 3, payees: [full(1), noBank(2)], note: SHORT_NOTE, lines: '3 + 2 行（不空行）+ 空行 + 1 行 = 7 行' },
    { size: 7, gap: 2.5, payees: [full(1), full(2)], note: SHORT_NOTE, lines: '3 + 3 行（不空行）+ 空行 + 1 行 = 8 行' },
    { size: 6.5, gap: 2, payees: [full(1), full(2), full(3)], note: undefined, lines: '3 + 3 + 3 行（不空行）= 9 行' },
  ])('writes $lines at $size pt with a $gap pt gap between the lines', async ({ size, gap, payees, note }) => {
    const categories = ['肉款', '品牌管理费', '店面租金'] as const;
    const receipts = payees.map((payee, index) => companyReceipt({
      id: `p${index}`,
      uploadOrder: index + 1,
      category: categories[index]!,
      paidFen: 100000 + index,
      payee,
    }));
    const pages = await drawPages(build(receipts, note === undefined ? {} : { note }));
    expect(pages).toHaveLength(1);
    const lines = payeeItems(pages[0]!);
    expect(lines).toHaveLength(payees.reduce((sum, payee) => sum + Object.keys(payee).length, 0));
    expect(new Set(lines.map((item) => item.size))).toEqual(new Set([size]));
    // 收款方各行之间一个行距（这几种内容放不下空行，只有 10pt 的那一种只有一家）
    for (let index = 0; index + 1 < lines.length; index += 1) {
      expect(lines[index]!.y - lines[index + 1]!.y).toBeCloseTo(lineHeight(size) + gap, 1);
    }
    // 没有备注时备注栏里没有别的字，有备注时备注字号相同
    if (note !== undefined) {
      const noteLine = pages[0]!.find((item) => item.str === SHORT_NOTE || item.str.startsWith('请于本月'))!;
      expect(noteLine.size).toBe(size);
    }
  });
});

describe('a note that does not fit the box', () => {
  const five = (): Receipt[] => Array.from({ length: 5 }, (_, index) => companyReceipt({
    id: `p${index}`,
    uploadOrder: index + 1,
    category: (['肉款', '品牌管理费', '店面租金', '物业费', '其他公账支出'] as const)[index]!,
    paidFen: 100000 + index,
    payee: { name: `第${index + 1}家供应商有限公司`, bank: '中国工商银行股份有限公司武汉江汉路支行', account: `62170000123456789${index}${index}` },
  }));

  it('goes on a continuation page one whole payee at a time', async () => {
    const pages = await drawPages(build(five()));
    expect(pages).toHaveLength(2);
    const [first, rest] = [compact(pages[0]!), compact(pages[1]!)];
    expect(first).toContain('（接续页）');
    expect(rest).toContain('备注续页');
    expect(rest).not.toContain('（接续页）');
    // 每一页上都是整家收款方：户名、开户银行、银行账号一样多
    for (const text of [first, rest]) {
      const names = count(text, '收款户名：');
      expect(names).toBeGreaterThan(0);
      expect(count(text, '开户银行：')).toBe(names);
      expect(count(text, '银行账号：')).toBe(names);
    }
    expect(count(first, '收款户名：') + count(rest, '收款户名：')).toBe(5);
    // 第一页尽量多放：放得下几家就放几家，不是只放一家就换页
    expect(count(first, '收款户名：')).toBeGreaterThanOrEqual(2);
    // 按顺序，一家不少、不重复，账号一位不差
    const accounts = Array.from({ length: 5 }, (_, index) => `62170000123456789${index}${index}`);
    const all = first + rest;
    for (const account of accounts) expect(count(all, account)).toBe(1);
    expect(accounts.map((account) => all.indexOf(account))).toEqual(
      [...accounts.map((account) => all.indexOf(account))].sort((a, b) => a - b),
    );
    expect(first.indexOf(accounts[0]!)).toBeGreaterThan(-1);
    expect(rest.indexOf(accounts[4]!)).toBeGreaterThan(-1);
    // 单据及附件共：1 页单据 + 1 页备注续页 + 5 张凭证
    expect(first).toContain('单据及附件共7页');
    // 第一页的备注栏缩到 6.5pt，续页一直是 10pt
    const written = (page: Item[]): Item[] => page.filter((item) => /^(收款户名|开户银行|银行账号)：/.test(item.str));
    expect(new Set(written(pages[0]!).map((item) => item.size))).toEqual(new Set([6.5]));
    expect(new Set(written(pages[1]!).map((item) => item.size))).toEqual(new Set([10]));
  });

  it('keeps a long chosen note whole on the continuation page rather than cutting it in the middle', async () => {
    const note = '备注内容很长很长。'.repeat(60);
    const pages = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100000, payee: meatPayee })], { note }));
    expect(pages).toHaveLength(2);
    const first = compact(pages[0]!);
    expect(first).toContain(`银行账号：${ACCOUNT_A}`);
    expect(first).toContain('（接续页）');
    expect(first).not.toContain('备注内容');
    expect(compact(pages[1]!)).toContain(note);
  });

  it('cuts a note with no payees where the box ends, as the store form does', async () => {
    const note = '很长的备注。'.repeat(120);
    const pages = await drawPages(build([companyReceipt({ id: 'a', paidFen: 100000 })], { note }));
    expect(pages.length).toBeGreaterThan(1);
    expect(compact(pages[0]!)).toContain('（接续页）');
    // 备注一个字不少、不重复：把各页上只由备注里的字组成的几行（单字的是「备」「注」两个竖排标签）接起来就是原文
    const written = pages
      .flat()
      .filter((item) => item.str.length >= 2 && /^[很长的备注。]+$/.test(item.str))
      .map((item) => item.str)
      .join('');
    expect(written).toBe(note);
  });
});

describe('the note on a store form', () => {
  it('is cut by character when it does not fit, with 接续页 right after the last character: nothing changed for the store', async () => {
    // 一行放 16 个字，第一页放得下 4 行：第一段占 3 行，第二段只放得下第一行，在一段的中间断开
    const note = ['甲', '乙', '丙'].map((character) => character.repeat(40)).join('\n');
    const pages = await drawPages(buildStore([storeReceipt({ id: 'a' })], note));
    expect(pages).toHaveLength(2);
    const [first, second] = [compact(pages[0]!), compact(pages[1]!)];
    expect(count(first, '甲')).toBe(40);
    expect(count(first, '乙')).toBeGreaterThan(0);
    expect(count(first, '乙')).toBeLessThan(40);
    expect(count(first, '丙')).toBe(0);
    expect(first).toContain('（接续页）');
    expect(second).toContain('备注续页');
    // 一个字不少、不重复
    expect(count(first + second, '甲')).toBe(40);
    expect(count(first + second, '乙')).toBe(40);
    expect(count(first + second, '丙')).toBe(40);
    // 店内的备注一直是 10pt
    expect(new Set(pages[0]!.filter((item) => /^[甲乙丙]/.test(item.str)).map((item) => item.size))).toEqual(new Set([10]));
  });

  it('is centred in the box from top to bottom', async () => {
    const note = '请于本月5日前付款';
    const [page] = await drawPages(buildStore([storeReceipt({ id: 'a' })], note));
    const line = page!.find((item) => item.str === note)!;
    expect(line.size).toBe(10);
    const doc = createFormDocument();
    doc.fontSize(10);
    const lineHeight = doc.currentLineHeight(true);
    const ascent = ((doc as unknown as { _font: { ascender: number } })._font.ascender / 1000) * 10;
    doc.destroy();
    // 备注栏从表格上边框到「领导审批」的分隔线；字的上沿离上下两边一样远，基线 = 页高 - 字的上沿 - 字的上升高度
    const boxTop = mm(geometry.table.y);
    const boxHeight = mm(geometry.table.notesSplitY) - boxTop;
    const top = boxTop + (boxHeight - lineHeight) / 2;
    expect(line.y).toBeCloseTo(mm(geometry.page.height) - top - ascent, 1);
  });
});

describe('the project names on a company form', () => {
  /** 把第 1 张单上的第 1 行改成指定的分类、月份、是否续。 */
  function withRow(row: Pick<FormGroup, 'category' | 'period' | 'part'>): Batch {
    const batch = build([companyReceipt({ id: 'a', paidFen: 123456, category: '电费', period: '2026-07' })]);
    return {
      ...batch,
      sheets: batch.sheets.map((sheet) => ({
        ...sheet,
        groups: sheet.groups.map((group) => ({ ...group, ...row, period: row.period })),
      })),
    };
  }

  it('writes the month in the project name at 10pt when it fits', async () => {
    const [page] = await drawPages(withRow({ category: '电费', period: '2026-07' }));
    const label = page!.find((item) => item.str === '电费（2026年7月）');
    expect(label?.size).toBe(10);
  });

  it('shrinks a longer name, with the month and 续, to fit the column', async () => {
    const [page] = await drawPages(withRow({ category: '空调能源费', period: '2026-10', part: 2 }));
    const label = page!.find((item) => item.str.includes('空调能源费（2026年10月）（续）'));
    expect(label).toBeDefined();
    expect(label!.size).toBeLessThan(10);
    expect(label!.size).toBeGreaterThanOrEqual(6.5);
    // 金额栏里的数字不跟着缩
    const digits = page!.filter((item) => /^[0-9]$/.test(item.str));
    expect(new Set(digits.map((item) => item.size))).toEqual(new Set([10]));
  });

  // 项目栏能写 134pt 宽的字：一个全角字和字号一样宽，10pt 放 13 个，9pt 放 14 个，8pt 放 16 个，7pt 放 19 个，6.5pt 放 20 个
  it.each([
    [1, 10],
    [13, 10],
    [14, 9],
    [15, 8],
    [16, 8],
    [17, 7],
    [19, 7],
    [20, 6.5],
  ])('writes a name of %i wide characters at %s pt: the largest size that fits', async (length, size) => {
    const name = '很'.repeat(length);
    const [page] = await drawPages(withRow({ category: name as FormGroup['category'], period: undefined }));
    expect(page!.find((item) => item.str === name)?.size).toBe(size);
  });

  it('uses 6.5pt as the smallest size: twenty wide characters fit at that size, twenty-one do not', async () => {
    const [page] = await drawPages(withRow({ category: '很'.repeat(20) as FormGroup['category'], period: undefined }));
    expect(page!.find((item) => item.str === '很'.repeat(20))?.size).toBe(6.5);
    const batch = withRow({ category: '很'.repeat(21) as FormGroup['category'], period: undefined });
    const doc = createFormDocument();
    expect(() => drawForm(doc, batch, batch.sheets[0]!, null)).toThrow('FORM_TEXT_OVERFLOW');
    doc.destroy();
  });

  it('keeps a shrunk name centred in its row, as a 10pt one is', async () => {
    const [big] = await drawPages(withRow({ category: '电费', period: '2026-07' }));
    const [small] = await drawPages(withRow({ category: '空调能源费', period: '2026-10', part: 2 }));
    const bigLabel = big!.find((item) => item.str === '电费（2026年7月）')!;
    const smallLabel = small!.find((item) => item.str.includes('空调能源费（2026年10月）（续）'))!;
    // 居中时，小一号的字基线只比 10pt 的高一点点（每小 1pt 约 0.44pt）；不重新居中的话，每小 1pt 要差约 1.16pt
    const shift = Math.abs(smallLabel.y - bigLabel.y);
    expect(shift).toBeLessThan(0.8 * (10 - smallLabel.size));
  });

  it('refuses a name too long for the column even at the smallest size', () => {
    const batch = withRow({ category: '很'.repeat(40) as FormGroup['category'], period: '2026-07' });
    const doc = createFormDocument();
    expect(() => drawForm(doc, batch, batch.sheets[0]!, null)).toThrow('FORM_TEXT_OVERFLOW');
    doc.destroy();
  });

  it('keeps a store project name at 10pt', async () => {
    const [page] = await drawPages(buildStore([storeReceipt({ id: 'a' })]));
    expect(page!.find((item) => item.str === '耗材')?.size).toBe(10);
  });
});

describe('the whole payment PDF', () => {
  let store: Store;
  let temp: string;
  let config: Config;

  beforeEach(async () => {
    store = openStore(':memory:');
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-company-pdf-'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function storedImage(receiptId: string, background: string): Promise<ImageRef> {
    const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background } }).png().toBuffer();
    const image: ImageRef = {
      id: `${receiptId}-original`,
      path: `2026-09/originals/${receiptId}-original.png`,
      mime: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      perceptualHash: '0000000000000000',
      bytes: bytes.length,
      width: 160,
      height: 100,
      deletedAt: null,
    };
    const path = safePath(temp, image.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    store.put('files', { id: image.id, ownerId: receiptId, kind: 'original', path: image.path, sha256: image.sha256, deletedAt: null });
    return image;
  }

  it('puts each receipt once after the form it is on: two receipts, then the notice', { timeout: 20000 }, async () => {
    const colors = ['#245c77', '#b2452f', '#4d7028'];
    for (const [index, receipt] of exampleReceipts().entries()) {
      store.put('receipts', { ...receipt, original: await storedImage(receipt.id, colors[index]!) });
    }
    const settings: Settings = { ...getSettings(store), companyDepartment: COMPANY, signerName: '张三' };
    const batch = createBatch(store, ['meat', 'brand', 'notice'], resolveOptions(settings, now, 'company'), now);
    expect(batch.sheets.map((sheet) => sheet.groups.length)).toEqual([2, 5]);

    const pages = (await readPages(await renderBatchPdf(store, config, batch))).map((page) => compact(page));
    // 第 1 张单 + 2 张回单，第 2 张单 + 1 张通知单（只附一次）
    expect(pages).toHaveLength(5);
    expect(pages[0]).toContain('公账付款单');
    expect(pages[0]).toContain(`收款户名：${meatPayee.name}`);
    expect(pages[1]).toContain('第1张付款单·肉款第1/1张·本张12909.49·肉款合计12909.49原始凭证');
    expect(pages[2]).toContain('第1张付款单·品牌管理费第1/1张·本张6785.00·品牌管理费合计6785.00原始凭证');
    expect(pages[3]).toContain('公账付款单');
    expect(pages[3]).toContain(`收款户名：${noticePayee.name}`);
    expect(pages[3]).toContain('电费（2026年7月）');
    expect(pages[4]).toContain('第2张付款单·本张凭证39561.63，含5项');
    expect(pages[4]).toContain('原始凭证');
    expect(pages[3]).toContain('单据及附件共2页');
    expect(pages.join('')).not.toContain('报销');
  });
});

describe('cutting a note at the end of a line', () => {
  //            0         1         2
  //            0123456789012345678901
  const text = 'A1\nA2\nA3\n\nB1\nB2\nB3\n\nC1';

  it('cuts between two payees where the cut already is one', () => {
    expect(snapToLine(text, 8)).toBe(8); // A3 的末尾，后面是空行
    expect(snapToLine(text, 9)).toBe(9); // 空行当中
    expect(snapToLine(text, 10)).toBe(10); // 空行之后
    expect(snapToLine(text, 18)).toBe(18);
  });

  it('moves a cut in the middle of a payee back to the blank line before it', () => {
    expect(snapToLine(text, 11)).toBe(10); // B1 中间
    expect(snapToLine(text, 12)).toBe(10); // B1 的末尾
    expect(snapToLine(text, 14)).toBe(10); // B2 中间
    expect(snapToLine(text, 17)).toBe(10); // B3 中间
    expect(snapToLine(text, 21)).toBe(20); // C1 中间
    // 开头就是空行：第一家前面的空行也是退回的地方
    expect(snapToLine('\n\nAB\nCD', 5)).toBe(2);
  });

  it('cuts at the line end when there is no blank line to go back to, and by character on the first line', () => {
    expect(snapToLine(text, 3)).toBe(3); // A2 之前
    expect(snapToLine(text, 4)).toBe(3); // A2 中间
    expect(snapToLine(text, 7)).toBe(6); // A3 中间
    // 没有空行的几行：断口在一行的末尾就留着这一行
    expect(snapToLine('A1\nA2\nA3', 5)).toBe(5);
    expect(snapToLine('A1\nA2\nA3', 4)).toBe(3);
    expect(snapToLine(text, 1)).toBe(1); // 第一行就放不下：按字断
    expect(snapToLine('第一行很长很长', 4)).toBe(4);
    // 第一行是空的：那个换行就是退回的地方
    expect(snapToLine('\nABCDEF', 3)).toBe(1);
  });

  it('leaves the two ends alone', () => {
    expect(snapToLine(text, 0)).toBe(0);
    expect(snapToLine(text, -1)).toBe(-1);
    expect(snapToLine('\n\nX', -1)).toBe(-1);
    expect(snapToLine(text, text.length)).toBe(text.length);
    expect(snapToLine(text, text.length + 5)).toBe(text.length + 5);
    expect(snapToLine('\n\nX', 1)).toBe(1);
  });
});

describe('laying out a note', () => {
  const WIDTH = 162.5;
  const HEIGHT = 104.4;
  const lay = (
    candidates: string[],
    height = HEIGHT,
    byLine = true,
    styles = COMPANY_NOTE_STYLES,
    continuationHeight = 400,
  ) => {
    const doc = createFormDocument();
    try {
      return layoutNote(doc, candidates, WIDTH, height, 500, continuationHeight, styles, byLine);
    } finally {
      doc.destroy();
    }
  };
  const block3 = (n: number): string => `收款户名：第${n}家\n开户银行：某某银行\n银行账号：62170000${n}`;

  it('writes nothing for an empty note', () => {
    expect(lay([''])).toEqual({ firstPage: '', style: COMPANY_NOTE_STYLES[0], continuation: [] });
    expect(lay([''], HEIGHT, false, [STORE_NOTE_STYLE])).toEqual({ firstPage: '', style: STORE_NOTE_STYLE, continuation: [] });
  });

  it('takes the largest size at which the note fits, and at that size the airiest way of writing it', () => {
    expect(lay(['第一家\n第二家'])).toMatchObject({ firstPage: '第一家\n第二家', style: { size: 10 }, continuation: [] });
    // 三行放不下（至少 55pt），两行放得下：宁可挤紧也先不缩字号，不是先缩字号保留空行
    const roomy = lay(['第一家\n\n第二家', '第一家\n第二家'], 40);
    expect(roomy).toMatchObject({ firstPage: '第一家\n第二家', style: { size: 10 }, continuation: [] });
    // 两种都放得下时用舒展的
    expect(lay(['第一家\n\n第二家', '第一家\n第二家'], 60)).toMatchObject({ firstPage: '第一家\n\n第二家', style: { size: 10 } });
  });

  it('goes down one size at a time and stops at the first that fits', () => {
    const lines = Array.from({ length: 6 }, (_, index) => `第${index + 1}行`).join('\n');
    const result = lay([lines]);
    expect(result.continuation).toEqual([]);
    expect(COMPANY_NOTE_STYLES.map((style) => style.size)).toEqual([10, 9, 8, 7, 6.5]);
    // 6 行：10pt 要 111pt，9pt 要 99pt（放得下）
    expect(result.style.size).toBe(9);
  });

  it('puts the part that does not fit on continuation pages, whole payees at a time, with 接续页 on its own line', () => {
    const block = (n: number): string => `收款户名：第${n}家\n开户银行：某某银行\n银行账号：62170000${n}`;
    const text = [1, 2, 3, 4, 5].map(block).join('\n\n');
    const result = lay([text, text.replace(/\n\n/g, '\n')]);
    expect(result.style.size).toBe(6.5);
    expect(result.firstPage.endsWith('\n（接续页）')).toBe(true);
    const shown = result.firstPage.slice(0, -'\n（接续页）'.length);
    // 第一页是前几家，整家整家地放，家和家之间留一个空行，末尾没有空行
    expect(shown).toBe([1, 2].map(block).join('\n\n'));
    expect(result.continuation).toEqual([[3, 4, 5].map(block).join('\n\n')]);
    // 两页合起来就是全部
    expect(`${shown}\n\n${result.continuation.join('\n\n')}`).toBe(text);
  });

  it('cuts by character, with 接续页 right after the last character, when asked to (the store form)', () => {
    const text = '很长的备注。'.repeat(120);
    const result = lay([text], HEIGHT, false, [STORE_NOTE_STYLE]);
    expect(result.style).toEqual(STORE_NOTE_STYLE);
    expect(result.firstPage.endsWith('（接续页）')).toBe(true);
    expect(result.firstPage.includes('\n')).toBe(false);
    const shown = result.firstPage.slice(0, -'（接续页）'.length);
    expect(`${shown}${result.continuation.join('')}`).toBe(text);
  });

  it('writes only the 接续页 line when not even one line of the note fits above it', () => {
    const text = [1, 2].map(block3).join('\n\n');
    const result = lay([text], 16);
    expect(result.firstPage).toBe('（接续页）');
    expect(result.continuation).toEqual([text]);
  });

  it('does not start the first page with the blank lines the note itself starts with', () => {
    const blocks = [1, 2, 3, 4, 5].map(block3).join('\n\n');
    const result = lay([`\n\n${blocks}`]);
    expect(result.firstPage.startsWith('\n')).toBe(false);
    expect(result.firstPage.endsWith('\n（接续页）')).toBe(true);
    const shown = result.firstPage.slice(0, -'\n（接续页）'.length);
    expect([shown, ...result.continuation].join('\n\n')).toBe(blocks);
  });

  it('puts one whole payee on each continuation page that is just tall enough for one', () => {
    const text = [1, 2, 3, 4, 5, 6, 7, 8].map(block3).join('\n\n');
    // 续页 10pt、一行 18.5pt：60pt 正好放 3 行，也就是一家；每页开头不带上一页留下的空行
    const result = lay([text], HEIGHT, true, COMPANY_NOTE_STYLES, 60);
    expect(result.firstPage).toBe(`${[1, 2].map(block3).join('\n\n')}\n（接续页）`);
    expect(result.continuation).toEqual([3, 4, 5, 6, 7, 8].map(block3));
  });

  it('counts the lines of a continuation page at the size they are drawn at, 10pt', () => {
    const text = [1, 2, 3, 4, 5, 6, 7, 8].map(block3).join('\n\n');
    // 120pt 放 6 行（10pt）：一家 3 行 + 空行 + 下一家的 2 行，放不下整家，所以一页一家；
    // 要是按 6.5pt 算，一页会放进两家，画出来（10pt）就超出页面了
    const result = lay([text], HEIGHT, true, COMPANY_NOTE_STYLES, 120);
    expect(result.continuation).toEqual([3, 4, 5, 6, 7, 8].map(block3));
  });

  it('does not leave blank lines at the top or the bottom of a continuation page', () => {
    const block = (n: number): string => `收款户名：第${n}家有一个很长很长很长很长很长很长很长很长很长很长很长的名字\n开户银行：某某银行\n银行账号：62170000${n}`;
    const text = Array.from({ length: 30 }, (_, index) => block(index + 1)).join('\n\n');
    const result = lay([text]);
    expect(result.continuation.length).toBeGreaterThan(1);
    for (const page of result.continuation) {
      expect(page.startsWith('\n')).toBe(false);
      expect(page.endsWith('\n')).toBe(false);
      // 每页都是整家：收款户名、开户银行、银行账号一样多
      expect(count(page, '收款户名：')).toBe(count(page, '银行账号：'));
    }
    const all = [result.firstPage.slice(0, -'\n（接续页）'.length), ...result.continuation].join('\n\n');
    expect(all).toBe(text);
  });
});
