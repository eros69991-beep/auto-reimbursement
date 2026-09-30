import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createBatch } from '../src/batches.js';
import { openStore } from '../src/db.js';
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
      // 汇总版式：4 张同分类凭证只占一行，摘要写「共 4 张，明细见附件」（P-02/P-07）
      expect(compact).toContain('共4张，明细见附件');
    } finally {
      store.close();
    }
  });

  it('renders blank-date image signers and rejects a summary that exceeds its packed row', async () => {
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

      // 汇总版式下表体固定 5 行，6 个分类必然溢出 → FORM_TEXT_OVERFLOW
      const overflowingSheet = {
        ...sheet,
        groups: Array.from({ length: 6 }, () => ({ ...sheet.groups[0]! })),
      };
      const overflowDoc = createFormDocument();
      expect(() => drawForm(overflowDoc, batch, overflowingSheet, null)).toThrow('FORM_TEXT_OVERFLOW');
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
