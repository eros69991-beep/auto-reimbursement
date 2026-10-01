import { formatFen, receiptCaption, type Batch, type FormSheet, type ImageRef } from '@auto-reimbursement/contracts';
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

export function orderedAttachments(batch: Batch, sheet: FormSheet): Attachment[] {
  const sheetIndex = batch.sheets.findIndex((candidate) => candidate.id === sheet.id);
  if (sheetIndex < 0) {
    throw new Error('INVALID_BATCH');
  }
  return sheet.groups.flatMap((group) => group.receiptIds.flatMap((receiptId, index) => {
    const item = batch.items.find((snapshot) => snapshot.receiptId === receiptId);
    if (item === undefined) {
      throw new Error('INVALID_BATCH');
    }
    const caption = receiptCaption({
      sheetNumber: sheetIndex + 1,
      group,
      position: index + 1,
      count: group.receiptIds.length,
      netFen: item.netFen,
    });
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
  }));
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
  const labelHeight = mm(18);
  const textWidth = pageWidth - margin * 2;
  doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
  doc.font('NotoSansSC').fillColor('#000000');
  const [headline = '', ...details] = attachment.label.split('\n');
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
