import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatFen, type Batch, type FormSheet } from '@auto-reimbursement/contracts';
import PDFDocument from 'pdfkit';

import { chineseUppercase } from '../uppercase.js';
import {
  groupHeight,
  wrapAmounts,
  type LayoutMetrics,
} from './layout.js';

interface Geometry {
  page: { width: number; height: number; margin: number };
  title: { y: number; underlineY: [number, number] };
  metadataY: number;
  table: {
    x: number;
    y: number;
    width: number;
    columns: { project: number; summary: number; amount: number; verticalLabel: number; notes: number };
    headerHeight: number;
    bodyHeight: number;
    totalHeight: number;
    uppercaseHeight: number;
    notesSplitY: number;
  };
  footerY: number;
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
    summaryWidth: mm(98) - 12,
    bodyHeight: mm(58),
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
  const headerBottom = y + mm(table.headerHeight);
  const bodyBottom = headerBottom + mm(table.bodyHeight);
  const totalBottom = bodyBottom + mm(table.totalHeight);
  const formBottom = totalBottom + mm(table.uppercaseHeight);
  const total = sheet.groups.reduce((sum, group) => sum + group.totalFen, 0);
  const digits = String(total).padStart(3, '0').padStart(9, ' ');
  if (digits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
  const uppercase = chineseUppercase(total);
  const note = batch.notes.find((item) => item.id === sheet.noteId)?.content ?? '';

  doc.addPage({ size: [mm(page.width), mm(page.height)], margin: 0 });
  doc.font('NotoSansSC').fontSize(10).fillColor(PRINTED_BLUE);
  drawTitle(doc, x, right);
  drawMetadata(doc, batch, sheet, x, right);
  drawStructure(doc, { x, y, projectX, summaryX, amountX, verticalLabelX, notesX, right, headerBottom, bodyBottom, totalBottom, formBottom });
  drawHeaders(doc, { projectX, summaryX, amountX, verticalLabelX, notesX, headerBottom, y });
  drawGroups(doc, sheet, metrics, { projectX, summaryX, amountX, headerBottom, bodyBottom });
  centered(doc, '合计', x, bodyBottom + 4, summaryX - x);
  drawAmountDigits(doc, digits, amountX, bodyBottom, mm(columns.amount), mm(table.totalHeight));
  drawUppercase(doc, uppercase, x, summaryX, notesX, totalBottom, formBottom);
  drawNote(doc, note, notesX, y, mm(columns.notes), mm(table.notesSplitY) - y);
  drawFooter(doc, batch, signatureBytes, x, right);
}

function drawTitle(doc: PDFKit.PDFDocument, left: number, right: number): void {
  const titleY = mm(geometry.title.y);
  doc.fontSize(16).fillColor(PRINTED_BLUE).text('费用报销单', left, titleY, {
    width: right - left,
    align: 'center',
    lineBreak: false,
  });
  doc.lineWidth(0.5).strokeColor(PRINTED_BLUE);
  for (const underlineY of geometry.title.underlineY) {
    doc.moveTo(mm(82), mm(underlineY)).lineTo(mm(188), mm(underlineY)).stroke();
  }
  doc.fontSize(10);
}

function drawMetadata(doc: PDFKit.PDFDocument, batch: Batch, sheet: FormSheet, left: number, right: number): void {
  const y = mm(geometry.metadataY);
  const date = batch.options.date ?? '';
  const fields: Array<[string, string, number, number]> = [
    ['报销部门：', batch.options.department, left, mm(76)],
    ['日期：', date, mm(110), mm(52)],
    ['单据及附件共', `${1 + sheetAttachmentCount(batch, sheet)} 页`, mm(183), right - mm(183)],
  ];
  for (const [label, value, x, width] of fields) {
    doc.fillColor(PRINTED_BLUE).text(label, x, y, { width, lineBreak: false });
    const labelWidth = doc.widthOfString(label);
    assertFits(doc, value, width - labelWidth, 'FORM_TEXT_OVERFLOW');
    doc.fillColor(BLACK).text(value, x + labelWidth, y, { width: width - labelWidth, lineBreak: false });
  }
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
  headerBottom: number;
  bodyBottom: number;
  totalBottom: number;
  formBottom: number;
}

function drawStructure(doc: PDFKit.PDFDocument, bounds: Bounds): void {
  const { x, y, projectX, summaryX, amountX, verticalLabelX, notesX, right, headerBottom, bodyBottom, totalBottom, formBottom } = bounds;
  doc.lineWidth(0.5).strokeColor(PRINTED_BLUE);
  for (const vertical of [x, summaryX, amountX, verticalLabelX, notesX, right]) {
    doc.moveTo(vertical, y).lineTo(vertical, formBottom).stroke();
  }
  for (const horizontal of [y, headerBottom, bodyBottom, totalBottom, formBottom]) {
    doc.moveTo(x, horizontal).lineTo(right, horizontal).stroke();
  }
  const notesSplit = mm(geometry.table.notesSplitY);
  doc.moveTo(notesX, notesSplit).lineTo(right, notesSplit).stroke();
  for (let row = 1; row <= 5; row += 1) {
    const rowY = headerBottom + (mm(geometry.table.bodyHeight) * row) / 6;
    doc.opacity(0.45).moveTo(projectX, rowY).lineTo(notesX, rowY).stroke().opacity(1);
  }
  const digitWidth = mm(geometry.table.columns.amount) / 9;
  for (let index = 1; index < 9; index += 1) {
    const digitX = amountX + digitWidth * index;
    doc.moveTo(digitX, y).lineTo(digitX, totalBottom).stroke();
  }
}

function drawHeaders(doc: PDFKit.PDFDocument, bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'verticalLabelX' | 'notesX' | 'headerBottom' | 'y'>): void {
  const { projectX, summaryX, amountX, verticalLabelX, notesX, headerBottom, y } = bounds;
  const headerHeight = mm(geometry.table.headerHeight);
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  centered(doc, '报销项目', projectX, y + 3, summaryX - projectX);
  centered(doc, '摘要', summaryX, y + 3, amountX - summaryX);
  centered(doc, '金额', amountX, y + 3, verticalLabelX - amountX);
  const labels = ['百', '十', '万', '千', '百', '十', '元', '角', '分'];
  const digitWidth = (verticalLabelX - amountX) / 9;
  labels.forEach((label, index) => centered(doc, label, amountX + digitWidth * index, y + headerHeight / 2, digitWidth));
  verticalText(doc, '备注', notesX - mm(geometry.table.columns.verticalLabel), y + 4, headerBottom - y - 8);
  verticalText(doc, '领导审批', notesX - mm(geometry.table.columns.verticalLabel), mm(geometry.table.notesSplitY) + 4, mm(geometry.table.totalHeight) + mm(geometry.table.bodyHeight) - (mm(geometry.table.notesSplitY) - headerBottom) - 8);
}

function drawGroups(
  doc: PDFKit.PDFDocument,
  sheet: FormSheet,
  metrics: LayoutMetrics,
  bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'headerBottom' | 'bodyBottom'>,
): void {
  let y = bounds.headerBottom;
  for (const group of sheet.groups) {
    const height = groupHeight(group, metrics);
    if (y + height > bounds.bodyBottom + 0.01) throw new Error('FORM_TEXT_OVERFLOW');
    const lines = wrapAmounts(group.amountsFen, metrics);
    if (lines.length * metrics.lineHeight > height - metrics.groupPadding + 0.01) throw new Error('FORM_TEXT_OVERFLOW');
    assertFits(doc, group.category, bounds.summaryX - bounds.projectX - 12, 'FORM_TEXT_OVERFLOW');
    doc.fillColor(BLACK).text(group.category, bounds.projectX + 6, y + 4, {
      width: bounds.summaryX - bounds.projectX - 12,
      lineBreak: false,
    });
    lines.forEach((line, index) => doc.text(line, bounds.summaryX + 6, y + 4 + index * metrics.lineHeight, {
      width: metrics.summaryWidth,
      lineBreak: false,
    }));
    const subtotalDigits = String(group.totalFen).padStart(3, '0').padStart(9, ' ');
    if (subtotalDigits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
    drawAmountDigits(doc, subtotalDigits, bounds.amountX, y, mm(geometry.table.columns.amount), height);
    doc.lineWidth(0.5).strokeColor(PRINTED_BLUE).moveTo(bounds.projectX, y + height).lineTo(bounds.amountX, y + height).stroke();
    y += height;
  }
}

function drawAmountDigits(doc: PDFKit.PDFDocument, digits: string, amountX: number, y: number, width: number, height: number): void {
  const cellWidth = width / 9;
  doc.fillColor(BLACK).fontSize(10);
  [...digits].forEach((digit, index) => {
    if (digit !== ' ') centered(doc, digit, amountX + index * cellWidth, y + 3, cellWidth);
  });
}

function drawUppercase(doc: PDFKit.PDFDocument, uppercase: string, left: number, summaryX: number, notesX: number, top: number, bottom: number): void {
  doc.fillColor(PRINTED_BLUE);
  doc.fontSize(8);
  centered(doc, '金额\n(大写)', left, top + 2, summaryX - left);
  doc.fontSize(10).text('大写：', summaryX + 6, top + 3, { width: 32, lineBreak: false });
  doc.fillColor(BLACK).text(uppercase, summaryX + 38, top + 3, { width: notesX - summaryX - 44, lineBreak: false });
  doc.fillColor(PRINTED_BLUE).text('原借款：', notesX + 6, top + 3, { width: 64, lineBreak: false });
  doc.text('应退（补）款：', notesX + 72, top + 3, { width: 88, lineBreak: false });
}

function drawNote(doc: PDFKit.PDFDocument, note: string, x: number, top: number, width: number, height: number): void {
  if (note === '') return;
  const options = { width: width - 12, lineGap: 4 };
  if (doc.heightOfString(note, options) > height - 12) throw new Error('NOTE_OVERFLOW');
  doc.fillColor(BLACK).text(note, x + 6, top + 6, options);
}

function drawFooter(doc: PDFKit.PDFDocument, batch: Batch, signatureBytes: Buffer | null, left: number, right: number): void {
  const y = mm(geometry.footerY);
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  const labels: Array<[string, number, number]> = [
    ['会计主管：', left, mm(55)],
    ['复核：', mm(78), mm(40)],
    ['出纳：', mm(150), mm(40)],
    ['报销人：', mm(208), right - mm(208)],
  ];
  for (const [label, x, width] of labels) {
    doc.fillColor(PRINTED_BLUE).text(label, x, y, { width, lineBreak: false });
  }
  const signerX = mm(208) + doc.widthOfString('报销人：');
  const signerWidth = right - mm(208) - doc.widthOfString('报销人：');
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

function verticalText(doc: PDFKit.PDFDocument, text: string, x: number, y: number, height: number): void {
  const chars = [...text];
  const step = Math.min(13, height / Math.max(chars.length, 1));
  chars.forEach((character, index) => centered(doc, character, x, y + step * index, mm(geometry.table.columns.verticalLabel)));
}

function assertFits(doc: PDFKit.PDFDocument, text: string, width: number, code: 'FORM_TEXT_OVERFLOW'): void {
  if (text !== '' && doc.widthOfString(text) > width) throw new Error(code);
}
