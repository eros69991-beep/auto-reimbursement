import { useEffect, useRef, useState } from 'react';

import { authHeaders } from '../api';

// 预览请求被服务器拒绝时，再取一次看它返回的说明；取不到就返回 null，由调用方用通用提示。
async function serverReason(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (response.ok) return null;
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    return typeof body?.message === 'string' && body.message !== '' ? body.message : null;
  } catch {
    return null;
  }
}

/**
 * Renders every page of a PDF scaled to the container width, stacked
 * vertically. Replaces the browser PDF-plugin iframe, which clips wide
 * landscape pages on mobile Safari and offers no fit-to-width zoom.
 *
 * 使用 pdfjs-dist 的 legacy 构建：现代构建依赖 Map.prototype.getOrInsertComputed，
 * 在 Chrome < 145、iOS Safari < 26.2、微信/国产浏览器内核上会整块失败。
 */
export function PdfPreview({ url }: { url: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    let loadingTask: { destroy(): Promise<void> } | null = null;
    container.replaceChildren();
    setError(null);
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ url, httpHeaders: authHeaders() });
        loadingTask = task;
        const document_ = await task.promise;
        const width = container.clientWidth > 0 ? container.clientWidth : 600;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        let sheetIndex = 0;
        for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await document_.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio });
          const canvas = document.createElement('canvas');
          canvas.dataset.pageNumber = String(pageNumber);
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.border = '1px solid #d9e0ea';
          canvas.style.marginBottom = '0.5rem';
          canvas.style.background = '#fff';
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('CANVAS_UNAVAILABLE');
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          // 标出第几张报销单（data-sheet-index），供对账区按报销单跳转。
          // 备注续页、凭证附件页夹在报销单之间，不能用页码推算。
          const content = await page.getTextContent();
          const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
          if (text.includes('单据及附件共') && text.includes('会计主管')) {
            canvas.dataset.sheetIndex = String(sheetIndex);
            sheetIndex += 1;
          }
          if (cancelled) return;
          container.appendChild(canvas);
        }
        await task.destroy();
        loadingTask = null;
      } catch (cause) {
        console.error('[PdfPreview] 加载失败', cause);
        if (cancelled) return;
        // 服务器拒绝时（例如旧版式的草稿要撤销重做）把它给的原因告诉用户，而不是笼统的「加载失败」
        const status = (cause as { status?: unknown } | null)?.status;
        const reason = typeof status === 'number' && status >= 400 ? await serverReason(url) : null;
        if (!cancelled) setError(reason ?? '预览加载失败，请使用下方链接打开或下载 PDF。');
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [url]);

  return (
    <div className="pdf-preview-stack" role="document" aria-label="完整报销 PDF 预览">
      <div ref={containerRef} />
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
}
