import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchBlobUrl } from '../api';

import type { Batch, ImageRef, Snapshot } from '@auto-reimbursement/contracts';

const { sheetDrawn } = vi.hoisted(() => ({
  sheetDrawn: { current: undefined as undefined | ((sheetIndex: number, canvas: HTMLCanvasElement) => void) },
}));

vi.mock('../api', () => ({
  api: {
    receiptOriginalUrl: (id: string) => `http://api.test/original/${id}`,
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
}));

vi.mock('./PdfPreview', () => ({
  PdfPreview: ({ url, minWidth, onSheetDrawn }: { url: string; minWidth?: number; onSheetDrawn?: (sheetIndex: number, canvas: HTMLCanvasElement) => void }) => {
    sheetDrawn.current = onSheetDrawn;
    return (
      <div data-testid="pdf-preview" data-url={url} data-min-width={String(minWidth ?? 0)}>
        <canvas data-page-number="1" data-sheet-index="0" />
        <canvas data-page-number="2" />
        <canvas data-page-number="3" data-sheet-index="1" />
      </div>
    );
  },
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

/** 合并出来的凭证：756 宽的拼图，左边一张 300 宽、右边一张 450 宽，中间 6px 分隔线 */
const mergedImage: ImageRef = {
  ...image,
  id: 'img-merged',
  width: 756,
  height: 600,
  panels: [{ left: 0, width: 300 }, { left: 306, width: 450 }],
};

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

/** r1 是合并出来的凭证（两张截图拼成一张），r2、r3 是普通凭证 */
function mergedBatch(): Batch {
  const batch = sampleBatch();
  return { ...batch, items: [{ ...batch.items[0]!, original: mergedImage }, ...batch.items.slice(1)] };
}

const PREVIEW = 'http://api.test/preview.pdf';

function amountChips(): HTMLElement[] {
  return within(screen.getByRole('region', { name: '对账清单' })).getAllByRole('button');
}

/** 假装这是手机（窄屏）；不调用就是宽屏（jsdom 本身没有 matchMedia） */
function narrowScreen(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: narrow && query === '(max-width: 899px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe('reconcile workspace', () => {
  beforeEach(() => {
    vi.mocked(fetchBlobUrl).mockReset().mockResolvedValue('blob:mock');
    sheetDrawn.current = undefined;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as { matchMedia?: unknown }).matchMedia;
    document.body.style.overflow = '';
  });

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
    // 必须传相对路径：fetchBlobUrl 会自己拼 API 地址，传完整 URL 会被拼两次（曾导致 404）；
    // size=view：大图给缩小版；第二个参数是取消信号（切换凭证时取消还没下完的那张）
    expect(vi.mocked(fetchBlobUrl)).toHaveBeenCalledWith(
      '/api/receipts/r1/original-image?size=view&r=0',
      expect.any(AbortSignal),
    );
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

  it('shows an empty state without a checklist or tabs when the batch has no receipts', () => {
    const { container } = render(<ReconcileWorkspace batch={sampleBatch({ items: [], sheets: [{ id: 'sheet-1', noteId: null, groups: [] }] })} previewUrl={PREVIEW} />);

    expect(screen.getByText('本批次没有关联凭证。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '对账清单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '对账视图' })).not.toBeInTheDocument();
    // 没有标签可切时，各块都显示出来，不能把报销单藏起来
    expect(container.querySelector('.reconcile')).toHaveAttribute('data-tab', 'all');
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

  it('jumps to the right sheet when the preview finishes drawing after the receipt was picked', () => {
    const twoSheetBatch = sampleBatch({
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [{ category: '能耗费', totalFen: 27720, receiptIds: ['r1'], amountsFen: [27720] }] },
        { id: 'sheet-2', noteId: null, groups: [{ category: '耗材', totalFen: 24843, receiptIds: ['r2', 'r3'], amountsFen: [14843, 10000] }] },
      ],
    });
    render(<ReconcileWorkspace batch={twoSheetBatch} previewUrl={PREVIEW} />);
    fireEvent.click(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' }));

    // 预览是慢慢画出来的：画好第 1 张时不动，画好当前凭证所属的第 2 张时才滚过去
    const firstSheet = document.createElement('canvas');
    const secondSheet = document.createElement('canvas');
    firstSheet.scrollIntoView = vi.fn();
    secondSheet.scrollIntoView = vi.fn();
    act(() => sheetDrawn.current!(0, firstSheet));
    act(() => sheetDrawn.current!(1, secondSheet));

    expect(firstSheet.scrollIntoView).not.toHaveBeenCalled();
    expect(secondSheet.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
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

  describe('narrow screen (phone)', () => {
    it('shows one block at a time: voucher first, then checklist and form with the tabs', () => {
      narrowScreen(true);
      const { container } = render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      const root = container.querySelector('.reconcile')!;
      const tabs = within(screen.getByRole('group', { name: '对账视图' }));

      // 一打开就是凭证；报销单预览先不加载，把带宽留给凭证图
      expect(root).toHaveAttribute('data-tab', 'voucher');
      expect(tabs.getByRole('button', { name: '凭证' })).toHaveAttribute('aria-pressed', 'true');
      expect(tabs.getByRole('button', { name: '清单' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByTestId('pdf-preview')).not.toBeInTheDocument();

      fireEvent.click(tabs.getByRole('button', { name: '清单' }));
      expect(root).toHaveAttribute('data-tab', 'list');
      expect(tabs.getByRole('button', { name: '清单' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTestId('pdf-preview')).not.toBeInTheDocument();

      // 点开报销单标签才开始加载，并且按手机上读得清的宽度来画
      fireEvent.click(tabs.getByRole('button', { name: '报销单' }));
      expect(root).toHaveAttribute('data-tab', 'form');
      const preview = screen.getByTestId('pdf-preview');
      expect(preview).toHaveAttribute('data-url', PREVIEW);
      expect(preview).toHaveAttribute('data-min-width', '960');

      // 来回切换不会重新加载：还是同一个节点
      fireEvent.click(tabs.getByRole('button', { name: '凭证' }));
      expect(root).toHaveAttribute('data-tab', 'voucher');
      expect(screen.getByTestId('pdf-preview')).toBe(preview);
    });

    it('tapping an amount in the checklist goes straight to that voucher', async () => {
      narrowScreen(true);
      const { container } = render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      const root = container.querySelector('.reconcile')!;
      fireEvent.click(screen.getByRole('button', { name: '清单' }));
      expect(root).toHaveAttribute('data-tab', 'list');

      fireEvent.click(screen.getByRole('button', { name: '100.00（耗材 第 2/2 张）' }));

      expect(root).toHaveAttribute('data-tab', 'voucher');
      expect(screen.getByText('第 1 张报销单 · 耗材 第 2/2 张 · 本张 100.00 · 耗材合计 248.43')).toBeInTheDocument();
      expect(await screen.findByRole('img', { name: '凭证 3：耗材 100.00' })).toBeInTheDocument();
    });

    it('draws the form at full width straight away on a wide screen', () => {
      narrowScreen(false);
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);

      const preview = screen.getByTestId('pdf-preview');
      expect(preview).toHaveAttribute('data-min-width', '0');
    });
  });

  describe('merged receipts', () => {
    it('lets you look at one screenshot at a time, each fitted to the width, or the whole stitched image', async () => {
      render(<ReconcileWorkspace batch={mergedBatch()} previewUrl={PREVIEW} />);
      const img = await screen.findByRole('img', { name: /凭证 1/ });
      const panels = within(screen.getByRole('group', { name: '合并的截图' }));

      // 默认看第一张截图：图放大到让这一张刚好撑满宽度（756 / 300 = 252%）
      expect(panels.getByRole('button', { name: '截图 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(img).toHaveStyle({ width: '252%' });

      fireEvent.click(panels.getByRole('button', { name: '截图 2' }));
      expect(panels.getByRole('button', { name: '截图 2' })).toHaveAttribute('aria-pressed', 'true');
      expect(panels.getByRole('button', { name: '截图 1' })).toHaveAttribute('aria-pressed', 'false');
      // 756 / 450 = 168%
      expect(screen.getByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '168%' });

      fireEvent.click(panels.getByRole('button', { name: '整图' }));
      expect(panels.getByRole('button', { name: '整图' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '100%' });
    });

    it('zooms on top of the screenshot that is being looked at', async () => {
      render(<ReconcileWorkspace batch={mergedBatch()} previewUrl={PREVIEW} />);
      await screen.findByRole('img', { name: /凭证 1/ });

      fireEvent.click(screen.getByRole('button', { name: '放大' }));

      expect(screen.getByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '315%' });
    });

    it('scrolls the viewer to the left edge of the chosen screenshot', async () => {
      // jsdom 没有排版：给图一个 1000px 的显示宽度，记下写进滚动位置的值
      const scrolls: number[] = [];
      const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
      const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
      Object.defineProperty(Element.prototype, 'scrollLeft', {
        configurable: true,
        get: () => 0,
        set: (value: number) => { scrolls.push(value); },
      });
      try {
        render(<ReconcileWorkspace batch={mergedBatch()} previewUrl={PREVIEW} />);
        await screen.findByRole('img', { name: /凭证 1/ });
        expect(scrolls.at(-1)).toBe(0);

        fireEvent.click(screen.getByRole('button', { name: '截图 2' }));
        // 第二张截图从拼图的 306/756 处开始
        expect(scrolls.at(-1)).toBe(405);

        fireEvent.click(screen.getByRole('button', { name: '整图' }));
        expect(scrolls.at(-1)).toBe(0);
      } finally {
        if (clientWidth === undefined) delete (Element.prototype as { clientWidth?: unknown }).clientWidth;
        else Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
        if (scrollLeft === undefined) delete (Element.prototype as { scrollLeft?: unknown }).scrollLeft;
        else Object.defineProperty(Element.prototype, 'scrollLeft', scrollLeft);
      }
    });

    it('starts from the first screenshot again when you come back to a merged receipt', async () => {
      render(<ReconcileWorkspace batch={mergedBatch()} previewUrl={PREVIEW} />);
      await screen.findByRole('img', { name: /凭证 1/ });
      fireEvent.click(screen.getByRole('button', { name: '截图 2' }));

      fireEvent.click(screen.getByRole('button', { name: '148.43（耗材 第 1/2 张）' }));
      // 普通凭证没有分截图的按钮
      expect(screen.queryByRole('group', { name: '合并的截图' })).not.toBeInTheDocument();
      expect(await screen.findByRole('img', { name: /凭证 2/ })).toHaveStyle({ width: '100%' });

      fireEvent.click(screen.getByRole('button', { name: '277.20（能耗费 第 1/1 张）' }));
      expect(screen.getByRole('button', { name: '截图 1' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('only offers the whole image when the recorded positions do not fit the image', async () => {
      const batch = mergedBatch();
      // 位置超出整张图的宽度：数据不可信，不能按它来裁
      batch.items[0] = { ...batch.items[0]!, original: { ...mergedImage, panels: [{ left: 0, width: 300 }, { left: 306, width: 900 }] } };
      render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

      expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '100%' });
      expect(screen.queryByRole('group', { name: '合并的截图' })).not.toBeInTheDocument();
    });

    it('treats a merged receipt from before positions were recorded as a plain image', async () => {
      const batch = mergedBatch();
      const { panels: _panels, ...withoutPanels } = mergedImage;
      batch.items[0] = { ...batch.items[0]!, original: withoutPanels };
      render(<ReconcileWorkspace batch={batch} previewUrl={PREVIEW} />);

      expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '100%' });
      expect(screen.queryByRole('group', { name: '合并的截图' })).not.toBeInTheDocument();
    });
  });

  describe('full screen', () => {
    it('opens a full-screen viewer with its own controls and closes it again, putting everything back', async () => {
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      await screen.findByRole('img', { name: /凭证 1/ });
      const opener = screen.getByRole('button', { name: '全屏查看' });

      fireEvent.click(opener);

      const dialog = screen.getByRole('dialog', { name: '凭证大图' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const view = within(dialog);
      expect(view.getByText('第 1 张报销单 · 能耗费 第 1/1 张 · 本张 277.20 · 能耗费合计 277.20')).toBeInTheDocument();
      // 图只画一份：全屏的这份，背后的那份先撤掉
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(await view.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
      // 背后的页面不再滚动，焦点在「关闭全屏」上
      expect(document.body.style.overflow).toBe('hidden');
      expect(view.getByRole('button', { name: '关闭全屏' })).toHaveFocus();

      // 全屏里翻页、缩放
      fireEvent.click(view.getByRole('button', { name: '下一张' }));
      expect(view.getByText('第 1 张报销单 · 耗材 第 1/2 张 · 本张 148.43 · 耗材合计 248.43')).toBeInTheDocument();
      expect(await view.findByRole('img', { name: /凭证 2/ })).toBeInTheDocument();
      fireEvent.click(view.getByRole('button', { name: '放大' }));
      expect(view.getByRole('img', { name: /凭证 2/ })).toHaveStyle({ width: '125%' });

      fireEvent.click(view.getByRole('button', { name: '关闭全屏' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      // 回到页面里：停在翻到的那张，缩放恢复成适宽，焦点回到「全屏查看」
      expect(screen.getByText('2 / 3')).toBeInTheDocument();
      expect(await screen.findByRole('img', { name: /凭证 2/ })).toHaveStyle({ width: '100%' });
      expect(screen.getByRole('button', { name: '全屏查看' })).toHaveFocus();
    });

    it('closes on Escape', async () => {
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
      expect(screen.getByRole('dialog', { name: '凭证大图' })).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
    });

    it('offers the screenshots of a merged receipt in full screen too', async () => {
      render(<ReconcileWorkspace batch={mergedBatch()} previewUrl={PREVIEW} />);
      fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
      const view = within(screen.getByRole('dialog', { name: '凭证大图' }));
      const img = await view.findByRole('img', { name: /凭证 1/ });
      expect(img).toHaveStyle({ width: '252%' });

      fireEvent.click(view.getByRole('button', { name: '截图 2' }));

      expect(view.getByRole('img', { name: /凭证 1/ })).toHaveStyle({ width: '168%' });
    });
  });

  describe('loading the voucher image', () => {
    it('offers retry when the image fails to load and keeps the checklist intact', async () => {
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      fireEvent.error(await screen.findByRole('img', { name: /凭证 1/ }));
      expect(screen.getByRole('alert')).toHaveTextContent('凭证图片加载失败');
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
      // 左侧清单仍在
      expect(amountChips()).toHaveLength(3);
    });

    it('says why the image could not be fetched and retries with a new request', async () => {
      vi.mocked(fetchBlobUrl).mockRejectedValueOnce(new Error('无法连接服务器，请检查网络后重试'));
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('凭证图片加载失败：无法连接服务器，请检查网络后重试。');

      fireEvent.click(screen.getByRole('button', { name: '重试' }));

      expect(await screen.findByRole('img', { name: /凭证 1/ })).toHaveAttribute('src', 'blob:mock');
      expect(vi.mocked(fetchBlobUrl).mock.calls.map(([path]) => path)).toEqual([
        '/api/receipts/r1/original-image?size=view&r=0',
        '/api/receipts/r1/original-image?size=view&r=1',
      ]);
    });

    it('does not repeat the generic reason the server gives for any refusal', async () => {
      vi.mocked(fetchBlobUrl).mockRejectedValueOnce(new Error('加载失败'));
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);

      expect((await screen.findByRole('alert')).textContent).toMatch(/^凭证图片加载失败。 ?重试$/);
    });

    it('says the network is slow and offers a retry when the image takes too long', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchBlobUrl).mockReturnValue(new Promise(() => undefined));
      render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(16_000); });

      expect(screen.getByRole('status')).toHaveTextContent('网络很慢，凭证图片还在加载');
      vi.mocked(fetchBlobUrl).mockResolvedValue('blob:mock');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
      expect(vi.mocked(fetchBlobUrl).mock.calls.at(-1)![0]).toBe('/api/receipts/r1/original-image?size=view&r=1');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('stops downloading the image of the receipt you left, so slow networks only fetch the current one', async () => {
      const signals: AbortSignal[] = [];
      vi.mocked(fetchBlobUrl).mockImplementation((_path, signal) => {
        signals.push(signal!);
        return new Promise(() => undefined);
      });
      const { unmount } = render(<ReconcileWorkspace batch={sampleBatch()} previewUrl={PREVIEW} />);
      await waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]!.aborted).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: '下一张' }));

      await waitFor(() => expect(signals).toHaveLength(2));
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);

      unmount();
      expect(signals[1]!.aborted).toBe(true);
    });
  });
});
