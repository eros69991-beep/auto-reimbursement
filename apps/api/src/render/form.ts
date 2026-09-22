import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Batch, type FormSheet } from '@auto-reimbursement/contracts';
import PDFDocument from 'pdfkit';

import {
  groupHeight,
  type LayoutMetrics,
} from './layout.js';

interface Geometry {
  page: { width: number; height: number; margin: number };
  title: {
    fontSize: number;
    y: number;
    charStartX: number;
    charStep: number;
    underlineY: [number, number];
    underlineX: [number, number];
  };
  metadata: {
    y: number;
    departmentX: number;
    dateCenterX: number;
    dateWidth: number;
    attachmentsX: number;
    attachmentsLine: [number, number];
    pageLabelX: number;
  };
  table: {
    x: number;
    y: number;
    width: number;
    columns: { project: number; summary: number; amount: number; verticalLabel: number; notes: number };
    headerHeight: number;
    headerSplit: number;
    bodyHeight: number;
    bodyRows: number;
    totalHeight: number;
    uppercaseHeight: number;
    notesSplitY: number;
  };
  uppercaseStrip: { labelX: number; unitsStart: number; unitsEnd: number; loanEnd: number };
  footer: { y: number; approverX: number; reviewerX: number; cashierX: number; signerX: number };
}

const assetsPath = join(__dirname, '../../assets');
const geometry = JSON.parse(readFileSync(join(assetsPath, 'form-geometry.json'), 'utf8')) as Geometry;
const fontPath = join(assetsPath, 'fonts/NotoSansSC-Regular.ttf');
const PRINTED_BLUE = '#4B859E';
const BLACK = '#000000';
const mm = (value: number): number => (value * 72) / 25.4;

export function createFormDocument(): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: [mm(geometry.page.width), mm(geometry.page.height)],
    margin: 0,
  });
  try {
    doc.registerFont('NotoSansSC', fontPath);
    doc.font('NotoSansSC');
  } catch (error) {
    throw new Error(`FORM_FONT_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
  return doc;
}

export function formMetrics(doc: PDFKit.PDFDocument): LayoutMetrics {
  doc.font('NotoSansSC').fontSize(10);
  return {
    summaryWidth: mm(geometry.table.columns.summary) - 12,
    bodyHeight: mm(geometry.table.bodyHeight),
    rowHeight: mm(geometry.table.bodyHeight) / geometry.table.bodyRows,
    lineHeight: 14,
    groupPadding: 8,
    maxSheetFen: 999999999,
    measure: (text) => doc.widthOfString(text),
  };
}

export function sheetAttachmentCount(batch: Batch, sheet: FormSheet): number {
  const receiptIds = new Set(sheet.groups.flatMap((group) => group.receiptIds));
  return batch.items
    .filter((item) => receiptIds.has(item.receiptId))
    .reduce((count, item) => count + 1 + item.refundImages.length, 0);
}

export function drawForm(
  doc: PDFKit.PDFDocument,
  batch: Batch,
  sheet: FormSheet,
  signatureBytes: Buffer | null,
): void {
  const metrics = formMetrics(doc);
  const page = geometry.page;
  const table = geometry.table;
  const columns = table.columns;
  const x = mm(table.x);
  const y = mm(table.y);
  const projectX = x;
  const summaryX = projectX + mm(columns.project);
  const amountX = summaryX + mm(columns.summary);
  const verticalLabelX = amountX + mm(columns.amount);
  const notesX = verticalLabelX + mm(columns.verticalLabel);
  const right = x + mm(table.width);
  const headerSplit = y + mm(table.headerSplit);
  const headerBottom = y + mm(table.headerHeight);
  const bodyBottom = headerBottom + mm(table.bodyHeight);
  const totalBottom = bodyBottom + mm(table.totalHeight);
  const formBottom = totalBottom + mm(table.uppercaseHeight);
  const notesSplit = mm(table.notesSplitY);
  const total = sheet.groups.reduce((sum, group) => sum + group.totalFen, 0);
  const digits = String(total).padStart(3, '0').padStart(9, ' ');
  if (digits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
  const note = batch.notes.find((item) => item.id === sheet.noteId)?.content ?? '';

  doc.addPage({ size: [mm(page.width), mm(page.height)], margin: 0 });
  doc.font('NotoSansSC').fontSize(10).fillColor(PRINTED_BLUE);
  drawTitle(doc);
  drawMetadata(doc, batch, sheet);
  drawStructure(doc, { x, y, projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, bodyBottom, totalBottom, formBottom, notesSplit });
  drawHeaders(doc, { projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, y, notesSplit, totalBottom });
  drawGroups(doc, batch, sheet, metrics, { projectX, summaryX, amountX, verticalLabelX, headerBottom, bodyBottom });
  drawTotal(doc, digits, x, amountX, bodyBottom, mm(columns.amount), mm(table.totalHeight));
  drawUppercase(doc, digits, x, right, totalBottom, formBottom);
  drawNote(doc, note, notesX, y, mm(columns.notes), notesSplit - y);
  drawFooter(doc, batch, signatureBytes);
}

function drawTitle(doc: PDFKit.PDFDocument): void {
  const title = geometry.title;
  doc.fontSize(title.fontSize).fillColor(PRINTED_BLUE);
  [...'费用报销单'].forEach((character, index) => {
    const center = mm(title.charStartX + title.charStep * index);
    const width = doc.widthOfString(character);
    doc.text(character, center - width / 2, mm(title.y), { width, lineBreak: false });
  });
  doc.lineWidth(0.5).strokeColor(BLACK);
  for (const underlineY of title.underlineY) {
    doc.moveTo(mm(title.underlineX[0]), mm(underlineY)).lineTo(mm(title.underlineX[1]), mm(underlineY)).stroke();
  }
  doc.fontSize(10);
}

function drawMetadata(doc: PDFKit.PDFDocument, batch: Batch, sheet: FormSheet): void {
  const meta = geometry.metadata;
  const y = mm(meta.y);
  const date = batch.options.date;
  let dateText = '年　月　日';
  if (date !== null) {
    const [year, month, day] = date.split('-');
    dateText = `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  doc.text('报销部门：', mm(meta.departmentX), y, { lineBreak: false });
  const departmentX = mm(meta.departmentX) + doc.widthOfString('报销部门：');
  const departmentWidth = mm(meta.dateCenterX - meta.dateWidth / 2) - departmentX - 4;
  assertFits(doc, batch.options.department, departmentWidth, 'FORM_TEXT_OVERFLOW');
  doc.fillColor(BLACK).text(batch.options.department, departmentX, y, { width: departmentWidth, lineBreak: false });

  doc.fillColor(BLACK).text(dateText, mm(meta.dateCenterX - meta.dateWidth / 2), y, {
    width: mm(meta.dateWidth),
    align: 'center',
    lineBreak: false,
  });

  doc.fillColor(PRINTED_BLUE).text('单据及附件共', mm(meta.attachmentsX), y, { lineBreak: false });
  const count = String(1 + sheetAttachmentCount(batch, sheet));
  const [lineStart, lineEnd] = meta.attachmentsLine;
  doc.fillColor(BLACK).text(count, mm(lineStart), y, { width: mm(lineEnd - lineStart), align: 'center', lineBreak: false });
  doc.fillColor(PRINTED_BLUE).text('页', mm(meta.pageLabelX), y, { lineBreak: false });
  doc.lineWidth(0.5).strokeColor(BLACK)
    .moveTo(mm(lineStart), y + 11)
    .lineTo(mm(lineEnd), y + 11)
    .stroke();
}

interface Bounds {
  x: number;
  y: number;
  projectX: number;
  summaryX: number;
  amountX: number;
  verticalLabelX: number;
  notesX: number;
  right: number;
  headerSplit: number;
  headerBottom: number;
  bodyBottom: number;
  totalBottom: number;
  formBottom: number;
  notesSplit: number;
}

function drawStructure(doc: PDFKit.PDFDocument, bounds: Bounds): void {
  const { x, y, projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, bodyBottom, totalBottom, formBottom, notesSplit } = bounds;
  doc.lineWidth(0.5).strokeColor(BLACK).opacity(1);

  // Vertical rules: outer borders and the amount-column boundary run full height;
  // project/summary and the right-block label column stop above the uppercase strip.
  for (const vertical of [x, amountX, right]) {
    doc.moveTo(vertical, y).lineTo(vertical, formBottom).stroke();
  }
  for (const vertical of [summaryX, verticalLabelX, notesX]) {
    doc.moveTo(vertical, y).lineTo(vertical, totalBottom).stroke();
  }
  const digitWidth = mm(geometry.table.columns.amount) / 9;
  for (let index = 1; index < 9; index += 1) {
    const digitX = amountX + digitWidth * index;
    doc.moveTo(digitX, headerSplit).lineTo(digitX, totalBottom).stroke();
  }

  // Horizontal rules.
  doc.moveTo(x, y).lineTo(right, y).stroke();
  doc.moveTo(amountX, headerSplit).lineTo(verticalLabelX, headerSplit).stroke();
  doc.moveTo(x, headerBottom).lineTo(verticalLabelX, headerBottom).stroke();
  const rows = geometry.table.bodyRows;
  for (let row = 1; row < rows; row += 1) {
    const rowY = headerBottom + (mm(geometry.table.bodyHeight) * row) / rows;
    doc.moveTo(projectX, rowY).lineTo(verticalLabelX, rowY).stroke();
  }
  doc.moveTo(x, bodyBottom).lineTo(verticalLabelX, bodyBottom).stroke();
  doc.moveTo(verticalLabelX, notesSplit).lineTo(right, notesSplit).stroke();
  doc.moveTo(x, totalBottom).lineTo(right, totalBottom).stroke();
  doc.moveTo(x, formBottom).lineTo(right, formBottom).stroke();

  // Uppercase strip divider between the two loan cells.
  doc.moveTo(mm(geometry.uppercaseStrip.loanEnd), totalBottom).lineTo(mm(geometry.uppercaseStrip.loanEnd), formBottom).stroke();
}

function drawHeaders(doc: PDFKit.PDFDocument, bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'verticalLabelX' | 'notesX' | 'right' | 'headerSplit' | 'headerBottom' | 'y' | 'notesSplit' | 'totalBottom'>): void {
  const { projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, y, notesSplit, totalBottom } = bounds;
  doc.fillColor(PRINTED_BLUE);
  spread(doc, '报销项目', projectX, y + mm(5.2), summaryX - projectX, 12);
  spread(doc, '摘要', summaryX, y + mm(5.2), amountX - summaryX, 12);
  spread(doc, '金额', amountX, y + mm(1.8), verticalLabelX - amountX, 11);
  const labels = ['百', '十', '万', '千', '百', '十', '元', '角', '分'];
  const digitWidth = (verticalLabelX - amountX) / 9;
  doc.fontSize(9);
  labels.forEach((label, index) => centered(doc, label, amountX + digitWidth * index, headerSplit + mm(1.3), digitWidth));
  verticalText(doc, '备注', verticalLabelX, y, notesSplit - y, mm(10));
  verticalText(doc, '领导审批', verticalLabelX, notesSplit, totalBottom - notesSplit, mm(6.8));
}

function drawGroups(
  doc: PDFKit.PDFDocument,
  batch: Batch,
  sheet: FormSheet,
  metrics: LayoutMetrics,
  bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'verticalLabelX' | 'headerBottom' | 'bodyBottom'>,
): void {
  let y = bounds.headerBottom;
  const merchantById = new Map(batch.items.map((item) => [item.receiptId, item.merchant ?? null]));
  for (const group of sheet.groups) {
    const height = groupHeight(group, metrics);
    if (y + height > bounds.bodyBottom + 0.01) throw new Error('FORM_TEXT_OVERFLOW');
    if (group.amountsFen.length * metrics.lineHeight > height - metrics.groupPadding + 0.01) throw new Error('FORM_TEXT_OVERFLOW');
    assertFits(doc, group.category, bounds.summaryX - bounds.projectX - 12, 'FORM_TEXT_OVERFLOW');
    doc.fillColor(BLACK).fontSize(10).text(group.category, bounds.projectX + 6, y + 4, {
      width: bounds.summaryX - bounds.projectX - 12,
      lineBreak: false,
    });
    group.amountsFen.forEach((amount, index) => {
      const lineY = y + index * metrics.lineHeight;
      const summary = merchantById.get(group.receiptIds[index] ?? '') ?? group.category;
      assertFits(doc, summary, metrics.summaryWidth, 'FORM_TEXT_OVERFLOW');
      doc.fillColor(BLACK).text(summary, bounds.summaryX + 6, lineY + 4, {
        width: metrics.summaryWidth,
        lineBreak: false,
      });
      const digits = String(amount).padStart(3, '0').padStart(9, ' ');
      if (digits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
      drawAmountDigits(doc, digits, bounds.amountX, lineY, mm(geometry.table.columns.amount), metrics.lineHeight);
    });
    doc.lineWidth(0.5).strokeColor(BLACK).moveTo(bounds.projectX, y + height).lineTo(bounds.verticalLabelX, y + height).stroke();
    y += height;
  }
}

function drawTotal(doc: PDFKit.PDFDocument, digits: string, left: number, amountX: number, top: number, width: number, height: number): void {
  const region = amountX - left;
  doc.fillColor(PRINTED_BLUE).fontSize(12);
  for (const [character, fraction] of [['合', 1 / 3], ['计', 2 / 3]] as const) {
    const charWidth = doc.widthOfString(character);
    const center = left + region * fraction;
    doc.text(character, center - charWidth / 2, top + mm(2.6), { width: charWidth, lineBreak: false });
  }
  drawAmountDigits(doc, digits, amountX, top, width, height);
}

function drawAmountDigits(doc: PDFKit.PDFDocument, digits: string, amountX: number, y: number, width: number, height: number): void {
  const cellWidth = width / 9;
  doc.fillColor(BLACK).fontSize(10);
  [...digits].forEach((digit, index) => {
    if (digit !== ' ') centered(doc, digit, amountX + index * cellWidth, y + 3, cellWidth);
  });
}

const UPPERCASE_UNITS = ['佰', '拾', '万', '仟', '佰', '拾', '元', '角', '分'] as const;

function drawUppercase(doc: PDFKit.PDFDocument, digits: string, left: number, right: number, top: number, bottom: number): void {
  const strip = geometry.uppercaseStrip;
  const unitsStart = left + mm(strip.unitsStart);
  const unitsEnd = left + mm(strip.unitsEnd);
  const loanEnd = mm(strip.loanEnd);
  const cellWidth = (unitsEnd - unitsStart) / 9;

  doc.fillColor(PRINTED_BLUE);
  doc.fontSize(9);
  doc.text('金 额', left + mm(strip.labelX), top + mm(1.2), { lineBreak: false });
  doc.fontSize(7);
  doc.text('(大写)', left + mm(strip.labelX), top + mm(7.6), { lineBreak: false });
  doc.fontSize(9);
  UPPERCASE_UNITS.forEach((unit, index) => centered(doc, unit, unitsStart + index * cellWidth, top + mm(1), cellWidth));
  doc.fillColor(BLACK).fontSize(10);
  [...digits].forEach((digit, index) => {
    if (digit !== ' ') centered(doc, digit, unitsStart + index * cellWidth, top + mm(6.8), cellWidth);
  });

  doc.fillColor(PRINTED_BLUE).fontSize(9);
  drawLoanField(doc, '原借款：', unitsEnd, loanEnd, top, bottom);
  drawLoanField(doc, '应退(补)款：', loanEnd, right, top, bottom);
  doc.fontSize(10);
}

function drawLoanField(doc: PDFKit.PDFDocument, label: string, start: number, end: number, top: number, bottom: number): void {
  const y = top + mm(2.4);
  doc.text(label, start + mm(1.6), y, { width: end - start - mm(3.2), lineBreak: false });
  const labelWidth = doc.widthOfString(label);
  const yuanWidth = doc.widthOfString('元');
  doc.text('元', end - yuanWidth - mm(1.6), y, { width: yuanWidth, lineBreak: false });
  doc.lineWidth(0.5).strokeColor(BLACK)
    .moveTo(start + mm(1.6) + labelWidth + 4, bottom - mm(2.6))
    .lineTo(end - yuanWidth - mm(3.2), bottom - mm(2.6))
    .stroke();
}

function drawNote(doc: PDFKit.PDFDocument, note: string, x: number, top: number, width: number, height: number): void {
  if (note === '') return;
  doc.fontSize(10);
  const options = { width: width - 12, lineGap: 4 };
  if (doc.heightOfString(note, options) > height - 12) throw new Error('NOTE_OVERFLOW');
  doc.fillColor(BLACK).text(note, x + 6, top + 6, options);
}

function drawFooter(doc: PDFKit.PDFDocument, batch: Batch, signatureBytes: Buffer | null): void {
  const footer = geometry.footer;
  const y = mm(footer.y);
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  const labels: Array<[string, number]> = [
    ['会计主管', footer.approverX],
    ['复核', footer.reviewerX],
    ['出纳', footer.cashierX],
    ['报销人', footer.signerX],
  ];
  for (const [label, labelX] of labels) {
    doc.fillColor(PRINTED_BLUE).text(label, mm(labelX), y, { lineBreak: false });
  }
  const signerX = mm(footer.signerX) + doc.widthOfString('报销人') + 6;
  const signerWidth = mm(geometry.page.width - geometry.page.margin) - signerX;
  if (batch.options.signerMode === 'text') {
    assertFits(doc, batch.options.signerName, signerWidth, 'FORM_TEXT_OVERFLOW');
    doc.fillColor(BLACK).text(batch.options.signerName, signerX, y, { width: signerWidth, lineBreak: false });
  } else if (signatureBytes !== null) {
    try {
      doc.image(signatureBytes, signerX, y - 2, { fit: [signerWidth, 14], align: 'center', valign: 'center' });
    } catch {
      throw new Error('SIGNATURE_INVALID');
    }
  }
}

function centered(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number): void {
  doc.text(text, x, y, { width, align: 'center', lineBreak: false });
}

function spread(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, fontSize: number): void {
  const chars = [...text];
  doc.fontSize(fontSize);
  chars.forEach((character, index) => {
    const center = x + (width * (index + 1)) / (chars.length + 1);
    const charWidth = doc.widthOfString(character);
    doc.text(character, center - charWidth / 2, y, { width: charWidth, lineBreak: false });
  });
}

function verticalText(doc: PDFKit.PDFDocument, text: string, x: number, top: number, height: number, step: number): void {
  const chars = [...text];
  const width = mm(geometry.table.columns.verticalLabel);
  const fontSize = 10;
  doc.fontSize(fontSize);
  const total = step * (chars.length - 1);
  const start = top + (height - total) / 2 - fontSize * 0.6;
  chars.forEach((character, index) => centered(doc, character, x, start + step * index, width));
}

function assertFits(doc: PDFKit.PDFDocument, text: string, width: number, code: 'FORM_TEXT_OVERFLOW'): void {
  if (text !== '' && doc.widthOfString(text) > width) throw new Error(code);
}
