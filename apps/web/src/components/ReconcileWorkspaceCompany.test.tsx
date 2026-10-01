import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchBlobUrl } from '../api';

import type { Batch, FormGroup, ImageRef, Snapshot } from '@auto-reimbursement/contracts';

vi.mock('../api', () => ({
  api: {
    receiptOriginalUrl: (id: string) => `http://api.test/original/${id}`,
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
}));

vi.mock('./PdfPreview', () => ({
  PdfPreview: ({ url, ledger }: { url: string; ledger?: string }) => <div data-testid="pdf-preview" data-url={url} data-ledger={ledger ?? 'store'} />,
}));

import { ReconcileWorkspace } from './ReconcileWorkspace';

const image: ImageRef = {
  id: 'img-1',
  path: '2026-09/originals/img-1.png',
  mime: 'image/png',
  sha256: '0'.repeat(64),
  perceptualHash: '0000000000000000',
  bytes: 100,
  width: 10,
  height: 10,
  deletedAt: null,
};

const MEAT_PAYEE = { name: '示例食品销售有限公司', bank: '示例银行上海分行', account: '1234567890123456789' };
const NOTICE_PAYEE = { name: '示例商管公司', bank: '示例银行武汉分行', account: '9876543210987654321' };

const meatItem: Snapshot = {
  receiptId: 'meat',
  uploadOrder: 1,
  category: '肉款',
  paidFen: 1_290_949,
  refundFen: 0,
  netFen: 1_290_949,
  original: { ...image, id: 'img-meat' },
  refundImages: [],
  payee: MEAT_PAYEE,
};

const noticeItem: Snapshot = {
  receiptId: 'notice',
  uploadOrder: 2,
  category: '店面租金',
  paidFen: 3_956_163,
  refundFen: 0,
  netFen: 3_956_163,
  original: { ...image, id: 'img-notice' },
  refundImages: [],
  lines: [
    { category: '店面租金', fen: 2_281_410, period: '2026-09' },
    { category: '物业费', fen: 506_980, period: '2026-09' },
    { category: '水费', fen: 4_886, period: '2026-07' },
    { category: '电费', fen: 1_146_687, period: '2026-07' },
    { category: '空调能源费', fen: 16_200, period: '2026-07' },
  ],
  payee: NOTICE_PAYEE,
};

const meatGroup: FormGroup = { category: '肉款', receiptIds: ['meat'], amountsFen: [1_290_949], totalFen: 1_290_949 };
const rentGroup: FormGroup = { category: '店面租金', period: '2026-09', receiptIds: ['notice'], amountsFen: [2_281_410], totalFen: 2_281_410 };
const propertyGroup: FormGroup = { category: '物业费', period: '2026-09', receiptIds: ['notice'], amountsFen: [506_980], totalFen: 506_980 };
const waterGroup: FormGroup = { category: '水费', period: '2026-07', receiptIds: ['notice'], amountsFen: [4_886], totalFen: 4_886 };
const electricGroup: FormGroup = { category: '电费', period: '2026-07', receiptIds: ['notice'], amountsFen: [1_146_687], totalFen: 1_146_687 };
const airGroup: FormGroup = { category: '空调能源费', period: '2026-07', receiptIds: ['notice'], amountsFen: [16_200], totalFen: 16_200 };

/** 一张回单加一张收费通知单，通知单的五项都在同一张付款单上 */
function oneSheetBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 5_247_112,
    ledger: 'company',
    items: [meatItem, noticeItem],
    sheets: [{ id: 'sheet-1', noteId: null, groups: [meatGroup, rentGroup, propertyGroup, waterGroup, electricGroup, airGroup] }],
    options: { department: '武汉市火门里餐饮管理有限公司', date: '2026-09-26', signerMode: 'text', signerName: '张三', signature: null },
    notes: [],
    pdfPath: null,
    archivedAt: null,
    ...overrides,
  };
}

/** 通知单的五项分在两张付款单上：第一张两项，第二张三项 */
function twoSheetBatch(): Batch {
  return oneSheetBatch({
    sheets: [
      { id: 'sheet-1', noteId: null, groups: [meatGroup, rentGroup, propertyGroup] },
      { id: 'sheet-2', noteId: null, groups: [waterGroup, electricGroup, airGroup] },
    ],
  });
}

const PREVIEW = 'http://api.test/preview.pdf';

function amountChips(): HTMLElement[] {
  return within(screen.getByRole('region', { name: '对账清单' })).getAllByRole('button');
}

function title(): string {
  return document.querySelector('.attachment-title')!.textContent ?? '';
}

describe('reconcile workspace for a company payment form', () => {
  beforeEach(() => {
    vi.mocked(fetchBlobUrl).mockReset().mockResolvedValue('blob:mock');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.style.overflow = '';
  });

  it('calls everything a payment form and a 回单, and tells the PDF preview it is a company form', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    expect(screen.getByRole('heading', { name: '第 1 张付款单' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '付款单原样' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '回单附件' })).toBeInTheDocument();
    const tabs = within(screen.getByRole('group', { name: '对账视图' })).getAllByRole('button').map((button) => button.textContent);
    expect(tabs).toEqual(['回单', '清单', '付款单']);
    expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-ledger', 'company');
    expect(document.body).not.toHaveTextContent('报销');
  });

  it('gives every item of a notice its own row and its own amount in the checklist', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    expect(amountChips().map((chip) => chip.textContent)).toEqual(['12909.49', '22814.10', '5069.80', '48.86', '11466.87', '162.00']);
    expect(screen.getByRole('button', { name: '22814.10（店面租金（2026年9月） 第 1/1 张）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '48.86（水费（2026年7月） 第 1/1 张）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '162.00（空调能源费（2026年7月） 第 1/1 张）' })).toBeInTheDocument();
    // 每一行的小计是这一行的金额，不是通知单的合计
    expect(screen.getByText('1 张 · 合计 22814.10')).toBeInTheDocument();
    expect(screen.getByText('1 张 · 合计 11466.87')).toBeInTheDocument();
    expect(screen.queryByText(/合计 39561\.63/)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: '电费（2026年7月）的回单金额' })).toBeInTheDocument();
  });

  it('shows the notice only once among the attachments, however many rows it fills', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    // 清单里 6 个金额，附件只有 2 个：一张回单、一张通知单
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByLabelText('全部回单中的第 1 张，共 2 张')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一张' })).toBeDisabled();
  });

  it('writes the caption of an ordinary receipt the way the PDF header does', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    expect(title()).toBe('第 1 张付款单 · 肉款 第 1/1 张 · 本张 12909.49 · 肉款合计 12909.49');
  });

  it('writes the caption of a notice with its total, then each item with its month and amount', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));

    expect(title()).toBe([
      '第 1 张付款单 · 本张凭证 39561.63，含 5 项',
      '店面租金（2026年9月） 22814.10 · 物业费（2026年9月） 5069.80 · 水费（2026年7月） 48.86',
      '电费（2026年7月） 11466.87 · 空调能源费（2026年7月） 162.00',
    ].join('\n'));
  });

  it('selects the notice from any of its rows, and marks every one of its rows as current', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '11466.87（电费（2026年7月） 第 1/1 张）' }));

    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    for (const name of ['22814.10（店面租金（2026年9月） 第 1/1 张）', '11466.87（电费（2026年7月） 第 1/1 张）', '162.00（空调能源费（2026年7月） 第 1/1 张）']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-current', 'true');
    }
    expect(screen.getByRole('button', { name: '12909.49（肉款 第 1/1 张）' })).toHaveAttribute('aria-current', 'false');
  });

  it('shows the picture of the notice with all its items in the description, and loads that notice', async () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));

    expect(await screen.findByRole('img', { name: '回单 2：店面租金（2026年9月）、物业费（2026年9月）、水费（2026年7月）、电费（2026年7月）、空调能源费（2026年7月） 39561.63' })).toHaveAttribute('src', 'blob:mock');
    expect(vi.mocked(fetchBlobUrl)).toHaveBeenCalledWith('/api/receipts/notice/original-image?size=view&r=0', expect.any(AbortSignal));
  });

  it('puts the payee beside the picture so the account number can be checked against it', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    const meatPayee = screen.getByRole('group', { name: '收款方信息' });
    expect(meatPayee).toHaveTextContent('收款方（会写进付款单的备注栏，请对着图核对）');
    expect(meatPayee).toHaveTextContent('收款户名示例食品销售有限公司');
    expect(meatPayee).toHaveTextContent('开户银行示例银行上海分行');
    expect(meatPayee).toHaveTextContent('银行账号1234567890123456789');

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));

    const noticePayee = screen.getByRole('group', { name: '收款方信息' });
    expect(noticePayee).toHaveTextContent('银行账号9876543210987654321');
    expect(noticePayee).not.toHaveTextContent('1234567890123456789');
  });

  it('shows only the parts of the payee that exist, and nothing at all without one', () => {
    const batch = oneSheetBatch({ items: [{ ...meatItem, payee: { account: '1234567890123456789' } }, { ...noticeItem, payee: undefined }] });
    render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

    const payee = screen.getByRole('group', { name: '收款方信息' });
    expect(payee).toHaveTextContent('银行账号1234567890123456789');
    expect(payee).not.toHaveTextContent('收款户名');
    expect(payee).not.toHaveTextContent('开户银行');

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(screen.queryByRole('group', { name: '收款方信息' })).not.toBeInTheDocument();
  });

  it('keeps the payee in view in the full-screen picture, in small type', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));

    const dialog = screen.getByRole('dialog', { name: '回单大图' });
    const payee = within(dialog).getByRole('group', { name: '收款方信息' });
    expect(payee).toHaveTextContent('银行账号1234567890123456789');
    expect(payee).toHaveClass('attachment-payee-compact');
    expect(payee).not.toHaveTextContent('请对着图核对');
    expect(within(dialog).getByText('第 1 张付款单 · 肉款 第 1/1 张 · 本张 12909.49 · 肉款合计 12909.49')).toBeInTheDocument();
  });

  it('gives a notice that runs over two sheets one attachment on each, saying how many items are on that sheet', () => {
    render(<ReconcileWorkspace batch={twoSheetBatch()} previewUrl={PREVIEW} />);

    expect(screen.getByRole('heading', { name: '第 1 张付款单' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '第 2 张付款单' })).toBeInTheDocument();
    // 附件：第 1 张单上的回单、第 1 张单上的通知单、第 2 张单上的通知单
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(title().split('\n')[0]).toBe('第 1 张付款单 · 本张凭证 39561.63，含 5 项（本张单据上 2 项）');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(title().split('\n')).toEqual([
      '第 2 张付款单 · 本张凭证 39561.63，含 5 项（本张单据上 3 项）',
      '水费（2026年7月） 48.86 · 电费（2026年7月） 11466.87 · 空调能源费（2026年7月） 162.00',
    ]);
  });

  it('opens the attachment of the right sheet when a row of the second sheet is tapped', () => {
    render(<ReconcileWorkspace batch={twoSheetBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '48.86（水费（2026年7月） 第 1/1 张）' }));

    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(title()).toMatch(/^第 2 张付款单/);
    // 第一张单上的两行不是当前这一项
    expect(screen.getByRole('button', { name: '22814.10（店面租金（2026年9月） 第 1/1 张）' })).toHaveAttribute('aria-current', 'false');
    expect(screen.getByRole('button', { name: '11466.87（电费（2026年7月） 第 1/1 张）' })).toHaveAttribute('aria-current', 'true');
  });

  it('gives a notice its own amount in a row it shares with another 回单, wherever it sits in that row', () => {
    const water: Snapshot = { receiptId: 'water', uploadOrder: 3, category: '水费', period: '2026-07', paidFen: 5_000, refundFen: 0, netFen: 5_000, original: { ...image, id: 'img-water' }, refundImages: [] };
    // 同是 2026 年 7 月的水费：一张单项的回单排在前面，通知单里的水费（48.86）排在后面，合成同一行
    const sharedWater: FormGroup = { category: '水费', period: '2026-07', receiptIds: ['water', 'notice'], amountsFen: [5_000, 4_886], totalFen: 9_886 };
    const batch = oneSheetBatch({
      items: [meatItem, noticeItem, water],
      sheets: [{ id: 'sheet-1', noteId: null, groups: [meatGroup, rentGroup, propertyGroup, sharedWater, electricGroup, airGroup] }],
    });
    render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

    const row = screen.getByRole('list', { name: '水费（2026年7月）的回单金额' });
    expect(within(row).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['50.00', '48.86']);
    expect(screen.getByText('2 张 · 合计 98.86')).toBeInTheDocument();
  });

  it('scrolls the amount of the sheet being looked at, not the same notice on the other sheet', () => {
    const scrolled: Element[] = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: function scrollIntoView(this: Element) { scrolled.push(this); },
    });
    try {
      render(<ReconcileWorkspace batch={twoSheetBatch()} previewUrl={PREVIEW} />);

      // 通知单在两张单上各有几行：点第 2 张单上的水费，滚到的是第 2 张单上它的那一行
      fireEvent.click(screen.getByRole('button', { name: '48.86（水费（2026年7月） 第 1/1 张）' }));

      expect(scrolled.at(-1)).toHaveAttribute('data-sheet-number', '2');
      expect(scrolled.at(-1)).toHaveAttribute('data-receipt-id', 'notice');
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    }
  });

  it('says the picture of a 回单 is slow to load, in 回单 words, and offers a retry', () => {
    vi.useFakeTimers();
    vi.mocked(fetchBlobUrl).mockReset().mockReturnValue(new Promise(() => undefined));
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    act(() => { vi.advanceTimersByTime(16_000); });

    expect(screen.getByRole('status')).toHaveTextContent('网络很慢，回单图片还在加载');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('says so when the picture of a 回单 cannot be loaded', async () => {
    vi.mocked(fetchBlobUrl).mockReset().mockRejectedValue(new Error('服务器忙'));
    render(<ReconcileWorkspace batch={oneSheetBatch()} previewUrl={PREVIEW} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('回单图片加载失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('says there is nothing attached when the batch has no receipts', () => {
    render(<ReconcileWorkspace batch={oneSheetBatch({ items: [], sheets: [] })} previewUrl={PREVIEW} />);

    expect(screen.getByText('本批次没有关联回单。')).toBeInTheDocument();
  });

  it('keeps the store words and shows no payee for a store batch', async () => {
    const storeBatch: Batch = {
      ...oneSheetBatch(),
      ledger: undefined,
      totalFen: 10_000,
      items: [{ ...meatItem, category: '耗材', paidFen: 10_000, netFen: 10_000, payee: undefined }],
      sheets: [{ id: 'sheet-1', noteId: null, groups: [{ category: '耗材', receiptIds: ['meat'], amountsFen: [10_000], totalFen: 10_000 }] }],
    };
    render(<ReconcileWorkspace batch={storeBatch} previewUrl={PREVIEW} />);

    expect(screen.getByRole('heading', { name: '第 1 张报销单' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '报销单原样' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '凭证附件' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '收款方信息' })).not.toBeInTheDocument();
    expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-ledger', 'store');
    await waitFor(() => expect(screen.getByRole('img', { name: '凭证 1：耗材 100.00' })).toBeInTheDocument());
  });
});
