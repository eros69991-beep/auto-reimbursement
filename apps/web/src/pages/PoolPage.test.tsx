import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receipt, settings, totals } from '../test/fixtures';

vi.mock('../api', () => ({
  formOptionsFromSettings: (value: typeof settings) => ({
    department: value.department,
    date: value.dateMode === 'blank' ? null : value.customDate,
    signerMode: value.signerMode,
    signerName: value.signerName,
    signature: null,
  }),
  api: {
    receipts: vi.fn(),
    totals: vi.fn(),
    settings: vi.fn(),
    createBatch: vi.fn(),
    imageUrl: (id: string) => `/api/images/${id}`,
    setRefund: vi.fn(),
    addRefundImage: vi.fn(),
    deleteReceipt: vi.fn(),
  },
}));

import { api } from '../api';
import { PoolPage } from './PoolPage';

afterEach(cleanup);

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('PoolPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.receipts.mockResolvedValue([
      receipt({ id: 'eligible', paidFen: 3633, refundFen: 0 }),
      receipt({ id: 'refunded', merchant: 'refunded', paidFen: 2000, refundFen: 2000 }),
    ]);
    mockedApi.totals.mockResolvedValue(totals);
    mockedApi.settings.mockResolvedValue(settings);
    mockedApi.createBatch.mockResolvedValue({ id: 'batch-1' });
    mockedApi.setRefund.mockResolvedValue(receipt());
    mockedApi.addRefundImage.mockResolvedValue(receipt());
    mockedApi.deleteReceipt.mockResolvedValue(undefined);
  });

  it('shows backend totals and creates a batch from selected positive-net receipts', async () => {
    const onBatch = vi.fn();
    render(<PoolPage onBatch={onBatch} />);

    expect(await screen.findByText('可报销笔数：1')).toBeInTheDocument();
    expect(screen.getByText('合计：36.33')).toBeInTheDocument();
    expect(screen.getByText('食材：0.00')).toBeInTheDocument();
    expect(screen.getByText('员工餐：0.00')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /示例商户/ })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /refunded/ })).toBeDisabled();
    expect(screen.getByLabelText('已退款：20.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /示例商户/ }));
    fireEvent.click(screen.getByRole('button', { name: '生成报销单' }));
    await waitFor(() => expect(mockedApi.createBatch).toHaveBeenCalledWith(['eligible'], {
      department: '采购部',
      date: '2026-09-10',
      signerMode: 'text',
      signerName: '张三',
      signature: null,
    }));
    expect(onBatch).toHaveBeenCalledWith('batch-1');
  });

  it('does not create an empty batch and exposes original/refund amounts separately', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');
    fireEvent.click(screen.getByRole('button', { name: '生成报销单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请选择至少一张可报销凭证');
    expect(mockedApi.createBatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('原金额：20.00')).toBeInTheDocument();
    expect(screen.getByLabelText('净额：0.00')).toBeInTheDocument();
  });

  it('removes a deleted receipt and clears its batch selection', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');

    fireEvent.click(screen.getByRole('checkbox', { name: /示例商户/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '删除凭证' })[0]!);

    await waitFor(() => expect(mockedApi.deleteReceipt).toHaveBeenCalledWith('eligible'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /示例商户/ })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '生成报销单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择至少一张可报销凭证');
    expect(mockedApi.createBatch).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
