import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument,
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('../api', () => ({ authHeaders: () => ({}) }));

import { PdfPreview } from './PdfPreview';

const URL = 'http://api.test/api/batches/b1/preview.pdf';

/** pdf.js 把一页的文字分块吐出来：拆成两块，关键词可能被拆在两块之间。 */
function textStream(text: string) {
  const middle = Math.floor(text.length / 2);
  const chunks = [{ items: [{ str: text.slice(0, middle) }] }, { items: [{ str: text.slice(middle) }] }];
  let next = 0;
  return {
    getReader: () => ({
      read: async () => (next < chunks.length ? { done: false, value: chunks[next++] } : { done: true, value: undefined }),
      releaseLock: vi.fn(),
    }),
  };
}

/** drawn：每一页画完的时机，默认立刻画完；测试可以先拿住它，看画图过程中显示什么。 */
function fakeDocument(texts: string[], drawn: Promise<void> = Promise.resolve()) {
  return {
    numPages: texts.length,
    getPage: async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 280 * scale }),
      streamTextContent: () => textStream(texts[number - 1]!),
      render: () => ({ promise: drawn }),
    }),
  };
}

function refused(status: number) {
  return {
    promise: Promise.reject(Object.assign(new Error(`Unexpected server response (${status}) while retrieving PDF.`), { status })),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

// 公账付款单：标题「公账付款单」，页脚仍有「单据及附件共」「会计主管」；附件页页眉写「第 N 张付款单」，页尾写「原始凭证」
const COMPANY_FORM_PAGE = '公账付款单 付款单位： 单据及附件共 3 页 会计主管 复核 出纳 经办人';
const COMPANY_RECEIPT_PAGE = '第 1 张付款单 · 肉款 第 1/1 张 · 本张 12909.49 · 肉款合计 12909.49\n原始凭证';
const COMPANY_NOTICE_PAGE = '第 1 张付款单 · 本张凭证 39561.63，含 5 项\n店面租金（2026年9月） 22814.10 · 物业费（2026年9月） 5069.80\n原始凭证';
const STORE_FORM_PAGE = '费用报销单 单据及附件共 3 页 会计主管 复核 出纳 报销人';
const STORE_ATTACHMENT_PAGE = '第 1 张报销单 · 食材 第 1/2 张 · 本张 100.00 · 食材合计 200.00\n原始凭证';

describe('PDF preview of a company payment form', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    getDocument.mockReset();
  });

  it('draws only the payment-form pages and skips the attachment pages of both the 回单 and the notice', async () => {
    getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument([COMPANY_FORM_PAGE, COMPANY_RECEIPT_PAGE, COMPANY_NOTICE_PAGE, '备注续页：收款户名 示例公司', COMPANY_FORM_PAGE, COMPANY_NOTICE_PAGE])),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const onSheetDrawn = vi.fn();

    const { container } = render(<PdfPreview url={URL} ledger="company" onSheetDrawn={onSheetDrawn} />);

    await waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(3));
    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases.map((canvas) => canvas.dataset.pageNumber)).toEqual(['1', '4', '5']);
    // 付款单页标第几张，备注续页画出来但不算一张付款单
    expect(canvases.map((canvas) => canvas.dataset.sheetIndex)).toEqual(['0', undefined, '1']);
    expect(onSheetDrawn.mock.calls.map(([index]) => index)).toEqual([0, 1]);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('would not recognise the attachment pages of a payment form with the old store-only rule — they are skipped by their 付款单 header', async () => {
    // 只有「付款单」页眉和「原始凭证」：店内规则（只认「报销单」）会把它们当成普通页画出来
    getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument([COMPANY_FORM_PAGE, COMPANY_RECEIPT_PAGE])),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const { container } = render(<PdfPreview url={URL} ledger="company" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('still skips the attachment pages of a store form', async () => {
    getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument([STORE_FORM_PAGE, STORE_ATTACHMENT_PAGE])),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const { container } = render(<PdfPreview url={URL} />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('says 付款单 while loading, and 报销单 for the store', async () => {
    getDocument.mockReturnValue({ promise: new Promise(() => undefined), destroy: vi.fn().mockResolvedValue(undefined) });

    const company = render(<PdfPreview url={URL} ledger="company" />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载付款单…');
    expect(screen.getByRole('document')).toHaveAccessibleName('完整付款单 PDF 预览');
    company.unmount();

    render(<PdfPreview url={URL} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载报销单…');
    expect(screen.getByRole('document')).toHaveAccessibleName('完整报销 PDF 预览');
  });

  it.each([
    ['company', '付款单', COMPANY_FORM_PAGE],
    ['store', '报销单', STORE_FORM_PAGE],
  ] as const)('never takes a %s form page for an attachment page, even when its notes mention the attachment words', async (ledger, word, formPage) => {
    // 备注里碰巧写了「第 2 张…单」和「原始凭证」，但页脚的「单据及附件共」说明它是单据页，一定要画出来
    getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument([`${formPage} 备注：见第 2 张${word} 原始凭证`])),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const { container } = render(<PdfPreview url={URL} ledger={ledger} />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(container.querySelector('canvas')?.dataset.sheetIndex).toBe('0');
  });

  it.each([
    ['company', '正在画付款单… 第 1/2 页'],
    ['store', '正在画报销单… 第 1/2 页'],
  ] as const)('says which page it is drawing, in the words of the %s ledger', async (ledger, expected) => {
    let finish!: () => void;
    const drawn = new Promise<void>((resolve) => { finish = resolve; });
    getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument([COMPANY_FORM_PAGE, COMPANY_FORM_PAGE], drawn)),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const { container } = render(<PdfPreview url={URL} ledger={ledger} />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(expected));
    expect(screen.getByRole('document')).toHaveAttribute('aria-busy', 'true');
    finish();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    expect(screen.getByRole('document')).toHaveAttribute('aria-busy', 'false');
  });

  it.each([
    ['company', '正在加载付款单…'],
    ['store', '正在加载报销单…'],
  ] as const)('shows how much has arrived while the file downloads, in the words of the %s ledger', async (ledger, loading) => {
    const task: { promise: Promise<never>; destroy: () => Promise<void>; onProgress?: (event: { loaded: number; total: number }) => void } = {
      promise: new Promise(() => undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    getDocument.mockReturnValue(task);

    render(<PdfPreview url={URL} ledger={ledger} />);
    await waitFor(() => expect(task.onProgress).toBeTypeOf('function'));

    act(() => task.onProgress!({ loaded: 512 * 1024, total: 2 * 1024 * 1024 }));
    expect(screen.getByRole('status')).toHaveTextContent(`${loading} 25%（512 KB / 2.0 MB）`);

    act(() => task.onProgress!({ loaded: 300 * 1024, total: 0 }));
    expect(screen.getByRole('status')).toHaveTextContent(`${loading} 已收到 300 KB`);
  });

  it.each([
    ['company', '网络很慢，还在加载付款单……可以点「重试」。'],
    ['store', '网络很慢，还在加载报销单……可以点「重试」。'],
  ] as const)('says the network is slow and offers a retry, in the words of the %s ledger', (ledger, expected) => {
    vi.useFakeTimers();
    getDocument.mockReturnValue({ promise: new Promise(() => undefined), destroy: vi.fn().mockResolvedValue(undefined) });

    render(<PdfPreview url={URL} ledger={ledger} />);
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(20_000); });

    expect(screen.getByRole('status')).toHaveTextContent(expected);
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('names the payment form when the file cannot be found', async () => {
    getDocument.mockReturnValue(refused(404));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    render(<PdfPreview url={URL} ledger="company" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('预览加载失败：找不到这张付款单的文件（404），可能已被清理。');
  });

  it('keeps the store wording for the same failure', async () => {
    getDocument.mockReturnValue(refused(404));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    render(<PdfPreview url={URL} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('找不到这张报销单的文件（404）');
  });
});
