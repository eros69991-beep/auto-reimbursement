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

      const overflowingSheet = {
        ...sheet,
        groups: [{
          ...sheet.groups[0]!,
          amountsFen: Array.from({ length: 100 }, () => 999999999),
        }],
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
