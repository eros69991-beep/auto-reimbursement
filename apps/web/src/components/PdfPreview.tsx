import { useEffect, useRef, useState } from 'react';

/**
 * Renders every page of a PDF scaled to the container width, stacked
 * vertically. Replaces the browser PDF-plugin iframe, which clips wide
 * landscape pages on mobile Safari and offers no fit-to-width zoom.
 */
export function PdfPreview({ url }: { url: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    container.replaceChildren();
    setError(null);
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const loadingTask = pdfjs.getDocument({ url });
        const document_ = await loadingTask.promise;
        const width = container.clientWidth > 0 ? container.clientWidth : 600;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await document_.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio });
          const canvas = document.createElement('canvas');
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
          if (cancelled) return;
          container.appendChild(canvas);
        }
        await loadingTask.destroy();
      } catch {
        if (!cancelled) setError('预览加载失败，请使用下方链接打开或下载 PDF。');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div className="pdf-preview-stack" role="document" aria-label="完整报销 PDF 预览">
      <div ref={containerRef} />
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
}
