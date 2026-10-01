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
    openAuthed: vi.fn(),
    confirmReceipt: vi.fn(),
    deleteReceipt: vi.fn(),
  },
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
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
      // 旧数据：实付 20.00、已登记退款 20.00 → 实际花了 0.00，不能报销
      receipt({ id: 'refunded', merchant: 'refunded', paidFen: 2000, refundFen: 2000 }),
    ]);
    mockedApi.totals.mockResolvedValue(totals);
    mockedApi.settings.mockResolvedValue(settings);
    mockedApi.createBatch.mockResolvedValue({ id: 'batch-1' });
    mockedApi.deleteReceipt.mockResolvedValue(undefined);
  });

  it('shows backend totals and creates a batch from selected positive-net receipts', async () => {
    const onBatch = vi.fn();
    render(<PoolPage onBatch={onBatch} />);

    expect(await screen.findByText('可报销笔数：1')).toBeInTheDocument();
    expect(screen.getByText('合计：36.33')).toBeInTheDocument();
    expect(screen.getByText('食材：0.00')).toBeInTheDocument();
    expect(screen.getByText('员工餐：0.00')).toBeInTheDocument();
    // 勾选框用「分类 · 金额」命名，不再用商户名或内部编号
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 36.33' })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 0.00' })).toBeDisabled();
    expect(screen.getByText('已扣除退款 20.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 耗材 · 36.33' }));
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

  it('does not create an empty batch, and each card shows a single amount instead of original/refund/net rows', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');
    fireEvent.click(screen.getByRole('button', { name: '生成报销单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请选择至少一张可报销凭证');
    expect(mockedApi.createBatch).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '耗材 · 36.33' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '耗材 · 0.00' })).toBeInTheDocument();
    expect(screen.queryByText(/原金额|已退款|净额/)).not.toBeInTheDocument();
    expect(screen.queryByText(/示例商户|refunded/)).not.toBeInTheDocument();
  });

  it('removes a deleted receipt and clears its batch selection', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 耗材 · 36.33' }));
    // P-13：编辑器默认收起，先展开
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '删除凭证' })[0]!);

    await waitFor(() => expect(mockedApi.deleteReceipt).toHaveBeenCalledWith('eligible'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 耗材 · 36.33' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '生成报销单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择至少一张可报销凭证');
    expect(mockedApi.createBatch).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('refreshes backend totals and the row label after an edit is confirmed', async () => {
    mockedApi.totals.mockReset()
      .mockResolvedValueOnce(totals)
      .mockResolvedValue({
        ...totals,
        totalFen: 2000,
        byCategory: { ...totals.byCategory, 耗材: 2000 },
      });
    // 有退款的账单现在直接把金额改成实际花的钱：36.33 → 20.00
    mockedApi.confirmReceipt.mockResolvedValue(receipt({ id: 'eligible', paidFen: 2000, refundFen: 0 }));
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('合计：36.33');

    // P-13：编辑器默认收起，先展开
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledWith(
      'eligible',
      { paidFen: 2000, category: '耗材', date: '2026-09-02' },
    ));
    await waitFor(() => expect(mockedApi.totals).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('合计：20.00')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 20.00' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '耗材 · 20.00' })).toBeInTheDocument();
  });

  it('keeps the editor collapsed until 编辑 is clicked (P-13)', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');

    expect(screen.queryByLabelText('最终实付金额')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    expect(screen.getByLabelText('最终实付金额')).toBeInTheDocument();
    // 编辑框里没有商户和退款
    expect(screen.queryByLabelText('商户')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('退款金额')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起编辑' }));
    expect(screen.queryByLabelText('最终实付金额')).not.toBeInTheDocument();
  });

  it('selects all eligible receipts and shows the sticky selection summary (P-13)', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('可报销笔数：1');

    expect(screen.getByText('已选 0 张 · 合计 0.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选可报销' }));
    expect(screen.getByText('已选 1 张 · 合计 36.33')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 36.33' })).toBeChecked();
    // 净额为 0 的凭证不可选，不会被全选带进来
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 0.00' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: '全选可报销' }));
    expect(screen.getByRole('checkbox', { name: '选择 耗材 · 36.33' })).not.toBeChecked();
    expect(screen.getByText('已选 0 张 · 合计 0.00')).toBeInTheDocument();
  });
});
