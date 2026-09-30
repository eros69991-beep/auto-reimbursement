import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Batch } from '@auto-reimbursement/contracts';

// P-29：必须 mock api 模块——渲染真实 App 会真的请求 127.0.0.1:3000，
// 请求在测试环境销毁后失败，产生 “window is not defined” 的 Unhandled Errors
const { batchApi, historyApi } = vi.hoisted(() => ({ batchApi: vi.fn(), historyApi: vi.fn() }));

vi.mock('./api', () => ({
  UNAUTHORIZED_EVENT: 'api:unauthorized',
  api: {
    batch: batchApi,
    history: historyApi,
    saveBatchOptions: vi.fn(),
    createBatchNote: vi.fn(),
    updateBatchNote: vi.fn(),
    moveGroup: vi.fn(),
    exportBatch: vi.fn(),
    cancelBatch: vi.fn(),
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed: vi.fn(),
}));

vi.mock('./components/PdfPreview', () => ({
  PdfPreview: ({ url }: { url: string }) => <div data-testid="pdf-preview" data-url={url} />,
}));

import App from './App';

const loadedBatch: Batch = {
  id: 'batch-1',
  month: '2026-09',
  createdAt: '2026-09-26T00:00:00.000Z',
  totalFen: 0,
  items: [],
  sheets: [],
  options: {
    department: '武汉测试店',
    date: '2026-09-26',
    signerMode: 'text',
    signerName: '测试报销人甲',
    signature: null,
  },
  notes: [],
  pdfPath: null,
  archivedAt: null,
};

describe('App', () => {
  beforeEach(() => {
    batchApi.mockResolvedValue(loadedBatch);
  });

  it('shows the automatic reimbursement assistant title', () => {
    window.location.hash = '#home';
    render(<App />);

    expect(
      screen.getByRole('heading', { name: '自动报销助手' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传凭证' })).toBeInTheDocument();
  });

  it('jumps from #preview to the latest unfinalized draft (drafts carry no cancelledAt field)', async () => {
    const finalized = { ...loadedBatch, id: 'batch-final', createdAt: '2026-09-27T00:00:00.000Z', pdfPath: '2026-09/exports/x.pdf' };
    const cancelled = { ...loadedBatch, id: 'batch-cancelled', createdAt: '2026-09-28T00:00:00.000Z', cancelledAt: '2026-09-28T01:00:00.000Z' };
    historyApi.mockResolvedValue([{ month: '2026-09', batches: [cancelled, finalized, loadedBatch] }]);
    window.location.hash = '#preview';
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe('#batches/batch-1/preview'));
  });

  it('opens a batch preview from its hash route', async () => {
    window.location.hash = '#batches/batch-1/preview';
    render(<App />);
    expect(await screen.findByRole('heading', { name: '生成预览' })).toBeInTheDocument();
  });
});
