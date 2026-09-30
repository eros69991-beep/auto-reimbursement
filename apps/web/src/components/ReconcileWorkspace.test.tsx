import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function item(receiptId: string, uploadOrder: number, category: Snapshot['category'], merchant: string, netFen: number): Snapshot {
  return { receiptId, uploadOrder, category, merchant, paidFen: netFen, refundFen: 0, netFen, original: image, refundImages: [] };
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

describe('reconcile workspace', () => {
  afterEach(() => cleanup());

  it('lists reconcile rows and shows the first attachment with its title', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl="http://api.test/preview.pdf" />);
    expect(screen.getByRole('button', { name: /能耗费：合计 277\.20（1 张凭证）/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /耗材：合计 248\.43（2 张凭证）/ })).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 张 · 能耗费 · 电力公司营业厅 · 实付 277.20')).toBeInTheDocument();
    // 图片经带鉴权的 fetch 加载为 object URL
    expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
    // 必须传相对路径：fetchBlobUrl 会自己拼 API 地址，传完整 URL 会被拼两次（曾导致 404）
    expect(vi.mocked(fetchBlobUrl)).toHaveBeenCalledWith('/api/receipts/r1/original-image?r=0');
    // 初始高亮第一行
    expect(screen.getByRole('button', { name: /能耗费/ })).toHaveAttribute('aria-current', 'true');
  });

  it('clicking a row jumps to its first receipt and highlights the row', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl="http://api.test/preview.pdf" />);
    fireEvent.click(screen.getByRole('button', { name: /耗材：合计/ }));
    expect(screen.getByText('第 2 / 3 张 · 耗材 · 办公用品店 · 实付 148.43')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /凭证 2/ })).toHaveAttribute('src', 'blob:mock');
    expect(screen.getByRole('button', { name: /耗材：合计/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /能耗费/ })).toHaveAttribute('aria-current', 'false');
  });

  it('steps through attachments with prev/next and keeps the owning row highlighted', () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl="http://api.test/preview.pdf" />);
    const prev = screen.getByRole('button', { name: '上一张' });
    const next = screen.getByRole('button', { name: '下一张' });
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('第 3 / 3 张 · 耗材 · 文具批发部 · 实付 100.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /耗材：合计/ })).toHaveAttribute('aria-current', 'true');
    expect(next).toBeDisabled();
    fireEvent.click(prev);
    expect(screen.getByText(/第 2 \/ 3 张/)).toBeInTheDocument();
  });

  it('zooms the image and restores fit-to-width', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl="http://api.test/preview.pdf" />);
    const img = () => screen.getByRole('img', { name: /凭证 1/ });
    await screen.findByRole('img', { name: /凭证 1/ });
    expect(img()).toHaveStyle({ width: '100%' });
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(img()).toHaveStyle({ width: '125%' });
    fireEvent.click(screen.getByRole('button', { name: '恢复适宽' }));
    expect(img()).toHaveStyle({ width: '100%' });
    expect(screen.getByRole('button', { name: '恢复适宽' })).toBeDisabled();
  });

  it('shows an empty state when the batch has no receipts', () => {
    render(<ReconcileWorkspace batch={sampleBatch({ items: [], sheets: [{ id: 'sheet-1', noteId: null, groups: [] }] })} previewUrl="http://api.test/preview.pdf" />);
    expect(screen.getByText('本批次没有关联凭证。')).toBeInTheDocument();
  });

  it('scrolls the form side to the sheet page that owns the selected attachment', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
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
    render(<ReconcileWorkspace batch={twoSheetBatch} previewUrl="http://api.test/preview.pdf" />);
    // 初始渲染跟随到第 1 页
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /耗材：合计/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    // 跳到第 2 张报销单所在的画布（中间隔着附件页/续页，不能按页码 2 推算）
    expect((scrollIntoView.mock.contexts[0] as HTMLElement).dataset.pageNumber).toBe('3');
    // 按钮标注所属页
    expect(screen.getByRole('button', { name: /第 2 页 · 耗材：合计/ })).toBeInTheDocument();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('offers retry when the image fails to load and keeps the form side intact', async () => {
    render(<ReconcileWorkspace batch={sampleBatch()} previewUrl="http://api.test/preview.pdf" />);
    fireEvent.error(await screen.findByRole('img', { name: /凭证 1/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('凭证图片加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
    // 左侧报销行仍在
    expect(screen.getByRole('button', { name: /能耗费：合计/ })).toBeInTheDocument();
  });
});
