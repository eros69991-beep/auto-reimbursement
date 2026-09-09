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
      for (const label of [
        '费用报销单', '报销部门', '报销项目', '摘要', '金额', '合计', '大写',
        '单据及附件共', '备注', '报销人', '会计主管', '复核', '出纳', '领导审批',
      ]) {
        expect(text).toContain(label);
      }
      expect(text).toContain('壹佰叁拾元柒角肆分');
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
});
