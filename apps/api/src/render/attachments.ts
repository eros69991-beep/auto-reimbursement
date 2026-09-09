import { formatFen, type Batch, type FormSheet, type ImageRef } from '@auto-reimbursement/contracts';
import PDFDocument from 'pdfkit';

export type Attachment = {
  receiptId: string;
  image: ImageRef;
  kind: 'original' | 'refund';
  label: string;
};

const mm = (value: number): number => (value * 72) / 25.4;

export function orderedAttachments(batch: Batch, sheet: FormSheet): Attachment[] {
  return sheet.groups.flatMap((group) => group.receiptIds.flatMap((receiptId) => {
    const item = batch.items.find((snapshot) => snapshot.receiptId === receiptId);
    if (item === undefined) {
      throw new Error('INVALID_BATCH');
    }
    const money = item.refundFen
      ? `原实付 ¥${formatFen(item.paidFen)} / 退款 ¥${formatFen(item.refundFen)} / 实报 ¥${formatFen(item.netFen)}`
      : `¥${formatFen(item.netFen)}`;
    return [
      {
        receiptId,
        image: item.original,
        kind: 'original' as const,
        label: `${group.category} · ${money} · 原始凭证`,
      },
      ...item.refundImages.map((image) => ({
        receiptId,
        image,
        kind: 'refund' as const,
        label: `${group.category} · ${money} · 退款凭证`,
      })),
    ];
  }));
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
  doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
  doc.font('NotoSansSC').fontSize(11).fillColor('#000000').text(attachment.label, margin, margin, {
    width: pageWidth - margin * 2,
    height: labelHeight,
    lineBreak: false,
  });
  doc.image(bytes, margin, margin + labelHeight, {
    fit: [pageWidth - margin * 2, pageHeight - margin * 2 - labelHeight],
    align: 'center',
    valign: 'center',
  });
}
