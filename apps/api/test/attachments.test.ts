import type { ImageRef } from '@auto-reimbursement/contracts';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
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

// 页眉有几行说明，图片就从哪里开始：用一张又细又长的图（按高度缩放时顶边正好在页眉下沿）读出它的顶边。
async function drawWithTallPicture(label: string): Promise<{ imageTop: number; lastBaseline: number; baselines: number[] }> {
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const attachment: Attachment = { receiptId: 'r', image, kind: 'original', label };
  const png = await sharp({ create: { width: 20, height: 4000, channels: 3, background: '#888888' } }).png().toBuffer();
  drawAttachment(doc, attachment, png);
  doc.end();
  const pdf = await getDocument({ data: new Uint8Array(await done), useSystemFonts: false }).promise;
  const page = await pdf.getPage(1);
  const pageHeight = page.view[3]!;
  const operators = await page.getOperatorList();
  let imageTop = Number.NaN;
  operators.fnArray.forEach((fn, index) => {
    if (fn !== OPS.paintImageXObject) return;
    // 画图前最近的一次变换 [宽, 0, 0, -高, x, y]：PDFKit 的纵坐标向下，图片顶边 = y - 高
    let at = index - 1;
    while (at >= 0 && operators.fnArray[at] !== OPS.transform) at -= 1;
    const [, , , height, , y] = operators.argsArray[at] as number[];
    imageTop = y! + height!;
  });
  const content = await page.getTextContent();
  const baselines = content.items
    .flatMap((item) => ('str' in item && item.str.trim() !== '' ? [pageHeight - (item.transform as number[])[5]!] : []))
    .sort((left, right) => left - right);
  return { imageTop, lastBaseline: baselines.at(-1)!, baselines };
}

describe('attachment page header height', () => {
  it('keeps the picture where it has always been for the usual two-line header', async () => {
    const { imageTop, lastBaseline } = await drawWithTallPicture('第 1 张报销单 · 食材 第 1/1 张 · 本张 1.00 · 食材合计 1.00\n原始凭证');
    expect(imageTop).toBeCloseTo(12 * MM + 18 * MM, 1);
    expect(lastBaseline).toBeLessThan(imageTop);
  });

  it('moves the picture down to make room for a header with more lines', async () => {
    const label = [
      '第 2 张付款单 · 本张凭证 39561.63，含 5 项',
      '店面租金（2026年9月） 22814.10 · 物业费（2026年9月） 5069.80 · 水费（2026年7月） 48.86',
      '电费（2026年7月） 11466.87 · 空调能源费（2026年7月） 162.00',
      '原始凭证',
    ].join('\n');
    const { imageTop, lastBaseline, baselines } = await drawWithTallPicture(label);
    expect(baselines).toHaveLength(4);
    // 四行字都在图片上面，最后一行和图片之间还有空隙
    expect(imageTop - lastBaseline).toBeGreaterThan(3);
    // 比两行说明的页眉往下让了一些，但没有多让很多
    expect(imageTop).toBeGreaterThan(12 * MM + 18 * MM + 10);
    expect(imageTop).toBeLessThan(12 * MM + 18 * MM + 25);
  });

  it('writes every line of a long header inside the page margins', async () => {
    const items = rows(await drawOnePage([
      '第 2 张付款单 · 本张凭证 39561.63，含 5 项（本张单据上 5 项）',
      '店面租金（2026年9月） 22814.10 · 空调能源费（2026年7月） 99999999.99 · 其他公账支出（2026年12月） 99999999.99',
      '原始凭证',
    ].join('\n')));
    expect(items).toHaveLength(3);
    for (const row of items) {
      expect(row.left).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(row.right).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 0.5);
    }
  });
});
