import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formGroupLabel, ledgerOf, type Batch, type FormSheet, type Payee } from '@auto-reimbursement/contracts';
import PDFDocument from 'pdfkit';

import {
  mergedRowBoundaries,
  placeGroups,
  type GroupPlacement,
  type LayoutMetrics,
} from './layout.js';
import { toUppercaseCells } from '../uppercase.js';

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
    underlineOffset: number;
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

/**
 * 单据上印的几处字：店内是「费用报销单」，公账区是「公账付款单」。
 * 每组字的字数一样（标题 5 个、「报销部门：」5 个、「报销项目」4 个、「报销人」3 个），版式不用动。
 */
export interface FormWords {
  title: string;
  department: string;
  project: string;
  signer: string;
}

const STORE_WORDS: FormWords = { title: '费用报销单', department: '报销部门：', project: '报销项目', signer: '报销人' };
const COMPANY_WORDS: FormWords = { title: '公账付款单', department: '付款单位：', project: '付款项目', signer: '经办人' };

export function formWords(batch: Pick<Batch, 'ledger'>): FormWords {
  return ledgerOf(batch) === 'company' ? COMPANY_WORDS : STORE_WORDS;
}

export function createFormDocument(): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: [mm(geometry.page.width), mm(geometry.page.height)],
    margin: 0,
    // 固定 CreationDate 使 PDFKit 的文档 ID 恒定，同一数据连续生成的 PDF 字节一致（幂等）。
    info: { CreationDate: new Date(0) },
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
    // 摘要栏折行用 10pt；绘制过程中字号会变，所以每次量之前都重新设定
    measure: (text) => {
      doc.font('NotoSansSC').fontSize(10);
      return doc.widthOfString(text);
    },
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
  // 旧版式生成的草稿在新版式下放不下时，这里抛 LAYOUT_OUTDATED（提示撤销后重新生成）
  const placements = placeGroups(sheet.groups, metrics);
  const total = sheet.groups.reduce((sum, group) => sum + group.totalFen, 0);
  const digits = String(total).padStart(3, '0').padStart(9, ' ');
  if (digits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
  const words = formWords(batch);
  const company = ledgerOf(batch) === 'company';
  const noteContent = batch.notes.find((item) => item.id === sheet.noteId)?.content ?? '';
  // 公账付款单的备注栏先写这张单上的收款方（户名、开户银行、银行账号），再写所选的备注。
  // 内容多：字号从 10pt 逐级缩小，最小 6.5pt 还放不下的才接到备注续页，续页按行断开（账号不会被拆开）。
  // 店内只有所选的备注，一直是 10pt。
  const notePages = layoutNote(
    doc,
    company ? companyNoteTexts(sheetPayees(batch, sheet), noteContent) : [noteContent],
    mm(columns.notes) - 12,
    notesSplit - y - 12,
    mm(page.width - page.margin * 2),
    mm(page.height - page.margin * 2 - 12),
    company ? COMPANY_NOTE_STYLES : [STORE_NOTE_STYLE],
    company,
  );

  doc.addPage({ size: [mm(page.width), mm(page.height)], margin: 0 });
  doc.font('NotoSansSC').fontSize(10).fillColor(PRINTED_BLUE);
  drawTitle(doc, words.title);
  drawMetadata(doc, batch, sheet, notePages.continuation.length, words);
  drawStructure(
    doc,
    { x, y, projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, bodyBottom, totalBottom, formBottom, notesSplit },
    mergedRowBoundaries(placements),
  );
  drawHeaders(doc, { projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, y, notesSplit, totalBottom }, words);
  drawGroups(doc, placements, { projectX, summaryX, amountX, verticalLabelX, headerBottom, bodyBottom });
  drawTotal(doc, digits, x, amountX, bodyBottom, mm(columns.amount), mm(table.totalHeight));
  drawUppercase(doc, digits, x, right, totalBottom, formBottom);
  drawNote(doc, notePages.firstPage, notesX, y, mm(columns.notes), notesSplit - y, notePages.style);
  drawFooter(doc, batch, signatureBytes, words);
  drawNoteContinuationPages(doc, notePages.continuation);
}

function drawTitle(doc: PDFKit.PDFDocument, text: string): void {
  const title = geometry.title;
  doc.fontSize(title.fontSize).fillColor(PRINTED_BLUE);
  [...text].forEach((character, index) => {
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

function drawMetadata(
  doc: PDFKit.PDFDocument,
  batch: Batch,
  sheet: FormSheet,
  continuationPages: number,
  words: FormWords,
): void {
  const meta = geometry.metadata;
  const y = mm(meta.y);
  const date = batch.options.date;
  let dateText = '年　月　日';
  if (date !== null) {
    const [year, month, day] = date.split('-');
    dateText = `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  doc.text(words.department, mm(meta.departmentX), y, { lineBreak: false });
  const departmentX = mm(meta.departmentX) + doc.widthOfString(words.department);
  const departmentWidth = mm(meta.dateCenterX - meta.dateWidth / 2) - departmentX - 4;
  const departmentHeight = mm(geometry.table.y) - y;
  doc.fillColor(BLACK);
  drawFittedText(doc, batch.options.department, departmentX, y, departmentWidth, departmentHeight, 'FORM_TEXT_OVERFLOW');

  doc.fillColor(BLACK).fontSize(10).text(dateText, mm(meta.dateCenterX - meta.dateWidth / 2), y, {
    width: mm(meta.dateWidth),
    align: 'center',
    lineBreak: false,
  });

  doc.fillColor(PRINTED_BLUE).text('单据及附件共', mm(meta.attachmentsX), y, { lineBreak: false });
  const count = String(1 + continuationPages + sheetAttachmentCount(batch, sheet));
  const [lineStart, lineEnd] = meta.attachmentsLine;
  doc.fillColor(BLACK).text(count, mm(lineStart), y, { width: mm(lineEnd - lineStart), align: 'center', lineBreak: false });
  doc.fillColor(PRINTED_BLUE).text('页', mm(meta.pageLabelX), y, { lineBreak: false });
  doc.lineWidth(0.5).strokeColor(BLACK)
    .moveTo(mm(lineStart), y + meta.underlineOffset)
    .lineTo(mm(lineEnd), y + meta.underlineOffset)
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

function drawStructure(doc: PDFKit.PDFDocument, bounds: Bounds, mergedBoundaries: ReadonlySet<number>): void {
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
  doc.moveTo(amountX, headerSplit).lineTo(notesX, headerSplit).stroke();
  doc.moveTo(x, headerBottom).lineTo(verticalLabelX, headerBottom).stroke();
  // 表体 5 行线。分类占多行时，它内部的线只留在摘要栏（每行一排金额），
  // 「报销项目」「金额」两栏不画，像合并单元格。
  const rows = geometry.table.bodyRows;
  for (let row = 1; row < rows; row += 1) {
    const rowY = headerBottom + (mm(geometry.table.bodyHeight) * row) / rows;
    if (mergedBoundaries.has(row)) doc.moveTo(summaryX, rowY).lineTo(amountX, rowY).stroke();
    else doc.moveTo(projectX, rowY).lineTo(verticalLabelX, rowY).stroke();
  }
  doc.moveTo(x, bodyBottom).lineTo(verticalLabelX, bodyBottom).stroke();
  doc.moveTo(verticalLabelX, notesSplit).lineTo(right, notesSplit).stroke();
  doc.moveTo(x, totalBottom).lineTo(right, totalBottom).stroke();
  doc.moveTo(x, formBottom).lineTo(right, formBottom).stroke();

  // Uppercase strip divider between the two loan cells.
  doc.moveTo(mm(geometry.uppercaseStrip.loanEnd), totalBottom).lineTo(mm(geometry.uppercaseStrip.loanEnd), formBottom).stroke();
}

function drawHeaders(
  doc: PDFKit.PDFDocument,
  bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'verticalLabelX' | 'notesX' | 'right' | 'headerSplit' | 'headerBottom' | 'y' | 'notesSplit' | 'totalBottom'>,
  words: FormWords,
): void {
  const { projectX, summaryX, amountX, verticalLabelX, notesX, right, headerSplit, headerBottom, y, notesSplit, totalBottom } = bounds;
  doc.fillColor(PRINTED_BLUE);
  spread(doc, words.project, projectX, y + mm(5.2), summaryX - projectX, 12);
  spread(doc, '摘要', summaryX, y + mm(5.2), amountX - summaryX, 12);
  spread(doc, '金额', amountX, y + mm(1.8), verticalLabelX - amountX, 11);
  const labels = ['百', '十', '万', '千', '百', '十', '元', '角', '分'];
  const digitWidth = (verticalLabelX - amountX) / 9;
  doc.fontSize(9);
  labels.forEach((label, index) => centered(doc, label, amountX + digitWidth * index, headerSplit + mm(1.3), digitWidth));
  verticalText(doc, '备注', verticalLabelX, headerBottom, notesSplit - headerBottom, mm(6));
  verticalText(doc, '领导审批', verticalLabelX, notesSplit, totalBottom - notesSplit, mm(7.4));
}

function drawGroups(
  doc: PDFKit.PDFDocument,
  placements: GroupPlacement[],
  bounds: Pick<Bounds, 'projectX' | 'summaryX' | 'amountX' | 'verticalLabelX' | 'headerBottom' | 'bodyBottom'>,
): void {
  const rowHeight = (bounds.bodyBottom - bounds.headerBottom) / geometry.table.bodyRows;
  const projectWidth = bounds.summaryX - bounds.projectX - 12;
  for (const { group, startRow, rowCount, lines } of placements) {
    // 每个分类占 rowCount 行：摘要栏每行写一排实报金额（上传顺序、空格隔开），
    // 分类名和金额栏的分类合计（被拆到多张时是这一部分的小计）在这几行里上下居中、只写一次。
    const top = bounds.headerBottom + startRow * rowHeight;
    const height = rowCount * rowHeight;
    if (top + height > bounds.bodyBottom + 0.01) throw new Error('FORM_TEXT_OVERFLOW');
    const textY = centeredTextTop(doc, top, height);
    const label = formGroupLabel(group);
    // 项目栏不宽，公账区的项目名还带月份（「空调能源费（2026年7月）（续）」）：10pt 放不下就逐级缩小。
    // 金额栏的数字固定 10pt，仍按 10pt 的行高居中（textY）。
    const labelSize = fitLabelSize(doc, label, projectWidth);
    const labelY = labelSize === 10 ? textY : centeredTextTop(doc, top, height, labelSize);
    doc.fontSize(labelSize);
    doc.fillColor(BLACK).text(label, bounds.projectX + 6, labelY, { width: projectWidth, lineBreak: false });
    lines.forEach((line, index) => {
      const lineY = centeredTextTop(doc, top + index * rowHeight, rowHeight);
      doc.fontSize(10).fillColor(BLACK).text(line, bounds.summaryX + 6, lineY, { lineBreak: false });
    });
    const digits = String(group.totalFen).padStart(3, '0').padStart(9, ' ');
    if (digits.length > 9) throw new Error('FORM_AMOUNT_OVERFLOW');
    drawAmountDigits(doc, digits, bounds.amountX, textY - 3, mm(geometry.table.columns.amount), 14);
  }
}

// 一行文字（默认 10pt）在 height 高的格子里上下居中时，文字框顶边的纵坐标。
// 按字体的行框（上升 + 下降，10pt 约 14.5pt）居中，和备注栏的居中方式一致，
// 字形的视觉中心与格子中心相差不到 1pt。
function centeredTextTop(doc: PDFKit.PDFDocument, top: number, height: number, size = 10): number {
  doc.font('NotoSansSC').fontSize(size);
  return top + (height - doc.currentLineHeight(true)) / 2;
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
  // 大写金额栏按财务惯例逐格填中文大写数字（零壹贰叁…），首位之前留空（P-06）。
  doc.fillColor(BLACK).fontSize(10);
  [...toUppercaseCells(digits)].forEach((digit, index) => {
    if (digit !== ' ') centered(doc, digit, unitsStart + index * cellWidth, top + mm(6.8), cellWidth);
  });

  doc.fillColor(PRINTED_BLUE).fontSize(9);
  const loanStart = left + mm(geometry.table.columns.project + geometry.table.columns.summary);
  drawLoanField(doc, '原借款：', loanStart, loanEnd, top);
  drawLoanField(doc, '应退(补)款：', loanEnd, right, top);
  doc.fontSize(10);
}

function drawLoanField(doc: PDFKit.PDFDocument, label: string, start: number, end: number, top: number): void {
  const y = top + mm(2.4);
  doc.text(label, start + mm(1.6), y, { width: end - start - mm(3.2), lineBreak: false });
  const yuanWidth = doc.widthOfString('元');
  doc.text('元', end - yuanWidth - mm(1.6), y, { width: yuanWidth, lineBreak: false });
}

/** 备注栏里字的大小和行距（pt）。 */
export interface NoteStyle {
  size: number;
  gap: number;
}

export interface NoteLayout {
  /** 备注栏里写的字：放不下时是放得下的前一部分加「（接续页）」 */
  firstPage: string;
  /** 备注栏里用的字号和行距 */
  style: NoteStyle;
  /** 接到备注续页上的内容，每页一段（续页一直是 10pt） */
  continuation: string[];
}

const NOTE_LINE_GAP = 4;
// 店内的备注一直是 10pt
export const STORE_NOTE_STYLE: NoteStyle = { size: 10, gap: NOTE_LINE_GAP };
// 公账付款单的备注栏装收款方信息，内容多：从 10pt 起逐级缩小，行距跟着缩
export const COMPANY_NOTE_STYLES: readonly NoteStyle[] = [
  STORE_NOTE_STYLE,
  { size: 9, gap: 3.5 },
  { size: 8, gap: 3 },
  { size: 7, gap: 2.5 },
  { size: 6.5, gap: 2 },
];

// 备注按换行拆成段；末尾的一个换行不多占一行（与 PDFKit 整段量高的结果一致）。
function noteParagraphs(note: string): string[] {
  const paragraphs = note.split('\n');
  if (paragraphs.length > 1 && paragraphs.at(-1) === '') paragraphs.pop();
  return paragraphs;
}

// 逐段量高，空段算一行。和 PDFKit 对整段文字量出的高度相同，
// 但可以配合下面「逐段居中」绘制（见 drawNote）。
function noteHeight(doc: PDFKit.PDFDocument, note: string, width: number, style: NoteStyle): number {
  if (note === '') return 0;
  doc.font('NotoSansSC').fontSize(style.size);
  const emptyLine = doc.currentLineHeight(true) + style.gap;
  return noteParagraphs(note).reduce(
    (sum, paragraph) => sum + (paragraph === '' ? emptyLine : doc.heightOfString(paragraph, { width, lineGap: style.gap })),
    0,
  );
}

// 断口两边紧挨着的换行符一共几个：0 = 断口在一行中间；1 = 在一行的末尾或开头；2 个以上 = 在两段（两家收款方）之间的空行上。
function newlinesAround(text: string, length: number): number {
  let count = 0;
  for (let index = length - 1; index >= 0 && text[index] === '\n'; index -= 1) count += 1;
  for (let index = length; index < text.length && text[index] === '\n'; index += 1) count += 1;
  return count;
}

// 把一段文字在 length 处断开时，让断口落在行边界上：
// - 断口正好在两家收款方之间（空行上）：就断在这里；
// - 断口落在一家的中间：退到断口之前最近的空行（一家收款方的几行不拆开）；
// - 一个空行都没有：断在最近的行边界上（这一行整行留给下一页）；
// - 一个换行都没有（第一行就放不下）：才照旧按字断。
// 公账付款单的备注是一行一项的收款方信息，断在行中间会把银行账号拆到两页上。
export function snapToLine(text: string, length: number): number {
  if (length <= 0 || length >= text.length) return length;
  const around = newlinesAround(text, length);
  if (around >= 2) return length;
  const blank = text.lastIndexOf('\n\n', length - 2);
  if (blank >= 0) return blank + 2;
  if (around >= 1) return length;
  const boundary = text.lastIndexOf('\n', length - 1);
  return boundary < 0 ? length : boundary + 1;
}

// 备注栏怎么放：candidates 是同一份内容的几种写法（越靠前越舒展，最后一种最紧凑），styles 是字号从大到小；
// 先按字号从大到小找，同一个字号里按舒展到紧凑找，第一个整段放得下的就用它。
// 都放不下时不报错：第一页用最小的字号、最舒展的写法放得下的前缀并标注「（接续页）」，剩余内容分页画到续页。
// byLine 为真时断口落在行边界上（见 snapToLine）；店内按字断，和以前一样。
export function layoutNote(
  doc: PDFKit.PDFDocument,
  candidates: readonly string[],
  firstWidth: number,
  firstHeight: number,
  continuationWidth: number,
  continuationHeight: number,
  styles: readonly NoteStyle[],
  byLine: boolean,
): NoteLayout {
  // 放不下要分页时，按最舒展的写法分（各家之间有空行，断口优先落在空行上）
  const note = candidates[0]!;
  if (note === '') return { firstPage: '', style: styles[0]!, continuation: [] };
  for (const style of styles) {
    for (const candidate of candidates) {
      if (noteHeight(doc, candidate, firstWidth, style) <= firstHeight) {
        return { firstPage: candidate, style, continuation: [] };
      }
    }
  }
  const style = styles.at(-1)!;
  const suffix = '（接续页）';
  // 按行断开时，断口两边的空行不留（空行只出现在各家之间，不出现在一页的开头和末尾）
  const trimEnds = (part: string): string => (byLine ? part.replace(/^\n+|\n+$/g, '') : part);
  const fitPrefix = (text: string, width: number, height: number, textStyle: NoteStyle): number => {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (noteHeight(doc, text.slice(0, mid), width, textStyle) <= height) low = mid;
      else high = mid - 1;
    }
    return byLine ? snapToLine(text, low) : low;
  };
  const prefixLength = fitPrefix(note, firstWidth, firstHeight - noteHeight(doc, suffix, firstWidth, style) - 4, style);
  const head = trimEnds(note.slice(0, prefixLength));
  // 按行断开时「（接续页）」另起一行；按字断（店内）时紧接在最后一个字后面，和以前一样
  const firstPage = byLine && head !== '' ? `${head}\n${suffix}` : `${head}${suffix}`;
  let rest = byLine ? note.slice(prefixLength).replace(/^\n+/, '') : note.slice(prefixLength);
  const continuation: string[] = [];
  while (rest.length > 0) {
    const take = fitPrefix(rest, continuationWidth, continuationHeight, STORE_NOTE_STYLE);
    if (take === 0) throw new Error('NOTE_OVERFLOW');
    continuation.push(trimEnds(rest.slice(0, take)));
    rest = byLine ? rest.slice(take).replace(/^\n+/, '') : rest.slice(take);
  }
  return { firstPage, style, continuation };
}

// 备注在格子里水平、垂直居中（试点反馈）。放不下的部分已由 layoutNote 挪到接续页，
// 这里只会收到放得下的内容；超出仍抛 NOTE_OVERFLOW，不悄悄画出格子。
// PDFKit 居中时会把行尾换行符的宽度也算进去，显式换行的那几行会偏左半个字，
// 所以按段落逐段居中绘制（自动折行的行不受影响）。
function drawNote(
  doc: PDFKit.PDFDocument,
  note: string,
  x: number,
  top: number,
  width: number,
  height: number,
  style: NoteStyle,
): void {
  if (note === '') return;
  doc.font('NotoSansSC').fontSize(style.size);
  const textWidth = width - 12;
  const total = noteHeight(doc, note, textWidth, style);
  if (total > height - 12 + 0.01) throw new Error('NOTE_OVERFLOW');
  const emptyLine = doc.currentLineHeight(true) + style.gap;
  // 量出的高度在末行之后还带着一个行距，居中要按看得见的高度算
  let y = top + (height - (total - style.gap)) / 2;
  doc.fillColor(BLACK);
  for (const paragraph of noteParagraphs(note)) {
    if (paragraph === '') {
      y += emptyLine;
      continue;
    }
    const options = { width: textWidth, lineGap: style.gap, align: 'center' as const };
    doc.text(paragraph, x + 6, y, options);
    y += doc.heightOfString(paragraph, options);
  }
}

// ---- 公账付款单的备注栏：收款方 ----

/** 一张单上用到的收款方：按在单上出现的先后，户名、开户银行、银行账号三项都一样的只写一次。 */
function sheetPayees(batch: Batch, sheet: FormSheet): Payee[] {
  const payees: Payee[] = [];
  const seen = new Set<string>();
  for (const group of sheet.groups) {
    for (const receiptId of group.receiptIds) {
      const payee = batch.items.find((item) => item.receiptId === receiptId)?.payee;
      if (payee === undefined) continue;
      const key = JSON.stringify([payee.name ?? '', payee.bank ?? '', payee.account ?? '']);
      if (seen.has(key)) continue;
      seen.add(key);
      payees.push(payee);
    }
  }
  return payees;
}

// 没有的项不写；银行账号原样写，不加空格分组（要和回单上的、网银里的对得上）
function payeeLines(payee: Payee): string[] {
  return [
    ...(payee.name === undefined ? [] : [`收款户名：${payee.name}`]),
    ...(payee.bank === undefined ? [] : [`开户银行：${payee.bank}`]),
    ...(payee.account === undefined ? [] : [`银行账号：${payee.account}`]),
  ];
}

// 先写各收款方，再空一行写所选的备注。收款方不止一个时，优先在各收款方之间也空一行（看得出哪几行是一家），
// 放不下再挤紧（只靠每家的第一行「收款户名」分开）。
function companyNoteTexts(payees: Payee[], note: string): string[] {
  const text = (between: string): string =>
    [payees.map((payee) => payeeLines(payee).join('\n')).join(between), note].filter((part) => part !== '').join('\n\n');
  return [...new Set([text('\n\n'), text('\n')])];
}

function drawNoteContinuationPages(doc: PDFKit.PDFDocument, pages: string[]): void {
  const page = geometry.page;
  for (const text of pages) {
    doc.addPage({ size: [mm(page.width), mm(page.height)], margin: 0 });
    doc.font('NotoSansSC').fontSize(12).fillColor(PRINTED_BLUE);
    const title = '备注续页';
    const titleWidth = doc.widthOfString(title);
    doc.text(title, (mm(page.width) - titleWidth) / 2, mm(page.margin), { width: titleWidth, lineBreak: false });
    doc.fillColor(BLACK).fontSize(10).text(text, mm(page.margin), mm(page.margin) + mm(8), {
      width: mm(page.width - page.margin * 2),
      lineGap: 4,
    });
  }
}

function drawFooter(doc: PDFKit.PDFDocument, batch: Batch, signatureBytes: Buffer | null, words: FormWords): void {
  const footer = geometry.footer;
  const y = mm(footer.y);
  doc.fillColor(PRINTED_BLUE).fontSize(10);
  const labels: Array<[string, number]> = [
    ['会计主管', footer.approverX],
    ['复核', footer.reviewerX],
    ['出纳', footer.cashierX],
    [words.signer, footer.signerX],
  ];
  for (const [label, labelX] of labels) {
    doc.fillColor(PRINTED_BLUE).text(label, mm(labelX), y, { lineBreak: false });
  }
  const signerX = mm(footer.signerX) + doc.widthOfString(words.signer) + 6;
  const signerWidth = mm(geometry.page.width - geometry.page.margin) - signerX;
  if (batch.options.signerMode === 'text') {
    doc.fillColor(BLACK);
    drawFittedText(doc, batch.options.signerName, signerX, y, signerWidth, 14, 'FORM_TEXT_OVERFLOW');
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

// 项目栏的字号：10pt 起逐级缩小，第一个放得下的；最小 6.5pt 还放不下才报错。
const LABEL_FONT_SIZES = [10, 9, 8, 7, 6.5];

function fitLabelSize(doc: PDFKit.PDFDocument, label: string, width: number): number {
  if (label === '') return 10;
  for (const size of LABEL_FONT_SIZES) {
    doc.font('NotoSansSC').fontSize(size);
    if (doc.widthOfString(label) <= width) return size;
  }
  throw new Error('FORM_TEXT_OVERFLOW');
}

// 长文本自适应：10→7pt 逐级缩字号单行放下；仍超宽则用 7pt 在 maxHeight 内换行；再超才抛错。
function drawFittedText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  maxHeight: number,
  code: 'FORM_TEXT_OVERFLOW',
): void {
  if (text === '') return;
  for (const size of [10, 9, 8, 7]) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= width) {
      doc.text(text, x, y, { width, lineBreak: false });
      return;
    }
  }
  doc.fontSize(7);
  if (doc.heightOfString(text, { width }) <= maxHeight) {
    doc.text(text, x, y, { width });
    return;
  }
  throw new Error(code);
}
