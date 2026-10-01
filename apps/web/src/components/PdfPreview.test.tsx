import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function refused(status: number) {
  return {
    promise: Promise.reject(Object.assign(new Error(`Unexpected server response (${status}) while retrieving PDF.`), { status })),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function failing(error: Error) {
  return { promise: Promise.reject(error), destroy: vi.fn().mockResolvedValue(undefined) };
}

/** 一份只有若干页文字的假 PDF：页内容由 texts 给出，画布用假上下文。 */
function fakeDocument(texts: string[]) {
  return {
    numPages: texts.length,
    getPage: async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 280 * scale }),
      getTextContent: async () => ({ items: [{ str: texts[number - 1] }] }),
      render: () => ({ promise: Promise.resolve() }),
    }),
  };
}

const FORM_PAGE = '费用报销单 单据及附件共 3 页 会计主管 复核 出纳 报销人';
const ATTACHMENT_PAGE = '第 1 张报销单 · 食材 第 1/2 张 · 本张 100.00 · 食材合计 200.00\n原始凭证';

describe('PDF preview', () => {
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

  describe('failures', () => {
    it('shows the reason the server gives when it refuses the preview', async () => {
      getDocument.mockReturnValue(refused(409));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: 'LAYOUT_OUTDATED', message: '这张报销单是按旧版式生成的。请到「历史」页撤销本单，再重新生成。' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      render(<PdfPreview url={URL} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('请到「历史」页撤销本单');
    });

    it('explains a gateway error by its status code when the server gives no readable reason', async () => {
      getDocument.mockReturnValue(refused(502));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502 }));

      render(<PdfPreview url={URL} />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('预览加载失败');
      expect(alert).toHaveTextContent('服务器暂时没有响应（502）');
    });

    it('does not download the whole PDF again just to read a refusal reason', async () => {
      getDocument.mockReturnValue(refused(503));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('%PDF-1.7 fine now', { status: 200 }));

      render(<PdfPreview url={URL} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('服务器暂时没有响应（503）');
      // 第二次请求带了取消信号，成功时立刻取消，不会把整份 PDF 再下一遍
      expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it('says the network is down for a fetch failure and offers a retry that loads again', async () => {
      getDocument.mockReturnValueOnce(failing(Object.assign(new Error('Failed to fetch'), { name: 'UnknownErrorException' })));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      render(<PdfPreview url={URL} />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('网络中断或连不上服务器');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getDocument).toHaveBeenCalledTimes(1);
      expect(getDocument.mock.calls[0]![0].url).toBe(URL);

      getDocument.mockReturnValueOnce({ promise: new Promise(() => undefined), destroy: vi.fn().mockResolvedValue(undefined) });
      fireEvent.click(screen.getByRole('button', { name: '重试' }));

      await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
      // 重试换一个地址，绕开浏览器里可能残留的半截缓存
      expect(getDocument.mock.calls[1]![0].url).toBe(`${URL}?retry=1`);
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByRole('status')).toHaveTextContent('正在加载报销单');
    });

    it('keeps the technical details one tap away so a screenshot is enough to diagnose it', async () => {
      getDocument.mockReturnValue(failing(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      render(<PdfPreview url={URL} />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('预览加载失败');
      expect(alert).toHaveTextContent('内容不完整或已损坏');
      expect(alert).toHaveTextContent('InvalidPDFException: Invalid PDF structure.');
      expect(alert).toHaveTextContent('用时');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('tells a browser-side drawing failure apart from a network one', async () => {
      getDocument.mockReturnValue({
        promise: Promise.resolve(fakeDocument([FORM_PAGE])),
        destroy: vi.fn().mockResolvedValue(undefined),
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

      render(<PdfPreview url={URL} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('内存不足');
    });
  });

  describe('loading', () => {
    it('shows how much has arrived while the file downloads', async () => {
      const task: { promise: Promise<never>; destroy: () => Promise<void>; onProgress?: (event: { loaded: number; total: number }) => void } = {
        promise: new Promise(() => undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
      getDocument.mockReturnValue(task);

      render(<PdfPreview url={URL} />);
      expect(screen.getByRole('status')).toHaveTextContent('正在加载报销单…');
      await waitFor(() => expect(task.onProgress).toBeTypeOf('function'));

      act(() => task.onProgress!({ loaded: 512 * 1024, total: 2 * 1024 * 1024 }));
      expect(screen.getByRole('status')).toHaveTextContent('25%（512 KB / 2.0 MB）');

      act(() => task.onProgress!({ loaded: 300 * 1024, total: 0 }));
      expect(screen.getByRole('status')).toHaveTextContent('已收到 300 KB');
    });

    it('says the network is slow and offers a retry once nothing has arrived for a while', async () => {
      vi.useFakeTimers();
      getDocument.mockReturnValue({ promise: new Promise(() => undefined), destroy: vi.fn().mockResolvedValue(undefined) });

      render(<PdfPreview url={URL} />);
      expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(20_000); });

      expect(screen.getByRole('status')).toHaveTextContent('网络很慢');
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    });
  });

  describe('drawing', () => {
    it('draws only the form pages, numbers the sheets, and skips the receipt attachment pages', async () => {
      // 老批次只能拿到整份 PDF：报销单页、凭证附件页、报销单页、凭证附件页
      getDocument.mockReturnValue({
        promise: Promise.resolve(fakeDocument([FORM_PAGE, ATTACHMENT_PAGE, '备注续页：门店补充说明', FORM_PAGE, ATTACHMENT_PAGE])),
        destroy: vi.fn().mockResolvedValue(undefined),
      });

      const { container } = render(<PdfPreview url={URL} />);

      await waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(3));
      const canvases = [...container.querySelectorAll('canvas')];
      expect(canvases.map((canvas) => canvas.dataset.pageNumber)).toEqual(['1', '3', '4']);
      // 只有报销单页标 sheetIndex；备注续页画出来但不算一张报销单
      expect(canvases.map((canvas) => canvas.dataset.sheetIndex)).toEqual(['0', undefined, '1']);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('tells the caller each time a form sheet is on screen, and only for form sheets', async () => {
      getDocument.mockReturnValue({
        promise: Promise.resolve(fakeDocument([FORM_PAGE, ATTACHMENT_PAGE, '备注续页：门店补充说明', FORM_PAGE])),
        destroy: vi.fn().mockResolvedValue(undefined),
      });
      const onSheetDrawn = vi.fn();

      const { container } = render(<PdfPreview url={URL} onSheetDrawn={onSheetDrawn} />);

      await waitFor(() => expect(onSheetDrawn).toHaveBeenCalledTimes(2));
      // 画布已经放进页面里再通知（调用方马上要对它滚动）；备注续页、凭证附件页不通知
      expect(onSheetDrawn.mock.calls.map(([index]) => index)).toEqual([0, 1]);
      for (const [, canvas] of onSheetDrawn.mock.calls) {
        expect(container.contains(canvas as HTMLCanvasElement)).toBe(true);
      }
    });

    it('draws at least minWidth wide so the form stays readable on a phone, and scrolls instead of shrinking', async () => {
      getDocument.mockReturnValue({
        promise: Promise.resolve(fakeDocument([FORM_PAGE])),
        destroy: vi.fn().mockResolvedValue(undefined),
      });

      const { container } = render(<PdfPreview url={URL} minWidth={880} />);

      await waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(1));
      const canvas = container.querySelector('canvas')!;
      // 假页面 200 宽，按 880 画（jsdom 里 devicePixelRatio 是 1）；显示宽度也是 880px，不再缩到容器宽度
      expect(canvas.width).toBe(880);
      expect(canvas.style.width).toBe('880px');
    });

    it('fits the container width when no minimum is asked for', async () => {
      getDocument.mockReturnValue({
        promise: Promise.resolve(fakeDocument([FORM_PAGE])),
        destroy: vi.fn().mockResolvedValue(undefined),
      });

      const { container } = render(<PdfPreview url={URL} />);

      await waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(1));
      expect(container.querySelector('canvas')!.style.width).toBe('100%');
    });
  });
});
