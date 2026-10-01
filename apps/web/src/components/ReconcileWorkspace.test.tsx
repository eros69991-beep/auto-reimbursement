import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBlobUrl } from '../api';

import type { Batch, ImageRef, Snapshot } from '@auto-reimbursement/contracts';

vi.mock('../api', () => ({
  api: {
    receiptOriginalUrl: (id: string) => `http://api.test/original/${id}`,
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
}));

vi.mock('./PdfPreview', () => ({
  PdfPreview: ({ url }: { url: string }) => (
    <div data-testid="pdf-preview" data-url={url}>
      <canvas data-page-number="1" data-sheet-index="0" />
      <canvas data-page-number="2" />
      <canvas data-page-number="3" data-sheet-index="1" />
    </div>
  ),
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

function item(receiptId: string, uploadOrder: number, category: Snapshot['category'], merchant: string, netFen: number, refundFen = 0): Snapshot {
  return {
    receiptId,
    uploadOrder,
    category,
    merchant,
    paidFen: netFen + refundFen,
    refundFen,
    netFen,
    original: image,
    refundImages: [],
  };
}

function sampleBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 52563,
    items: [
      item('r1', 1, '能耗费', '电力公司营业厅', 27720),
      item('r2', 2, '耗材', '办公用品店', 14843),
      item('r3', 3, '耗材', '文具批发部', 10000),
    ],
    sheets: [
      {
        id: 'sheet-1',
        noteId: null,
        groups: [
          { category: '能耗费', totalFen: 27720, receiptIds: ['r1'], amountsFen: [27720] },
          { category: '耗材', totalFen: 24843, receiptIds: ['r2', 'r3'], amountsFen: [14843, 10000] },
        ],
      },
    ],
    options: { department: '门店运营部', date: '2026-09-26', signerMode: 'text', signerName: '张三', signature: null },
    notes: [],
    pdfPath: null,
    archivedAt: null,
    ...overrides,
  };
}

const PREVIEW = 'http://api.test/preview.pdf';

function amountChips(): HTMLElement[] {
  return within(screen.getByRole('region', { name: '对账清单' })).getAllByRole('button');
}

describe('reconcile workspace', () => {
  afterEach(() => cleanup());

  it('lists every receipt amount by sheet and category and shows the first receipt with its caption', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);

    // 对账清单：按报销单、分类列出每张凭证的实报金额，分类写明张数和合计
    expect(screen.getByRole('heading', { name: '第 1 张报销单' })).toBeInTheDocument();
    expect(screen.getByText('1 张 · 合计 277.20')).toBeInTheDocument();
    expect(screen.getByText('2 张 · 合计 248.43')).toBeInTheDocument();
    expect(amountChips().map((chip) => chip.textContent)).toEqual(['277.20', '148.43', '100.00']);
    expect(screen.getByRole('button', { name: '277.20（能耗费 第 1/1 张）' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' })).toHaveAttribute('aria-current', 'false');
    expect(screen.getByRole('button', { name: '100.00（耗材 第 2/2 张）' })).toHaveAttribute('aria-current', 'false');

    // 右边：同一句对账说明，不再写商家
    expect(screen.getByText('第 1 张报销单 · 能耗费 第 1/1 张 · 本张 277.20 · 能耗费合计 277.20')).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(screen.queryByText(/电力公司营业厅|未识别商家/)).not.toBeInTheDocument();
    // 图片经带鉴权的 fetch 加载为 object URL
    expect(await screen.findByRole('img', { name: '凭证 1：能耗费 277.20' })).toHaveAttribute('src', 'blob:mock');
    // 必须传相对路径：fetchBlobUrl 会自己拼 API 地址，传完整 URL 会被拼两次（曾导致 404）
    expect(vi.mocked(fetchBlobUrl)).toHaveBeenCalledWith('/api/receipts/r1/original-image?r=0');
    // 报销单原样仍在，用的是传进来的预览地址
    expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-url', PREVIEW);
  });

  it('tapping an amount switches to that receipt and highlights it', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);

    fireEvent.click(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' }));

    expect(screen.getByText('第 1 张报销单 · 耗材 第 1/2 张 · 本张 148.43 · 耗材合计 248.43')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: '凭证 2：耗材 148.43' })).toHaveAttribute('src', 'blob:mock');
    expect(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: '277.20（能耗费 第 1/1 张）' })).toHaveAttribute('aria-current', 'false');
  });

  it('steps through the receipts with prev/next and keeps the matching amount highlighted', () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
    const prev = screen.getByRole('button', { name: '上一张' });
    const next = screen.getByRole('button', { name: '下一张' });
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);

    expect(screen.getByText('第 1 张报销单 · 耗材 第 2/2 张 · 本张 100.00 · 耗材合计 248.43')).toBeInTheDocument();
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100.00（耗材 第 2/2 张）' })).toHaveAttribute('aria-current', 'true');
    expect(next).toBeDisabled();
    fireEvent.click(prev);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' })).toHaveAttribute('aria-current', 'true');
  });

  it('keeps the order of the form: groups as printed, receipts as listed in the summary', () => {
    const batch = sampleBatch({
      sheets: [
        {
          id: 'sheet-1',
          noteId: null,
          // 报销单上耗材在前；组内的顺序就是摘要里金额的顺序，这里不再另按上传顺序重排
          groups: [
            { category: '耗材', totalFen: 24843, receiptIds: ['r3', 'r2'], amountsFen: [10000, 14843] },
            { category: '能耗费', totalFen: 27720, receiptIds: ['r1'], amountsFen: [27720] },
          ],
        },
      ],
    });
    render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

    expect(amountChips().map((chip) => chip.textContent)).toEqual(['100.00', '148.43', '277.20']);
    // 右边的「上一张 / 下一张」也按这个顺序走
    expect(screen.getByText('第 1 张报销单 · 耗材 第 1/2 张 · 本张 100.00 · 耗材合计 248.43')).toBeInTheDocument();
  });

  it('writes the refund breakdown for a receipt that carries an old refund and lists its net amount', () => {
    const batch = sampleBatch({
      items: [item('r1', 1, '能耗费', '电力公司营业厅', 22000, 8000), item('r2', 2, '耗材', '办公用品店', 14843), item('r3', 3, '耗材', '文具批发部', 10000)],
    });
    render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

    expect(screen.getByRole('button', { name: '220.00（能耗费 第 1/1 张）' })).toBeInTheDocument();
    expect(screen.getByText('原实付 300.00 / 退款 80.00 / 实报 220.00')).toBeInTheDocument();
    // 没有退款的凭证不写这一行
    fireEvent.click(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' }));
    expect(screen.queryByText(/原实付/)).not.toBeInTheDocument();
  });

  it('zooms the image and restores fit-to-width', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
    const img = () => screen.getByRole('img', { name: /凭证 1/ });
    await screen.findByRole('img', { name: /凭证 1/ });
    expect(img()).toHaveStyle({ width: '100%' });
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(img()).toHaveStyle({ width: '125%' });
    fireEvent.click(screen.getByRole('button', { name: '恢复适宽' }));
    expect(img()).toHaveStyle({ width: '100%' });
    expect(screen.getByRole('button', { name: '恢复适宽' })).toBeDisabled();
  });

  it('shows an empty state without a checklist when the batch has no receipts', () => {
    render(<ReconcileWorkspace batch={sampleBatch({ items: [], sheets: [{ id: 'sheet-1', noteId: null, groups: [] }] })} previewUrl={PREVIEW} />);

    expect(screen.getByText('本批次没有关联凭证。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '对账清单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看报销单原样' })).not.toBeInTheDocument();
  });

  it('scrolls the form original to the sheet that owns the selected receipt', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const twoSheetBatch = sampleBatch({
        sheets: [
          {
            id: 'sheet-1',
            noteId: null,
            groups: [{ category: '能耗费', totalFen: 27720, receiptIds: ['r1'], amountsFen: [27720] }],
          },
          {
            id: 'sheet-2',
            noteId: null,
            groups: [{ category: '耗材', totalFen: 24843, receiptIds: ['r2', 'r3'], amountsFen: [14843, 10000] }],
          },
        ],
      });
      const canvasScrolls = () => scrollIntoView.mock.contexts.filter((context) => context instanceof HTMLCanvasElement) as HTMLCanvasElement[];
      render(<ReconcileWorkspace batch={twoSheetBatch} previewUrl={PREVIEW} />);
      // 初始渲染跟随到第 1 张报销单
      await waitFor(() => expect(canvasScrolls()).toHaveLength(1));
      expect(canvasScrolls()[0]!.dataset.sheetIndex).toBe('0');
      scrollIntoView.mockClear();

      fireEvent.click(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' }));
      await waitFor(() => expect(canvasScrolls()).toHaveLength(1));
      // 跳到第 2 张报销单所在的画布（中间隔着附件页/续页，不能按页码 2 推算）
      expect(canvasScrolls()[0]!.dataset.pageNumber).toBe('3');
      // 清单标出所属的报销单
      expect(screen.getByRole('heading', { name: '第 2 张报销单' })).toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('scrolls the selected amount into view in the checklist when stepping with prev/next', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      scrollIntoView.mockClear();

      fireEvent.click(screen.getByRole('button', { name: '下一张' }));

      await waitFor(() => expect(scrollIntoView.mock.contexts.some(
        (context) => context instanceof HTMLButtonElement && context.dataset.receiptId === 'r2',
      )).toBe(true));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('keeps the form original mounted and lets a narrow screen flip between it and the checklist', () => {
    const { container } = render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
    const root = container.querySelector('.reconcile')!;
    const toggle = screen.getByRole('button', { name: '查看报销单原样' });

    // 默认是对账清单；报销单原样一直挂着（样式决定窄屏上显示哪一个），切换不会重新加载 PDF
    expect(root).toHaveAttribute('data-view', 'list');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(root).toHaveAttribute('data-view', 'form');
    expect(screen.getByRole('button', { name: '返回对账清单' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
    // 清单里的选择不受影响
    expect(screen.getByRole('button', { name: '277.20（能耗费 第 1/1 张）' })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: '返回对账清单' }));
    expect(root).toHaveAttribute('data-view', 'list');
  });

  it('offers retry when the image fails to load and keeps the checklist intact', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
    fireEvent.error(await screen.findByRole('img', { name: /凭证 1/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('凭证图片加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
    // 左侧清单仍在
    expect(amountChips()).toHaveLength(3);
  });

  it('labels the parts of a category that continues on the next sheet and counts each part on its own', async () => {
    const splitBatch = sampleBatch({
      items: [
        item('r1', 1, '耗材', '店甲', 10000),
        item('r2', 2, '耗材', '店乙', 10001),
        item('r3', 3, '耗材', '店丙', 10002),
      ],
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [{ category: '耗材', totalFen: 20001, receiptIds: ['r1', 'r2'], amountsFen: [10000, 10001], part: 1 }] },
        { id: 'sheet-2', noteId: null, groups: [{ category: '耗材', totalFen: 10002, receiptIds: ['r3'], amountsFen: [10002], part: 2 }] },
      ],
    });
    render(<ReconcileWorkspace batch={splitBatch} previewUrl={PREVIEW} />);

    // 报销单上第 2 部分写「耗材（续）」，清单与它一致，各自的张数和小计分开写
    expect(screen.getByRole('heading', { name: '第 1 张报销单' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '第 2 张报销单' })).toBeInTheDocument();
    expect(screen.getByText('2 张 · 合计 200.01')).toBeInTheDocument();
    expect(screen.getByText('耗材（续）')).toBeInTheDocument();
    expect(screen.getByText('1 张 · 合计 100.02')).toBeInTheDocument();
    // 点「耗材（续）」里的那一张，就是全批次的第 3 张，说明里写它在第 2 张报销单上、续页的第 1/1 张
    fireEvent.click(screen.getByRole('button', { name: '100.02（耗材（续） 第 1/1 张）' }));
    expect(await screen.findByText('第 2 张报销单 · 耗材（续） 第 1/1 张 · 本张 100.02 · 耗材（续）合计 100.02')).toBeInTheDocument();
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
  });
});
