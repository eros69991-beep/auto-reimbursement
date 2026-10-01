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
    mergeReceipts: vi.fn(),
    splitReceipt: vi.fn(),
    progress: vi.fn(),
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

// 试点反馈 3：已经识别通过的几张，发现其实是同一单，也能在报销池里合并 / 拆开
describe('PoolPage merging screenshots of one order', () => {
  const ready = (id: string, order: number, fen: number, overrides: Parameters<typeof receipt>[0] = {}) => receipt({
    id,
    original: { ...receipt().original, id: `image-${id}` },
    uploadOrder: order,
    paidFen: fen,
    recognizedFen: fen,
    ...overrides,
  });
  let poolRows: ReturnType<typeof receipt>[];

  beforeEach(() => {
    vi.clearAllMocks();
    poolRows = [ready('x', 1, 1000), ready('y', 2, 2000), ready('z', 3, 3000), ready('w', 4, 4000)];
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? poolRows : []));
    mockedApi.totals.mockResolvedValue(totals);
    mockedApi.settings.mockResolvedValue(settings);
    mockedApi.mergeReceipts.mockResolvedValue(
      ready('m', 1, 0, { status: 'recognizing', mergedFrom: ['x', 'y'] }),
    );
    mockedApi.progress.mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 });
  });

  const merge = () => screen.getByRole('button', { name: '合并为一单' });

  it('offers merging only when two or three receipts are ticked', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });

    fireEvent.click(boxes[0]!);
    expect(screen.queryByRole('button', { name: '合并为一单' })).not.toBeInTheDocument();
    fireEvent.click(boxes[1]!);
    expect(merge()).not.toBeDisabled();
    fireEvent.click(boxes[2]!);
    expect(merge()).not.toBeDisabled();
    fireEvent.click(boxes[3]!);
    expect(screen.queryByRole('button', { name: '合并为一单' })).not.toBeInTheDocument();
  });

  it('merges the ticked receipts in list order and refreshes the pool when recognition ends', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[2]!);
    fireEvent.click(boxes[0]!);
    poolRows = [ready('m', 1, 58800, { mergedFrom: ['x', 'z'] }), ready('y', 2, 2000), ready('w', 4, 4000)];

    fireEvent.click(merge());

    await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['x', 'z']));
    await waitFor(() => expect(mockedApi.progress).toHaveBeenCalledWith(['m']));
    expect(await screen.findByText('合并完成，重新识别通过，已加入报销池。')).toBeInTheDocument();
    expect(screen.getByText('由 2 张截图合并（左右拼成一张图）')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '耗材 · 588.00' })).toBeInTheDocument();
    // 选择已清空
    expect(screen.getByText('已选 0 张 · 合计 0.00')).toBeInTheDocument();
  });

  it('points to the exception page when the merged picture still needs a person', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    poolRows = [ready('z', 3, 3000), ready('w', 4, 4000)];

    fireEvent.click(merge());

    expect(await screen.findByText('合并完成，这张还需要你确认，请到「异常处理」查看。')).toBeInTheDocument();
  });

  it('shows why a merge was refused', async () => {
    mockedApi.mergeReceipts.mockRejectedValue(new Error('所选凭证现在不能合并'));
    render(<PoolPage onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    fireEvent.click(merge());

    expect(await screen.findByRole('alert')).toHaveTextContent('所选凭证现在不能合并');
    // 失败后几张都还在，选择也还在
    expect(screen.getAllByRole('checkbox', { name: /^选择 / })).toHaveLength(4);
    expect(screen.getByText(/已选 2 张/)).toBeInTheDocument();
  });

  it('will not merge a receipt that was itself merged before, and tells the user to take it apart first', async () => {
    poolRows = [ready('m', 1, 58800, { mergedFrom: ['p', 'q'] }), ready('y', 2, 2000)];
    render(<PoolPage onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    const blocked = screen.getByRole('button', { name: '合并过的要先拆开' });
    expect(blocked).toBeDisabled();
    expect(mockedApi.mergeReceipts).not.toHaveBeenCalled();
  });

  it('takes a merged receipt apart after confirmation and reloads the pool', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    poolRows = [ready('m', 1, 58800, { mergedFrom: ['x', 'y'] })];
    mockedApi.splitReceipt.mockResolvedValue([ready('x', 1, 1000), ready('y', 2, 2000)]);
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');
    poolRows = [ready('x', 1, 1000), ready('y', 2, 2000)];

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    await waitFor(() => expect(mockedApi.splitReceipt).toHaveBeenCalledWith('m'));
    expect(await screen.findByText('已拆开，恢复成 2 张截图；还没确认的在「异常处理」里。')).toBeInTheDocument();
    expect(screen.queryByText('由 2 张截图合并（左右拼成一张图）')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /^选择 / })).toHaveLength(2);
    confirm.mockRestore();
  });

  it('leaves a merged receipt alone when taking it apart is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    poolRows = [ready('m', 1, 58800, { mergedFrom: ['x', 'y'] })];
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    expect(mockedApi.splitReceipt).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('has no 拆开 button on ordinary receipts', async () => {
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findAllByRole('checkbox', { name: /^选择 / });

    expect(screen.queryByRole('button', { name: '拆开' })).not.toBeInTheDocument();
  });
});
