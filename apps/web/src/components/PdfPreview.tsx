import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Ledger } from '@auto-reimbursement/contracts';

import { authHeaders } from '../api';
import { sayFor, type Say } from '../wording';

// 预览请求被服务器拒绝时，再取一次看它返回的说明；取不到就返回 null，由调用方按状态码给通用说明。
// 第二次请求如果成功了（说明上一次只是偶发故障），马上取消，不去下载整份 PDF。
async function serverReason(url: string): Promise<string | null> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    if (response.ok) {
      controller.abort();
      return null;
    }
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    return typeof body?.message === 'string' && body.message !== '' ? body.message : null;
  } catch {
    return null;
  }
}

// 超过这么久没收到新的数据，就提示「网络很慢」并露出重试按钮（连接卡住时 pdf.js 自己不会报错）
const STALL_MS = 15_000;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) return `访问码不对或已失效（${status}），请重新输入访问码。`;
  if (status === 404) return '找不到这张报销单的文件（404），可能已被清理。';
  if (status === 429) return `请求太频繁了（${status}），请稍等一会儿再点「重试」。`;
  if (status === 502 || status === 503 || status === 504) return `服务器暂时没有响应（${status}），可能正在重启或网络不通，请稍后点「重试」。`;
  if (status >= 500) return `服务器出错了（${status}），请稍后点「重试」。`;
  return `服务器拒绝了这次请求（${status}）。`;
}

interface Failure {
  /** 给用户看的一句话原因 */
  message: string;
  /** 给开发者看的细节（错误名、堆栈前几行、状态码、用时、浏览器），用户截图发过来即可 */
  detail: string;
}

// 错误堆栈的前几行（去掉域名）：遇到看不懂的失败时，能直接看出是哪一段代码抛的，不用再靠猜。
// V8 的堆栈第一行是「名字: 说明」（上面已经列过），JavaScriptCore（Safari）的没有，所以和它相同的行不重复显示。
function stackLines(cause: unknown, firstLine: string): string[] {
  const stack = typeof cause === 'object' && cause !== null && 'stack' in cause && typeof cause.stack === 'string' ? cause.stack : '';
  return stack
    .split('\n')
    .map((line) => line.trim().replace(/https?:\/\/[^/\s)]+/g, ''))
    .filter((line) => line !== '' && line !== firstLine)
    .slice(0, 4)
    .map((line) => `  ${line}`);
}

/**
 * 把各种失败翻成一句人话：服务器自己说明了原因就用它的；否则按状态码、网络中断、浏览器不支持分别说清，
 * 不再对所有情况都只说「加载失败」。
 */
async function explainFailure(cause: unknown, url: string, progress: { loaded: number; total: number }, startedAt: number): Promise<Failure> {
  const info = (typeof cause === 'object' && cause !== null ? cause : {}) as { name?: unknown; message?: unknown; status?: unknown };
  const name = typeof info.name === 'string' && info.name !== '' ? info.name : 'Error';
  const text = typeof info.message === 'string' ? info.message : String(cause);
  const status = typeof info.status === 'number' ? info.status : null;
  const detail = [
    `${name}: ${text}`,
    ...stackLines(cause, `${name}: ${text}`),
    status === null ? null : `状态码 ${status}`,
    `已下载 ${formatBytes(progress.loaded)}${progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ''}`,
    `用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
    typeof navigator === 'undefined' ? null : navigator.userAgent,
  ].filter((line): line is string => line !== null).join('\n');

  let reason: string;
  if (status !== null && status >= 400) {
    reason = (await serverReason(url)) ?? messageForStatus(status);
  } else if (name === 'InvalidPDFException') {
    reason = '这份 PDF 文件内容不完整或已损坏，请点「重试」；仍不行请用下方链接下载后查看。';
  } else if (/failed to fetch|load failed|networkerror|network error|network request failed|unknownerrorexception|abort/i.test(`${name} ${text}`)) {
    reason = '网络中断或连不上服务器，请检查网络后点「重试」。';
  } else if (/CANVAS_UNAVAILABLE|canvas|out of memory|allocation/i.test(text)) {
    reason = '手机内存不足，画不出这张报销单，请关闭其他网页后点「重试」。';
  } else if (/worker|import|module|script|chunk/i.test(`${name} ${text}`)) {
    reason = '预览组件没有加载下来（网络不稳或浏览器版本太旧），请刷新页面后再试。';
  } else {
    reason = '浏览器没能显示这份 PDF，请点「重试」；仍不行请用下方链接打开或下载。';
  }
  return { message: `预览加载失败：${reason}`, detail };
}

// 完整 PDF 里夹着每张报销单的凭证附件页（页眉写「第 N 张报销单 · … 原始凭证/退款凭证」，公账区是「第 N 张付款单」）。
// 对账区左边只看报销单，凭证图在另一边单独看，所以附件页不画——老批次的预览只能拿到整份 PDF 时，
// 这样既省内存也不会满屏凭证。
function isAttachmentPage(text: string): boolean {
  return !text.includes('单据及附件共') && /张(?:报销|付款)单/.test(text) && /原始凭证|退款凭证/.test(text);
}

/**
 * 读出一页上的全部文字，用来认这页是报销单还是凭证附件页。
 *
 * 不能用 page.getTextContent()：pdf.js 6 里它是 `for await (const chunk of stream)` 实现的，而 Safari 到 26.x
 * （iPhone 上的 18.x 也一样）的 ReadableStream 还不支持 for await（Safari 27 才补上），一调用就抛
 * TypeError「undefined is not a function (near '...i of e...')」，整张预览都会加载失败。
 * 所以直接对 streamTextContent() 用 reader.read() 一块块读，所有浏览器都能跑。
 */
async function pageText(page: PDFPageProxy): Promise<string> {
  const reader = (page.streamTextContent() as ReadableStream<{ items: Array<{ str?: unknown }> }>).getReader();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str === 'string') text += item.str;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

type Status =
  | { kind: 'loading'; loaded: number; total: number; stalled: boolean }
  | { kind: 'drawing'; page: number; pages: number }
  | { kind: 'done' }
  | { kind: 'error'; failure: Failure };

function statusLine(status: Status, say: Say): string | null {
  if (status.kind === 'loading') {
    if (status.stalled) return say('网络很慢，还在加载报销单……可以点「重试」。');
    if (status.loaded <= 0) return say('正在加载报销单…');
    if (status.total > 0) {
      return `${say('正在加载报销单…')} ${Math.min(100, Math.floor((status.loaded / status.total) * 100))}%（${formatBytes(status.loaded)} / ${formatBytes(status.total)}）`;
    }
    return `${say('正在加载报销单…')} 已收到 ${formatBytes(status.loaded)}`;
  }
  if (status.kind === 'drawing') return `${say('正在画报销单…')} 第 ${status.page}/${status.pages} 页`;
  return null;
}

/**
 * Renders every page of a PDF scaled to the container width, stacked
 * vertically. Replaces the browser PDF-plugin iframe, which clips wide
 * landscape pages on mobile Safari and offers no fit-to-width zoom.
 *
 * 使用 pdfjs-dist 的 legacy 构建：现代构建依赖 Map.prototype.getOrInsertComputed，
 * 在 Chrome < 145、iOS Safari < 26.2、微信/国产浏览器内核上会整块失败。
 *
 * 加载中显示进度，失败时说明原因并给「重试」（网络不好时报销单预览是最容易出问题的地方）。
 *
 * minWidth：每页至少画这么宽（CSS 像素）。报销单是 270×165mm 的横版，缩到手机宽度（约 390px）字只剩 5px 左右，
 * 根本看不清；给个最小宽度，窄屏上让外层容器横向滚动，字就是能读的大小。不给则一律缩放到容器宽度。
 * onSheetDrawn：每画好一张报销单页（不含备注续页、凭证页）调用一次，对账区据此在预览晚到时仍能跳到当前凭证所在的那张。
 */
export function PdfPreview({
  url,
  minWidth = 0,
  onSheetDrawn,
  ledger = 'store',
}: {
  url: string;
  minWidth?: number;
  onSheetDrawn?: (sheetIndex: number, canvas: HTMLCanvasElement) => void;
  /** 公账批次的单据叫付款单，提示文字跟着换；不给就是店内 */
  ledger?: Ledger;
}): React.JSX.Element {
  const say = sayFor(ledger);
  const containerRef = useRef<HTMLDivElement>(null);
  const onSheetDrawnRef = useRef(onSheetDrawn);
  useEffect(() => {
    onSheetDrawnRef.current = onSheetDrawn;
  });
  const [status, setStatus] = useState<Status>({ kind: 'loading', loaded: 0, total: 0, stalled: false });
  // 点「重试」就加一，重新跑一遍加载；第二次起在地址后加个参数，绕开浏览器里可能残留的半截缓存
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    let loadingTask: { destroy(): Promise<void> } | null = null;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    const progress = { loaded: 0, total: 0 };
    const requestUrl = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
    container.replaceChildren();
    setStatus({ kind: 'loading', loaded: 0, total: 0, stalled: false });
    const stallTimer = window.setInterval(() => {
      if (Date.now() - lastProgressAt > STALL_MS) {
        setStatus((current) => (current.kind === 'loading' && !current.stalled ? { ...current, stalled: true } : current));
      }
    }, 2000);
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ url: requestUrl, httpHeaders: authHeaders() });
        loadingTask = task;
        task.onProgress = (event: { loaded: number; total: number }) => {
          progress.loaded = event.loaded;
          progress.total = event.total;
          lastProgressAt = Date.now();
          if (!cancelled) setStatus({ kind: 'loading', loaded: event.loaded, total: event.total, stalled: false });
        };
        const document_ = await task.promise;
        window.clearInterval(stallTimer);
        const width = Math.max(container.clientWidth > 0 ? container.clientWidth : 600, minWidth);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        let sheetIndex = 0;
        for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
          if (cancelled) return;
          setStatus({ kind: 'drawing', page: pageNumber, pages: document_.numPages });
          const page = await document_.getPage(pageNumber);
          // 先看这页写了什么：附件页不画；报销单页（含「单据及附件共」「会计主管」）标出第几张，供对账区按报销单跳转。
          // 备注续页夹在报销单之间，不能用页码推算。
          let text = '';
          try {
            text = await pageText(page);
          } catch (cause) {
            // 读不出文字只是认不出页面类型，不是预览失败：照样把这页画出来，只是不标「第几张报销单」、也没法跳过附件页
            if (cancelled) return;
            console.warn(`[PdfPreview] 读不出第 ${pageNumber} 页的文字，按普通页直接画出`, cause);
          }
          if (isAttachmentPage(text)) continue;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio });
          const canvas = document.createElement('canvas');
          canvas.dataset.pageNumber = String(pageNumber);
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          // 容器够宽时撑满容器；容器比最小宽度还窄（手机）时按最小宽度画，由外层横向滚动
          canvas.style.width = minWidth > 0 && container.clientWidth < minWidth ? `${minWidth}px` : '100%';
          canvas.style.height = 'auto';
          canvas.style.border = '1px solid #d9e0ea';
          canvas.style.marginBottom = '0.5rem';
          canvas.style.background = '#fff';
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('CANVAS_UNAVAILABLE');
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          let drawnSheet: number | null = null;
          if (text.includes('单据及附件共') && text.includes('会计主管')) {
            canvas.dataset.sheetIndex = String(sheetIndex);
            drawnSheet = sheetIndex;
            sheetIndex += 1;
          }
          if (cancelled) return;
          container.appendChild(canvas);
          if (drawnSheet !== null) onSheetDrawnRef.current?.(drawnSheet, canvas);
        }
        await task.destroy();
        loadingTask = null;
        if (!cancelled) setStatus({ kind: 'done' });
      } catch (cause) {
        console.error('[PdfPreview] 加载失败', cause);
        window.clearInterval(stallTimer);
        if (cancelled) return;
        const failure = await explainFailure(cause, requestUrl, progress, startedAt);
        if (!cancelled) setStatus({ kind: 'error', failure: { ...failure, message: say(failure.message) } });
      }
    })();
    return () => {
      cancelled = true;
      window.clearInterval(stallTimer);
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [url, attempt, minWidth, say]);

  const line = statusLine(status, say);
  return (
    <div className="pdf-preview-stack" role="document" aria-label={say('完整报销 PDF 预览')} aria-busy={status.kind === 'loading' || status.kind === 'drawing'}>
      {line !== null && (
        <p className="pdf-preview-status" role="status">
          {line}
          {status.kind === 'loading' && status.stalled && (
            <>
              {' '}
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
            </>
          )}
        </p>
      )}
      <div ref={containerRef} />
      {status.kind === 'error' && (
        <div className="pdf-preview-error" role="alert">
          <p>{status.failure.message}</p>
          <p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          </p>
          <details>
            <summary>技术细节（反馈问题时请截图）</summary>
            <pre>{status.failure.detail}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
