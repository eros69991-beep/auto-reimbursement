import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Batch, Snapshot } from '@auto-reimbursement/contracts';
import { api } from '../api';
import { companyReceipt, receipt } from '../test/fixtures';
import { HistoryPage } from './HistoryPage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function snapshotOf(source: ReturnType<typeof receipt>): Snapshot {
  return {
    receiptId: source.id,
    uploadOrder: source.uploadOrder,
    category: source.category!,
    paidFen: source.paidFen!,
    refundFen: source.refundFen,
    netFen: source.paidFen! - source.refundFen,
    original: source.original,
    refundImages: [{ ...source.original, id: `refund-of-${source.id}` }],
  };
}

function batchOf(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch',
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 1_290_949,
    items: [snapshotOf(companyReceipt({ id: 'meat' }))],
    sheets: [],
    notes: [],
    options: { department: '武汉市火门里餐饮管理有限公司', date: null, signerMode: 'text', signerName: '', signature: null },
    pdfPath: 'file.pdf',
    archivedAt: null,
    ledger: 'company',
    ...overrides,
  };
}

describe('HistoryPage in the company ledger', () => {
  it('lists only the company payment forms, in company words', async () => {
    const history = vi.spyOn(api, 'history').mockResolvedValue([]);
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: '历史付款单' })).toBeInTheDocument();
    expect(await screen.findByText('暂无历史付款单。')).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith('company');
  });

  it('asks the way it always did on the store page', async () => {
    const history = vi.spyOn(api, 'history').mockResolvedValue([]);
    render(<HistoryPage onPreview={vi.fn()} />);

    expect(await screen.findByText('暂无历史报销单。')).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith();
  });

  it('shows the originals as 回单 and never offers refund pictures, which only the store has', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [batchOf()] }]);
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    const article = (await screen.findByText('合计：12909.49')).closest('article')!;
    expect(article).toHaveTextContent('原始回单');
    expect(within(article).getByRole('link', { name: '原件' })).toBeInTheDocument();
    expect(article).not.toHaveTextContent('退款凭证');
    expect(within(article).queryByRole('link', { name: '退款凭证' })).not.toBeInTheDocument();
  });

  it('keeps the refund pictures on the store page', async () => {
    const storeBatch = batchOf({ ledger: undefined, items: [snapshotOf(receipt({ id: 'a' }))] });
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [storeBatch] }]);
    render(<HistoryPage onPreview={vi.fn()} />);

    const article = (await screen.findByText('合计：12909.49')).closest('article')!;
    expect(article).toHaveTextContent('原始凭证');
    expect(within(article).getByRole('link', { name: '退款凭证' })).toBeInTheDocument();
  });

  it('opens the reconcile view of a batch', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [batchOf({ id: 'batch-active' })] }]);
    const onPreview = vi.fn();
    render(<HistoryPage ledger="company" onPreview={onPreview} />);

    fireEvent.click(await screen.findByRole('button', { name: '对账 / 查看' }));

    expect(onPreview).toHaveBeenCalledWith('batch-active');
  });

  it('cancels a payment form after confirmation, with company words everywhere', async () => {
    const batch = batchOf();
    vi.spyOn(api, 'history')
      .mockResolvedValueOnce([{ month: '2026-09', batches: [batch] }])
      .mockResolvedValue([{ month: '2026-09', batches: [{ ...batch, cancelledAt: '2026-09-27' }] }]);
    const cancel = vi.spyOn(api, 'cancelBatch').mockResolvedValue({ ...batch, cancelledAt: '2026-09-27' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '撤销本单付款' }));

    expect(confirm).toHaveBeenCalledWith('撤销后票据将退回本次付款池，已生成的 PDF 仅保留为作废件。确定撤销本单付款吗？');
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('batch'));
    expect(await screen.findByText('已撤销，票据已退回本次付款池。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /作废 PDF/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销本单报销' })).not.toBeInTheDocument();
  });

  it('does not cancel when the user says no', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [batchOf()] }]);
    const cancel = vi.spyOn(api, 'cancelBatch').mockResolvedValue(batchOf());
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '撤销本单付款' }));

    expect(cancel).not.toHaveBeenCalled();
  });

  it('archives and unarchives only the company month', async () => {
    const history = vi.spyOn(api, 'history').mockResolvedValueOnce([{ month: '2026-09', batches: [batchOf()] }])
      .mockResolvedValueOnce([{ month: '2026-09', batches: [batchOf({ archivedAt: '2026-10-01' })] }])
      .mockResolvedValue([{ month: '2026-09', batches: [batchOf()] }]);
    const archive = vi.spyOn(api, 'archive').mockResolvedValue({ affected: 1 });
    const unarchive = vi.spyOn(api, 'unarchive').mockResolvedValue({ affected: 1 });
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '归档本月' }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('2026-09', 'company'));
    fireEvent.click(await screen.findByRole('button', { name: '取消归档' }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith('2026-09', 'company'));
    // 每次操作后重新取的也是公账的历史
    await waitFor(() => expect(history).toHaveBeenCalledTimes(3));
    expect(history.mock.calls.every(([ledger]) => ledger === 'company')).toBe(true);
  });

  it('cleans the originals of a company month only after the exact phrase is typed, and says what it deletes', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [batchOf({ archivedAt: '2026-10-01' })] }]);
    const cleanup = vi.spyOn(api, 'cleanup').mockResolvedValue({ affected: 1 });
    render(<HistoryPage ledger="company" onPreview={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '清理原始图片' }));
    const dialog = screen.getByRole('dialog', { name: '确认清理原始图片' });
    expect(dialog).toHaveTextContent('此操作仅删除已归档付款单的原始回单图片，不会删除 PDF。');
    expect(dialog).not.toHaveTextContent('退款凭证');
    expect(within(dialog).getByRole('button', { name: '确认清理' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('请输入 DELETE ORIGINALS 2026-09'), { target: { value: 'DELETE ORIGINALS 2026-09' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }));

    await waitFor(() => expect(cleanup).toHaveBeenCalledWith('2026-09', 'DELETE ORIGINALS 2026-09', 'company'));
  });

  it('keeps the store clean-up text for the store page', async () => {
    vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-09', batches: [batchOf({ ledger: undefined, archivedAt: '2026-10-01' })] }]);
    render(<HistoryPage onPreview={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '清理原始图片' }));

    expect(screen.getByRole('dialog', { name: '确认清理原始图片' })).toHaveTextContent('此操作仅删除已归档报销单的原始付款图片，不会删除退款凭证或 PDF。');
  });
});
