import { cleanup, render, screen } from '@testing-library/react';
import type { Batch } from '@auto-reimbursement/contracts';
import { afterEach, expect, it, vi } from 'vitest';

import { api } from '../api';
import { PreviewPage } from './PreviewPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const batch: Batch = {
  id: 'batch / 1',
  month: '2026-09',
  createdAt: '2026-09-15T00:00:00.000Z',
  totalFen: 3633,
  items: [],
  sheets: [],
  options: {
    department: '采购部',
    date: '2026-09-15',
    signerMode: 'text',
    signerName: '张三',
    signature: null,
  },
  notes: [],
  pdfPath: null,
  archivedAt: null,
};

it('loads preview and download PDFs from the configured API origin', async () => {
  vi.spyOn(api, 'batch').mockResolvedValue(batch);

  render(<PreviewPage batchId={batch.id} />);

  expect(await screen.findByTitle('完整报销 PDF 预览')).toHaveAttribute(
    'src',
    'http://127.0.0.1:3000/api/batches/batch%20%2F%201/preview.pdf?revision=0',
  );
  expect(screen.getByRole('link', { name: '打开或下载 PDF' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:3000/api/batches/batch%20%2F%201/preview.pdf',
  );
});
