import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import type { Batch, Category, FormSheet } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createBatch } from '../src/batches.js';
import { openStore, type Store } from '../src/db.js';
import { createFormDocument, drawForm, sheetAttachmentCount } from '../src/render/form.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { sampleReceipt } from './support.js';

describe('Chinese reimbursement form', () => {
  it('extracts all printed labels and the sheet-specific uppercase total', async () => {
    const store = openStore(':memory:');
    try {
      for (const [index, paidFen] of [3633, 1730, 3575, 4136].entries()) {
        store.put('receipts', sampleReceipt({
          id: `receipt-${index}`,
          paidFen,
          category: '耗材',
          uploadOrder: index + 1,
        }));
      }
      const batch = createBatch(
        store,
        ['receipt-0', 'receipt-1', 'receipt-2', 'receipt-3'],
        resolveOptions(getSettings(store), new Date('2026-09-04T00:00:00.000Z')),
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const sheet = batch.sheets[0]!;
      expect(sheetAttachmentCount(batch, sheet)).toBe(4);
      const doc = createFormDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

      drawForm(doc, batch, sheet, null);
      doc.end();

      const pdf = await getDocument({
        data: new Uint8Array(await done),
        useSystemFonts: false,
      }).promise;
      const content = await (await pdf.getPage(1)).getTextContent();
      const text = content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
      const compact = text.replace(/\s+/g, '');
      expect(compact).toContain('费用报销单');
      for (const label of [
        '报销部门', '报销项目', '摘要', '金额', '(大写)',
        '单据及附件共', '备注', '报销人', '会计主管', '复核', '出纳', '领导审批',
      ]) {
        expect(compact).toContain(label);
      }
      expect(compact).toContain('佰拾万仟佰拾元角分');
      expect(compact).toContain('13074');
      // 大写金额栏逐格填中文大写数字（P-06）：13074 分 = 130.74 元 → 佰拾元角分 格填 壹叁零柒肆
      expect(compact).toContain('壹叁零柒肆');
      // 摘要逐张写实报金额（上传顺序），4 张同分类凭证放得下一行；不再写「共 N 张，明细见附件」
      expect(compact).toContain('36.3317.3035.7541.36');
      expect(compact).not.toContain('明细见附件');
    } finally {
      store.close();
    }
  });

  it('renders blank-date image signers and reports a stored layout that no longer fits as outdated', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'receipt', paidFen: 100, category: '耗材' }));
      const batch = createBatch(
        store,
        ['receipt'],
        { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const sheet = batch.sheets[0]!;
      const imageSigner = {
        ...batch,
        options: { ...batch.options, signerMode: 'image' as const },
      };
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#135724' },
      }).png().toBuffer();
      const imageDoc = createFormDocument();
      drawForm(imageDoc, imageSigner, sheet, png);
      imageDoc.end();

      // 表体固定 5 行、每个分类至少占一行：6 个分类放不下，说明这是按旧版式排的草稿 → LAYOUT_OUTDATED
      const overflowingSheet = {
        ...sheet,
        groups: Array.from({ length: 6 }, () => ({ ...sheet.groups[0]! })),
      };
      const overflowDoc = createFormDocument();
      expect(() => drawForm(overflowDoc, batch, overflowingSheet, null)).toThrow('LAYOUT_OUTDATED');
      overflowDoc.end();
    } finally {
      store.close();
    }
  });

  it('rejects an over-wide department at render time', () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'wide', paidFen: 999999999, category: '耗材' }));
      const batch = createBatch(
        store,
        ['wide'],
        { department: '超'.repeat(90), date: null, signerMode: 'text', signerName: '', signature: null },
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const doc = createFormDocument();
      expect(() => drawForm(doc, batch, batch.sheets[0]!, null)).toThrow('FORM_TEXT_OVERFLOW');
      doc.destroy();
    } finally {
      store.close();
    }
  });

  it('shrinks a long department to fit instead of rejecting it', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'long-dept', paidFen: 100, category: '耗材' }));
      const department = '华东区门店运营管理部综合行政组';
      const batch = createBatch(
        store,
        ['long-dept'],
        { department, date: null, signerMode: 'text', signerName: '', signature: null },
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const doc = createFormDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
      drawForm(doc, batch, batch.sheets[0]!, null);
      doc.end();
      const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
      const content = await (await pdf.getPage(1)).getTextContent();
      const compact = content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('').replace(/\s+/g, '');
      expect(compact).toContain(department);
    } finally {
      store.close();
    }
  });

  it('paginates an over-long note onto continuation pages counted in the page total', async () => {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'noted', paidFen: 100, category: '耗材' }));
      const batch = createBatch(
        store,
        ['noted'],
        { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const note = `备注开头。${'这是一段很长的手写备注内容，用来验证续页分页逻辑是否正常工作。'.repeat(12)}备注结尾。`;
      const noted = {
        ...batch,
        notes: [{ id: 'note-long', name: '长备注', content: note }],
        sheets: [{ ...batch.sheets[0]!, noteId: 'note-long' }],
      };
      const doc = createFormDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
      drawForm(doc, noted, noted.sheets[0]!, null);
      doc.end();
      const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
      expect(pdf.numPages).toBe(2);
      const pageText = async (pageNumber: number): Promise<string> => {
        const content = await (await pdf.getPage(pageNumber)).getTextContent();
        return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('').replace(/\s+/g, '');
      };
      const first = await pageText(1);
      const second = await pageText(2);
      expect(first).toContain('（接续页）');
      // 1 张凭证附件 + 1 页备注续页 → 单据及附件共 3 页
      expect(first).toContain('单据及附件共3页');
      expect(second).toContain('备注续页');
      expect(second).toContain('备注结尾。');
      expect(first + second).toContain('备注开头。');
    } finally {
      store.close();
    }
  });
});

// 试点反馈：备注在格子里水平、垂直居中（之前偏左上）。
describe('note box centering', () => {
  const geometry = JSON.parse(
    readFileSync(join(__dirname, '../assets/form-geometry.json'), 'utf8'),
  ) as {
    page: { height: number };
    table: { x: number; y: number; width: number; notesSplitY: number; columns: { notes: number } };
  };
  const mm = (value: number): number => (value * 72) / 25.4;
  const cellLeft = mm(geometry.table.x + geometry.table.width - geometry.table.columns.notes);
  const cellRight = mm(geometry.table.x + geometry.table.width);
  const cellCenterX = (cellLeft + cellRight) / 2;
  // pdf.js 的纵坐标从页面底部向上数
  const cellTop = mm(geometry.page.height) - mm(geometry.table.y);
  const cellBottom = mm(geometry.page.height) - mm(geometry.table.notesSplitY);
  const cellCenterY = (cellTop + cellBottom) / 2;

  interface Line { text: string; centerX: number; baseline: number }

  async function noteLines(note: string): Promise<Line[]> {
    const store = openStore(':memory:');
    try {
      store.put('receipts', sampleReceipt({ id: 'centered', paidFen: 100, category: '耗材' }));
      const batch = createBatch(
        store,
        ['centered'],
        { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
        new Date('2026-09-04T00:00:00.000Z'),
      );
      const noted = {
        ...batch,
        notes: [{ id: 'note-centered', name: '居中', content: note }],
        sheets: [{ ...batch.sheets[0]!, noteId: 'note-centered' }],
      };
      const doc = createFormDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
      drawForm(doc, noted, noted.sheets[0]!, null);
      doc.end();
      const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
      const content = await (await pdf.getPage(1)).getTextContent();
      return content.items.flatMap((item) => {
        if (!('str' in item) || item.str.trim() === '') return [];
        const [, , , , x, baseline] = item.transform as number[];
        const centerX = x! + item.width / 2;
        const inside = centerX > cellLeft && centerX < cellRight && baseline! < cellTop && baseline! > cellBottom;
        return inside ? [{ text: item.str, centerX, baseline: baseline! }] : [];
      }).sort((left, right) => right.baseline - left.baseline);
    } finally {
      store.close();
    }
  }

  // 字形的视觉中心大约在基线上方 0.35 个字号
  const visualCenter = (lines: Line[]): number =>
    (lines[0]!.baseline + lines.at(-1)!.baseline) / 2 + 3.5;

  it('centers a one-line note in the note cell both ways', async () => {
    const lines = await noteLines('居中测试');
    expect(lines).toHaveLength(1);
    expect(Math.abs(lines[0]!.centerX - cellCenterX)).toBeLessThan(0.6);
    expect(Math.abs(visualCenter(lines) - cellCenterY)).toBeLessThan(2.5);
  });

  it('centers every line of a multi-line note, including lines ended by an explicit newline', async () => {
    const lines = await noteLines('第一行\n第二行文字更长\n第三行');
    expect(lines.map((line) => line.text)).toEqual(['第一行', '第二行文字更长', '第三行']);
    for (const line of lines) {
      // PDFKit 原本会把行尾换行符的宽度算进去，让前两行偏左半个字
      expect(Math.abs(line.centerX - cellCenterX)).toBeLessThan(0.6);
    }
    expect(Math.abs(visualCenter(lines) - cellCenterY)).toBeLessThan(2.5);
  });

  it('keeps blank lines as spacing and centers a long wrapped line', async () => {
    const spaced = await noteLines('甲\n\n乙');
    expect(spaced.map((line) => line.text)).toEqual(['甲', '乙']);
    // 中间空一行：两行基线相差两个行距
    expect(spaced[0]!.baseline - spaced[1]!.baseline).toBeCloseTo(2 * 18.48, 1);
    expect(Math.abs(visualCenter(spaced) - cellCenterY)).toBeLessThan(2.5);

    const wrapped = await noteLines('很长的一行备注文字'.repeat(6));
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(Math.abs(line.centerX - cellCenterX)).toBeLessThan(0.6);
    expect(Math.abs(visualCenter(wrapped) - cellCenterY)).toBeLessThan(2.5);
  });

  it('does not add a phantom line for a trailing newline', async () => {
    const plain = await noteLines('只有一行');
    const trailing = await noteLines('只有一行\n');
    expect(trailing).toHaveLength(1);
    expect(trailing[0]!.baseline).toBeCloseTo(plain[0]!.baseline, 1);
  });
});

// 试点反馈：摘要逐张写实报金额；分类占几行就在报销项目、金额两栏里合并成一格，居中写一次；
// 一个分类一张放不下时接到下一张，写「分类（续）」和这一部分的小计。
describe('summary rows and merged category cells', () => {
  const geometry = JSON.parse(
    readFileSync(join(__dirname, '../assets/form-geometry.json'), 'utf8'),
  ) as {
    page: { height: number };
    table: {
      x: number; y: number; headerHeight: number; bodyHeight: number; bodyRows: number;
      columns: { project: number; summary: number; amount: number; verticalLabel: number };
    };
  };
  const mm = (value: number): number => (value * 72) / 25.4;
  const pageHeight = mm(geometry.page.height);
  const rowHeight = mm(geometry.table.bodyHeight) / geometry.table.bodyRows;
  // PDFKit 的纵坐标自页面顶部向下数；pdf.js 的文字坐标自页面底部向上数
  const bodyTop = mm(geometry.table.y + geometry.table.headerHeight);
  const projectX = mm(geometry.table.x);
  const summaryX = projectX + mm(geometry.table.columns.project);
  const amountX = summaryX + mm(geometry.table.columns.summary);
  const verticalLabelX = amountX + mm(geometry.table.columns.amount);
  // 行 row（0 起）、占 rowCount 行的格子，中心在 pdf.js 坐标里的纵坐标
  const cellCenter = (row: number, rowCount = 1): number => pageHeight - (bodyTop + (row + rowCount / 2) * rowHeight);
  // 10pt 字形的视觉中心大约在基线上方 3.6pt；居中误差要在 1.5pt 以内
  const isCentered = (baseline: number, row: number, rowCount = 1): boolean =>
    Math.abs(baseline + 3.6 - cellCenter(row, rowCount)) < 1.5;

  const foods = (count: number, first = 10000): Array<[Category, number]> =>
    Array.from({ length: count }, (_, index) => ['食材', first + index]);

  it('writes every receipt amount in upload order on one summary row with the category total beside it', async () => {
    const store = openStore(':memory:');
    try {
      const batch = batchOf(store, [['食材', 49000], ['食材', 1988], ['食材', 23160]]);
      expect(batch.sheets).toHaveLength(1);
      const items = await pageItems(await renderSheet(batch, batch.sheets[0]!));

      const amounts = ['490.00', '19.88', '231.60'].map((text) => items.find((item) => item.str === text)!);
      expect(amounts.every((item) => item !== undefined)).toBe(true);
      // 同一行、按上传顺序从左到右，中间隔开一段空白
      expect(new Set(amounts.map((item) => item.baseline.toFixed(2))).size).toBe(1);
      for (const [left, right] of [[amounts[0]!, amounts[1]!], [amounts[1]!, amounts[2]!]] as const) {
        const gap = right.x - (left.x + left.width);
        expect(gap).toBeGreaterThan(6);
        expect(gap).toBeLessThan(12);
      }
      // 分类合计 741.48 写在金额栏，和摘要那一行上下对齐
      const digits = items.filter((item) => /^\d$/.test(item.str) && item.x > amountX && item.x < verticalLabelX);
      const categoryDigits = digits.filter((item) => Math.abs(item.baseline - amounts[0]!.baseline) < 0.5);
      expect(categoryDigits.map((item) => item.str).join('')).toBe('74148');
      expect(items.filter((item) => item.str === '食材')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('gives a category as many rows as its amounts need and centers its name and total across them', async () => {
    const store = openStore(':memory:');
    try {
      // 食材 10 张：一行放不下，占第 0、1 行；酒水 1 张占第 2 行
      const batch = batchOf(store, [...foods(10), ['酒水', 5600]]);
      expect(batch.sheets).toHaveLength(1);
      const items = await pageItems(await renderSheet(batch, batch.sheets[0]!));
      const find = (text: string) => items.filter((item) => item.str === text);

      const first = find('100.00')[0]!;
      const sixth = find('100.05')[0]!;
      const seventh = find('100.06')[0]!;
      // 第一行写前 6 张，第 7 张接着写第二行，第二行从同一个左边距开始
      expect(sixth.baseline).toBeCloseTo(first.baseline, 1);
      expect(first.baseline - seventh.baseline).toBeCloseTo(rowHeight, 1);
      expect(seventh.x).toBeCloseTo(first.x, 1);
      expect(isCentered(first.baseline, 0)).toBe(true);

      // 分类名只写一次，在两行的正中间
      const label = find('食材');
      expect(label).toHaveLength(1);
      expect(isCentered(label[0]!.baseline, 0, 2)).toBe(true);
      // 分类合计 1000.45 也只写一次，同样在两行正中间
      const totalDigits = items.filter((item) => /^\d$/.test(item.str) && item.x > amountX && item.x < verticalLabelX
        && Math.abs(item.baseline - label[0]!.baseline) < 0.5);
      expect(totalDigits.map((item) => item.str).join('')).toBe('100045');
      // 下一个分类从第 2 行开始
      const next = find('酒水');
      expect(next).toHaveLength(1);
      expect(isCentered(next[0]!.baseline, 2)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('draws no rule between the rows of one category in the project and amount columns', async () => {
    const store = openStore(':memory:');
    try {
      const batch = batchOf(store, [...foods(10), ['酒水', 5600]]);
      const rules = horizontalRules(await renderSheet(batch, batch.sheets[0]!));
      const rulesAtRow = (row: number) =>
        rules.filter((rule) => Math.abs(rule.y - (bodyTop + row * rowHeight)) < 0.01);

      // 第 1 条线在食材的两行之间：只在摘要栏里画（每行一排金额），像合并单元格
      const inside = rulesAtRow(1);
      expect(inside).toHaveLength(1);
      expect(inside[0]!.x1).toBeCloseTo(summaryX, 1);
      expect(inside[0]!.x2).toBeCloseTo(amountX, 1);
      // 第 2、3、4 条线是分类之间（或空行）的线，整行贯通
      for (const row of [2, 3, 4]) {
        const between = rulesAtRow(row);
        expect(between).toHaveLength(1);
        expect(between[0]!.x1).toBeCloseTo(projectX, 1);
        expect(between[0]!.x2).toBeCloseTo(verticalLabelX, 1);
      }
    } finally {
      store.close();
    }
  });

  it('continues a category that does not fit one form on the next one as （续） with its own subtotal', async () => {
    const store = openStore(':memory:');
    try {
      // 40 张同类凭证：每行 6 张、一张 5 行，第一张放 30 张，余下 10 张接到第二张
      const batch = batchOf(store, [...foods(40), ['酒水', 5600]]);
      expect(batch.sheets.map((sheet) => sheet.groups.map((group) => [group.category, group.part, group.amountsFen.length, group.totalFen]))).toEqual([
        [['食材', 1, 30, 300435]],
        [['食材', 2, 10, 100345], ['酒水', undefined, 1, 5600]],
      ]);
      expect(batch.sheets[0]!.groups[0]!.totalFen + batch.sheets[1]!.groups[0]!.totalFen).toBe(400780);
      expect(sheetAttachmentCount(batch, batch.sheets[0]!)).toBe(30);

      const firstItems = await pageItems(await renderSheet(batch, batch.sheets[0]!));
      const secondItems = await pageItems(await renderSheet(batch, batch.sheets[1]!));
      const compact = (items: PageItem[]) => items.map((item) => item.str).join('');

      expect(firstItems.filter((item) => item.str === '食材')).toHaveLength(1);
      expect(compact(firstItems)).not.toContain('（续）');
      expect(compact(firstItems)).toContain('300435');
      expect(compact(firstItems)).toContain('单据及附件共31页');
      // 第 5 行写到第 30 张，整张表体写满
      expect(firstItems.some((item) => item.str === '100.29')).toBe(true);
      expect(firstItems.some((item) => item.str === '100.30')).toBe(false);

      expect(secondItems.filter((item) => item.str === '食材（续）')).toHaveLength(1);
      expect(secondItems.filter((item) => item.str === '食材')).toHaveLength(0);
      expect(compact(secondItems)).toContain('100345');
      expect(secondItems.some((item) => item.str === '100.30')).toBe(true);
      expect(secondItems.some((item) => item.str === '100.39')).toBe(true);
      // 这一张的合计 = 食材（续）小计 1003.45 + 酒水 56.00
      expect(compact(secondItems)).toContain('105945');
    } finally {
      store.close();
    }
  });
});

interface PageItem { str: string; x: number; baseline: number; width: number }

function batchOf(store: Store, rows: Array<[Category, number]>): Batch {
  rows.forEach(([category, paidFen], index) => {
    store.put('receipts', sampleReceipt({ id: `row-${index}`, category, paidFen, uploadOrder: index + 1 }));
  });
  return createBatch(
    store,
    rows.map((_, index) => `row-${index}`),
    { department: '', date: null, signerMode: 'text', signerName: '', signature: null },
    new Date('2026-09-04T00:00:00.000Z'),
  );
}

async function renderSheet(batch: Batch, sheet: FormSheet): Promise<Buffer> {
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  drawForm(doc, batch, sheet, null);
  doc.end();
  return done;
}

async function pageItems(bytes: Buffer, pageNumber = 1): Promise<PageItem[]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const content = await (await pdf.getPage(pageNumber)).getTextContent();
  return content.items.flatMap((item) => {
    if (!('str' in item) || item.str.trim() === '') return [];
    const [, , , , x, baseline] = item.transform as number[];
    return [{ str: item.str, x: x!, baseline: baseline!, width: item.width }];
  });
}

// 从 PDF 内容流里取出所有水平的描边线（PDFKit 写成「x y m  x y l  S」，纵坐标自页面顶部向下数）。
function horizontalRules(bytes: Buffer): Array<{ y: number; x1: number; x2: number }> {
  const text = bytes.toString('latin1');
  const rules: Array<{ y: number; x1: number; x2: number }> = [];
  for (const start of text.matchAll(/stream\r?\n/g)) {
    const from = start.index + start[0].length;
    let content: string;
    try {
      content = inflateSync(bytes.subarray(from, text.indexOf('endstream', from))).toString('latin1');
    } catch {
      continue; // 字体、图片等不是内容流
    }
    for (const segment of content.matchAll(/(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g)) {
      const [x1, y1, x2, y2] = segment.slice(1).map(Number) as [number, number, number, number];
      if (y1 === y2) rules.push({ y: y1, x1: Math.min(x1, x2), x2: Math.max(x1, x2) });
    }
  }
  return rules;
}
