import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument,
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('../api', () => ({ authHeaders: () => ({}) }));

import { PdfPreview } from './PdfPreview';

function refused(status: number) {
  return {
    promise: Promise.reject(Object.assign(new Error(`Unexpected server response (${status}) while retrieving PDF.`), { status })),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PDF preview failures', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    getDocument.mockReset();
  });

  it('shows the reason the server gives when it refuses the preview', async () => {
    getDocument.mockReturnValue(refused(409));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'LAYOUT_OUTDATED', message: '这张报销单是按旧版式生成的。请到「历史」页撤销本单，再重新生成。' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<PdfPreview url="http://api.test/api/batches/b1/preview.pdf" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('请到「历史」页撤销本单');
  });

  it('falls back to the generic message when the server gives no readable reason', async () => {
    getDocument.mockReturnValue(refused(502));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502 }));

    render(<PdfPreview url="http://api.test/api/batches/b1/preview.pdf" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('预览加载失败');
  });

  it('keeps the generic message for failures that are not server refusals', async () => {
    getDocument.mockReturnValue({
      promise: Promise.reject(new Error('Invalid PDF structure.')),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<PdfPreview url="http://api.test/api/batches/b1/preview.pdf" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('预览加载失败');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
