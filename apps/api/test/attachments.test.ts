import type { ImageRef } from '@auto-reimbursement/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { drawAttachment, type Attachment } from '../src/render/attachments.js';
import { createFormDocument } from '../src/render/form.js';

const MM = 72 / 25.4;
const PAGE_WIDTH = 210 * MM;
const MARGIN = 12 * MM;

const image: ImageRef = {
  id: 'image',
  path: '2026-09/originals/image.png',
  mime: 'image/png',
  sha256: '0'.repeat(64),
  perceptualHash: '0000000000000000',
  bytes: 100,
  width: 20,
  height: 20,
  deletedAt: null,
};

type Item = { str: string; x: number; baseline: number; width: number };

async function drawOnePage(label: string): Promise<Item[]> {
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const attachment: Attachment = { receiptId: 'r', image, kind: 'original', label };
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#888888' } }).png().toBuffer();
  drawAttachment(doc, attachment, png);
  doc.end();

  const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
  expect(pdf.numPages).toBe(1);
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.flatMap((item) => {
    if (!('str' in item) || item.str.trim() === '') return [];
    const [, , , , x, baseline] = item.transform as number[];
    return [{ str: item.str, x: x!, baseline: baseline!, width: item.width }];
  });
}

function rows(items: Item[]): Array<{ text: string; left: number; right: number; baseline: number }> {
  const byBaseline = new Map<number, Item[]>();
  for (const item of items) {
    const key = Math.round(item.baseline);
    byBaseline.set(key, [...(byBaseline.get(key) ?? []), item]);
  }
  return [...byBaseline.values()]
    .map((row) => ({
      text: row.map((item) => item.str).join('').replace(/\s+/g, ''),
      left: Math.min(...row.map((item) => item.x)),
      right: Math.max(...row.map((item) => item.x + item.width)),
      baseline: row[0]!.baseline,
    }))
    .sort((left, right) => right.baseline - left.baseline); // PDF 纵坐标向上：先出现的在页面上方
}

describe('attachment page header', () => {
  it('writes the reconcile caption on the first line and the kind of voucher on the second', async () => {
    const [first, second, ...rest] = rows(await drawOnePage(
      '第 1 张报销单 · 食材 第 2/3 张 · 本张 19.88 · 食材合计 741.48\n原始凭证',
    ));

    expect(rest).toHaveLength(0);
    expect(first!.text).toBe('第1张报销单·食材第2/3张·本张19.88·食材合计741.48');
    expect(second!.text).toBe('原始凭证');
    expect(first!.baseline).toBeGreaterThan(second!.baseline + 10);
    // 页眉从左页边起写，图片区在它下面
    expect(first!.left).toBeCloseTo(MARGIN, 0);
    expect(second!.left).toBeCloseTo(MARGIN, 0);
  });

  it('shrinks a very long caption to stay on one line inside the page margins', async () => {
    const longest = '第 12 张报销单 · 租金及管理费（续） 第 100/100 张 · 本张 99999.99 · 租金及管理费（续）合计 9999999.99';
    const [first, second, ...rest] = rows(await drawOnePage(
      `${longest}\n退款凭证 · 原实付 99999.99 / 退款 99999.98 / 实报 0.01`,
    ));

    expect(rest).toHaveLength(0);
    expect(first!.text).toBe(longest.replace(/\s+/g, ''));
    expect(second!.text).toBe('退款凭证·原实付99999.99/退款99999.98/实报0.01');
    for (const row of [first!, second!]) {
      expect(row.left).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(row.right).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 0.5);
    }
  });
});
