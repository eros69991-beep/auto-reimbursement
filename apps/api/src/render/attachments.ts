import {
  formGroupLabel,
  formatFen,
  receiptCaption,
  type Batch,
  type FormGroup,
  type FormSheet,
  type ImageRef,
  type Snapshot,
} from '@auto-reimbursement/contracts';
import PDFDocument from 'pdfkit';

export type Attachment = {
  receiptId: string;
  image: ImageRef;
  kind: 'original' | 'refund';
  /**
   * 附件页页眉，用换行分成两行：
   * 第一行是对账说明（第几张报销单、分类里第几张、本张金额、分类合计，写法同网页对账区）；
   * 第二行写这页是原始凭证还是退款凭证，凭证带退款时再写明原实付、退款、实报。
   */
  label: string;
};

const mm = (value: number): number => (value * 72) / 25.4;

/** 一张凭证在一张单据上占的一行：哪一行、在这一行里排第几、这一行里一共几张、这一行里的金额 */
export interface SheetRow {
  group: FormGroup;
  position: number;
  count: number;
  fen: number;
}

/** 一行里写几项：「分类（月份）金额」三项一行，一行放不下就缩小字号（见 drawAttachment）。 */
const ROW_ITEMS_PER_LINE = 3;

/**
 * 公账区的多项凭证（收费通知单）在一张单据上的对账说明：第一行写第几张单据、这张凭证的合计和一共几项
 * （只有一部分项目排在这张单上时写明本单几项），后面几行列出排在这张单上的各项（分类、月份、金额）。
 */
export function linesCaption(sheetNumber: number, item: Pick<Snapshot, 'lines' | 'netFen'>, rows: SheetRow[]): string {
  const total = item.lines?.length ?? rows.length;
  const onThisSheet = rows.length < total ? `（本张单据上 ${rows.length} 项）` : '';
  const headline = `第 ${sheetNumber} 张报销单 · 本张凭证 ${formatFen(item.netFen)}，含 ${total} 项${onThisSheet}`;
  const items = rows.map((row) => `${formGroupLabel(row.group)} ${formatFen(row.fen)}`);
  const lines: string[] = [];
  for (let start = 0; start < items.length; start += ROW_ITEMS_PER_LINE) {
    lines.push(items.slice(start, start + ROW_ITEMS_PER_LINE).join(' · '));
  }
  return [headline, ...lines].join('\n');
}

/**
 * 一张单据后面要附的凭证页，按单据上出现的顺序排。一张凭证在这张单据上占了好几行（公账区的收费通知单
 * 拆成了几项）时，它的原图在这张单据后面只附一次，说明里写清它占了哪几行；店内的凭证一张一行，和以前一样。
 */
export function orderedAttachments(batch: Batch, sheet: FormSheet): Attachment[] {
  const sheetIndex = batch.sheets.findIndex((candidate) => candidate.id === sheet.id);
  if (sheetIndex < 0) {
    throw new Error('INVALID_BATCH');
  }
  const rowsByReceipt = new Map<string, SheetRow[]>();
  for (const group of sheet.groups) {
    group.receiptIds.forEach((receiptId, index) => {
      const rows = rowsByReceipt.get(receiptId) ?? [];
      rows.push({ group, position: index + 1, count: group.receiptIds.length, fen: group.amountsFen[index]! });
      rowsByReceipt.set(receiptId, rows);
    });
  }
  return [...rowsByReceipt].flatMap(([receiptId, rows]) => {
    const item = batch.items.find((snapshot) => snapshot.receiptId === receiptId);
    if (item === undefined) {
      throw new Error('INVALID_BATCH');
    }
    const first = rows[0]!;
    const caption = item.lines === undefined
      ? receiptCaption({
        sheetNumber: sheetIndex + 1,
        group: first.group,
        position: first.position,
        count: first.count,
        netFen: item.netFen,
      })
      : linesCaption(sheetIndex + 1, item, rows);
    const refundNote = item.refundFen > 0
      ? ` · 原实付 ${formatFen(item.paidFen)} / 退款 ${formatFen(item.refundFen)} / 实报 ${formatFen(item.netFen)}`
      : '';
    return [
      {
        receiptId,
        image: item.original,
        kind: 'original' as const,
        label: `${caption}\n原始凭证${refundNote}`,
      },
      ...item.refundImages.map((image) => ({
        receiptId,
        image,
        kind: 'refund' as const,
        label: `${caption}\n退款凭证${refundNote}`,
      })),
    ];
  });
}

/** 让一行字刚好放进给定宽度：放得下就用原字号，放不下按比例缩小（不小于最小字号）。 */
function fitFontSize(doc: PDFKit.PDFDocument, text: string, size: number, width: number, minimum: number): number {
  doc.fontSize(size);
  const needed = doc.widthOfString(text);
  return needed <= width ? size : Math.max(minimum, (size * width) / needed);
}

export function drawAttachment(
  doc: PDFKit.PDFDocument,
  attachment: Attachment,
  bytes: Buffer,
): void {
  const pageWidth = mm(210);
  const pageHeight = mm(297);
  const margin = mm(12);
  const textWidth = pageWidth - margin * 2;
  doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
  doc.font('NotoSansSC').fillColor('#000000');
  const [headline = '', ...details] = attachment.label.split('\n');
  // 页眉最多两行说明（店内一直是这样）时留 18mm；公账区的多项凭证说明行多，图片往下让
  const labelHeight = Math.max(mm(18), 19 + 15 * details.length + 2);
  // 第一行对账说明最长可能超过一行，缩小字号让它仍然一行放下，不折行也不超出页边
  const headlineSize = fitFontSize(doc, headline, 11, textWidth, 8);
  doc.fontSize(headlineSize).text(headline, margin, margin, { width: textWidth, lineBreak: false });
  let top = margin + 19;
  for (const detail of details) {
    const detailSize = fitFontSize(doc, detail, 10, textWidth, 8);
    doc.fontSize(detailSize).text(detail, margin, top, { width: textWidth, lineBreak: false });
    top += 15;
  }
  doc.image(bytes, margin, margin + labelHeight, {
    fit: [textWidth, pageHeight - margin * 2 - labelHeight],
    align: 'center',
    valign: 'center',
  });
}
