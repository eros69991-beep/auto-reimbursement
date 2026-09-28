import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receipt } from '../test/fixtures';

vi.mock('../api', () => ({
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  api: {
    receipts: vi.fn(),
    imageUrl: (id: string) => `/api/images/${id}`,
    receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    openAuthed: vi.fn(),
    updateReceipt: vi.fn(),
    confirmReceipt: vi.fn(),
    confirmDistinct: vi.fn(),
    retryReceipt: vi.fn(),
    setRefund: vi.fn(),
    addRefundImage: vi.fn(),
    deleteReceipt: vi.fn(),
  },
}));

import { api } from '../api';
import { PendingPage } from './PendingPage';

afterEach(cleanup);

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('PendingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.receipts.mockResolvedValue([
      receipt({
        id: 'a',
        status: 'pending',
        paidFen: null,
        category: null,
        recognizedFen: null,
        pendingReasons: ['amount_uncertain', 'category_uncertain'],
      }),
      receipt({
        id: 'duplicate',
        status: 'pending',
        pendingReasons: ['suspected_duplicate'],
        duplicateIds: ['historical-image'],
      }),
      receipt({ id: 'failed', status: 'pending', pendingReasons: ['api_failed'] }),
      receipt({ id: 'ready', status: 'ready', pendingReasons: [] }),
    ]);
    mockedApi.updateReceipt.mockResolvedValue(receipt({ id: 'a', status: 'pending' }));
    mockedApi.confirmReceipt.mockResolvedValue(receipt({ id: 'a' }));
    mockedApi.confirmDistinct.mockResolvedValue(receipt({ id: 'duplicate' }));
    mockedApi.retryReceipt.mockResolvedValue(receipt({ id: 'failed', status: 'recognizing' }));
    mockedApi.setRefund.mockResolvedValue(receipt());
    mockedApi.addRefundImage.mockResolvedValue(receipt());
    mockedApi.deleteReceipt.mockResolvedValue(undefined);
  });

  it('confirms the correction in a single atomic request (P-10)', async () => {
    render(<PendingPage />);

    expect(await screen.findByText('金额无法确定')).toBeInTheDocument();
    const amounts = screen.getAllByLabelText('最终实付金额');
    const categories = screen.getAllByLabelText('分类');
    expect(amounts[0]).toHaveValue('');
    expect(categories[0]).toHaveValue('');
    expect(categories[0]).toHaveTextContent('请选择分类');
    expect(categories[0]?.querySelectorAll('option')).toHaveLength(11);
    expect(screen.getAllByRole('button', { name: '全额退款' })[0]).toBeDisabled();
    expect(screen.getAllByRole('link', { name: /查看原图/ })[0]).toHaveAttribute(
      'href',
      '/api/images/image-a',
    );
    fireEvent.change(amounts[0]!, { target: { value: '36.33' } });
    fireEvent.change(categories[0]!, { target: { value: '耗材' } });
    fireEvent.click(screen.getAllByRole('button', { name: '确认可报销' })[0]!);

    // P-10：修改与确认合并为一次原子请求，不再先 PATCH 再 confirm
    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledWith('a', {
      paidFen: 3633,
      category: '耗材',
    }));
    expect(mockedApi.updateReceipt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('金额无法确定')).not.toBeInTheDocument());
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('shows only exception records with duplicate evidence and retry actions', async () => {
    render(<PendingPage />);

    expect(await screen.findByText('疑似重复')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看历史凭证' })).toHaveAttribute(
      'href',
      '/api/receipts/historical-image/original-image',
    );
    fireEvent.click(screen.getByRole('button', { name: '确认不是重复，继续加入' }));
    await waitFor(() => expect(mockedApi.confirmDistinct).toHaveBeenCalledWith('duplicate'));
    fireEvent.click(screen.getByRole('button', { name: '重试识别' }));
    await waitFor(() => expect(mockedApi.retryReceipt).toHaveBeenCalledWith('failed'));
  });

  it('keeps editor input visible when the confirm request fails', async () => {
    mockedApi.confirmReceipt.mockRejectedValueOnce(new Error('网络错误'));
    render(<PendingPage />);
    await screen.findByText('金额无法确定');
    fireEvent.change(screen.getAllByLabelText('最终实付金额')[0]!, { target: { value: '36.33' } });
    fireEvent.change(screen.getAllByLabelText('分类')[0]!, { target: { value: '耗材' } });
    fireEvent.click(screen.getAllByRole('button', { name: '确认可报销' })[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent('确认可报销失败：网络错误');
    expect(screen.getAllByLabelText('最终实付金额')[0]).toHaveValue('36.33');
  });

  it('keeps the receipt visible when confirmation fails and retries the same atomic request (P-10)', async () => {
    mockedApi.confirmReceipt.mockRejectedValueOnce(new Error('确认服务暂不可用'));
    render(<PendingPage />);
    await screen.findByText('金额无法确定');

    fireEvent.change(screen.getAllByLabelText('最终实付金额')[0]!, { target: { value: '36.33' } });
    fireEvent.change(screen.getAllByLabelText('分类')[0]!, { target: { value: '耗材' } });
    fireEvent.click(screen.getAllByRole('button', { name: '确认可报销' })[0]!);

    // 失败时凭证留在待处理列表中（不“失踪”），输入保留，可直接重试
    expect(await screen.findByRole('alert')).toHaveTextContent('确认可报销失败：确认服务暂不可用');
    expect(screen.getByText('金额无法确定')).toBeInTheDocument();
    expect(screen.getAllByLabelText('最终实付金额')[0]).toHaveValue('36.33');

    fireEvent.click(screen.getAllByRole('button', { name: '确认可报销' })[0]!);
    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledTimes(2));
    expect(mockedApi.confirmReceipt).toHaveBeenLastCalledWith('a', { paidFen: 3633, category: '耗材' });
    expect(mockedApi.updateReceipt).not.toHaveBeenCalled();
  });

  it('removes a deleted exception from the review list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PendingPage />);
    await screen.findByText('金额无法确定');

    fireEvent.click(screen.getAllByRole('button', { name: '删除凭证' })[0]!);

    await waitFor(() => expect(mockedApi.deleteReceipt).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.queryByText('金额无法确定')).not.toBeInTheDocument());
    confirm.mockRestore();
  });
});
