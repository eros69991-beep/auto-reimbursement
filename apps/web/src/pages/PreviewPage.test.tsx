import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Batch } from '@auto-reimbursement/contracts';
import { afterEach, expect, it, vi } from 'vitest';

import { api } from '../api';
import { PreviewPage } from './PreviewPage';

const pdfPreview = vi.hoisted(() => vi.fn());
vi.mock('../components/PdfPreview', () => ({
  PdfPreview: (props: { url: string }) => {
    pdfPreview(props);
    return <div data-testid="pdf-preview" data-url={props.url} />;
  },
}));

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

  expect((await screen.findByTestId('pdf-preview')).dataset.url).toBe(
    'http://127.0.0.1:3000/api/batches/batch%20%2F%201/preview.pdf?revision=0',
  );
  expect(screen.getByRole('link', { name: '打开或下载 PDF' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:3000/api/batches/batch%20%2F%201/preview.pdf',
  );
});

it('offers cancel-and-recreate for a finalized batch instead of editable fields', async () => {
  vi.spyOn(api, 'batch').mockResolvedValue({ ...batch, pdfPath: 'saved.pdf' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const cancel = vi.spyOn(api, 'cancelBatch').mockResolvedValue({ ...batch, pdfPath: 'saved.pdf', cancelledAt: '2026-09-22' });

  render(<PreviewPage batchId={batch.id} />);

  expect(await screen.findByRole('group', { name: '报销单选项' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '撤销并退回报销池' }));
  expect(await screen.findByText(/已定稿/)).toBeInTheDocument();
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(batch.id));
});
