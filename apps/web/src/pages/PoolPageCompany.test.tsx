import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companyNotice, companyReceipt, companyTotals, settings } from '../test/fixtures';

vi.mock('../api', () => ({
  // 和真实实现一样：公账区的付款单位取 companyDepartment，不借用店内的部门
  formOptionsFromSettings: (value: typeof settings, _now: Date, ledger = 'store') => ({
    department: ledger === 'company' ? (value.companyDepartment ?? '') : value.department,
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
    setPoolMembership: vi.fn(),
    restoreReceipt: vi.fn(),
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

const companySettings = { ...settings, department: '店内的部门', companyDepartment: '武汉市火门里餐饮管理有限公司' };

describe('PoolPage in the company ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? [companyReceipt({ id: 'meat', status: 'ready' }), companyNotice({ status: 'ready' })] : []));
    mockedApi.totals.mockResolvedValue(companyTotals);
    mockedApi.settings.mockResolvedValue(companySettings);
    mockedApi.createBatch.mockResolvedValue({ id: 'batch-9' });
  });

  it('asks only for the company ledger: the list, the totals and every later refresh', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    expect(mockedApi.receipts).toHaveBeenCalledWith('pool', 'company');
    expect(mockedApi.totals).toHaveBeenCalledWith('company');
    expect(mockedApi.receipts).not.toHaveBeenCalledWith('pool');
    expect(mockedApi.totals).not.toHaveBeenCalledWith();
  });

  it('keeps the store page asking the way it always did', async () => {
    mockedApi.receipts.mockResolvedValue([]);
    render(<PoolPage onBatch={vi.fn()} />);
    await screen.findByRole('heading', { name: '报销池' });

    await waitFor(() => expect(mockedApi.receipts).toHaveBeenCalledWith('pool'));
    expect(mockedApi.totals).toHaveBeenCalledWith();
  });

  it('shows the payment pool with company words and company categories only', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: '付款池' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: '付款池汇总' });
    expect(summary).toHaveTextContent('可付款笔数：2');
    expect(summary).toHaveTextContent('合计：52471.12');
    for (const [category, amount] of [['肉款', '12909.49'], ['品牌管理费', '0.00'], ['店面租金', '22814.10'], ['物业费', '5069.80'], ['水费', '48.86'], ['电费', '11466.87'], ['空调能源费', '162.00'], ['其他公账支出', '0.00']] as const) {
      expect(within(summary).getByText(`${category}：${amount}`)).toBeInTheDocument();
    }
    expect(within(summary).queryByText(/食材|耗材|能耗费|员工餐/)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '全选可付款' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成付款单' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成报销单' })).not.toBeInTheDocument();
    expect(screen.queryByText(/报销|凭证/)).not.toBeInTheDocument();
  });

  it('shows a one-item receipt by category and a notice by its items and payee', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: '肉款 · 12909.49' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '含 5 项 · 39561.63' })).toBeInTheDocument();
    const items = screen.getByRole('list', { name: '收费项目' });
    expect(items).toHaveTextContent('店面租金（2026年9月） 22814.10');
    expect(items).toHaveTextContent('电费（2026年7月） 11466.87');
    expect(screen.getAllByRole('definition').map((node) => node.textContent)).toContain('9876543210987654321');
    expect(screen.getAllByText('可付款')).toHaveLength(2);
  });

  it('creates a payment form from the ticked receipts with the company payer, never the store department', async () => {
    const onBatch = vi.fn();
    render(<PoolPage ledger="company" onBatch={onBatch} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 肉款 · 12909.49' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 含 5 项 · 39561.63' }));
    expect(screen.getByText('已选 2 张 · 合计 52471.12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成付款单' }));

    await waitFor(() => expect(mockedApi.createBatch).toHaveBeenCalledWith(['meat', 'notice'], {
      department: '武汉市火门里餐饮管理有限公司',
      date: '2026-09-10',
      signerMode: 'text',
      signerName: '张三',
      signature: null,
    }));
    expect(onBatch).toHaveBeenCalledWith('batch-9');
  });

  it('selects every receipt that can be paid with one tap', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('checkbox', { name: '全选可付款' }));

    expect(screen.getByText('已选 2 张 · 合计 52471.12')).toBeInTheDocument();
  });

  it('asks to tick something first, in company words', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('button', { name: '生成付款单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请选择至少一张可付款回单');
    expect(mockedApi.createBatch).not.toHaveBeenCalled();
  });

  it('leads a new user to the company upload page when the pool is empty', async () => {
    mockedApi.receipts.mockResolvedValue([]);
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);

    const hint = await screen.findByText(/本期付款池还是空的/);
    expect(hint).toHaveTextContent('本期付款池还是空的。先去上传回单，识别通过后回单会出现在这里。');
    expect(within(hint).getByRole('link', { name: '上传回单' })).toHaveAttribute('href', '#company/upload');
  });

  it('opens the company editor from 编辑 and refreshes the row after the notice is re-confirmed', async () => {
    const edited = companyNotice({
      status: 'ready',
      paidFen: 3_956_164,
      lines: companyNotice().lines!.map((line) => (line.category === '电费' ? { ...line, fen: 1_146_688 } : line)),
    });
    mockedApi.confirmReceipt.mockResolvedValue(edited);
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    const noticeCard = screen.getByRole('heading', { name: '含 5 项 · 39561.63' }).closest('article')!;
    fireEvent.click(within(noticeCard).getByRole('button', { name: '编辑' }));
    expect(within(noticeCard).getByRole('region', { name: '编辑回单' })).toBeInTheDocument();
    fireEvent.change(within(noticeCard).getByLabelText('第 4 项金额'), { target: { value: '11466.88' } });
    fireEvent.click(within(noticeCard).getByRole('button', { name: '确认可付款' }));

    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledWith('notice', expect.objectContaining({
      lines: expect.arrayContaining([{ category: '电费', fen: 1_146_688, period: '2026-07' }]),
    })));
    expect(await screen.findByRole('heading', { name: '含 5 项 · 39561.64' })).toBeInTheDocument();
    // 保存后重新取汇总，数字以后台为准
    await waitFor(() => expect(mockedApi.totals).toHaveBeenCalledTimes(2));
    expect(mockedApi.totals).toHaveBeenLastCalledWith('company');
  });

  it('opens the plain amount editor for a one-item receipt, with the store editor nowhere in sight', async () => {
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    const meatCard = screen.getByRole('heading', { name: '肉款 · 12909.49' }).closest('article')!;
    fireEvent.click(within(meatCard).getByRole('button', { name: '编辑' }));

    expect(within(meatCard).getByLabelText('付款金额')).toHaveValue('12909.49');
    expect(within(meatCard).queryByLabelText('最终实付金额')).not.toBeInTheDocument();
  });

  it('moves a receipt out of the payment pool with the company wording, and refreshes the company totals', async () => {
    mockedApi.setPoolMembership.mockResolvedValue({});
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    const meatCard = screen.getByRole('heading', { name: '肉款 · 12909.49' }).closest('article')!;
    fireEvent.click(within(meatCard).getByRole('button', { name: '移出本次付款池' }));

    await waitFor(() => expect(mockedApi.setPoolMembership).toHaveBeenCalledWith('meat', false));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '肉款 · 12909.49' })).not.toBeInTheDocument());
    await waitFor(() => expect(mockedApi.totals).toHaveBeenCalledTimes(2));
  });

  it('lists the company bin and restores from it with company words', async () => {
    const out = companyReceipt({ id: 'out', status: 'ready', category: '水费', paidFen: 4886 });
    mockedApi.receipts.mockImplementation(async (view: string) => {
      if (view === 'pool') return [];
      return view === 'excluded' ? [out] : [];
    });
    mockedApi.setPoolMembership.mockResolvedValue({});
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText(/本期付款池还是空的/);

    fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));

    await waitFor(() => expect(mockedApi.receipts).toHaveBeenCalledWith('excluded', 'company'));
    expect(mockedApi.receipts).toHaveBeenCalledWith('deleted', 'company');
    const bin = await screen.findByRole('region', { name: '已移出与回收站' });
    expect(within(bin).getByRole('heading', { name: '水费 · 48.86' })).toBeInTheDocument();
    fireEvent.click(within(bin).getByRole('button', { name: '恢复回单' }));
    await waitFor(() => expect(mockedApi.setPoolMembership).toHaveBeenCalledWith('out', true));
    expect(await screen.findByText('已恢复 水费 · 48.86')).toBeInTheDocument();
  });

  it('says there is nothing in the bin in company words', async () => {
    mockedApi.receipts.mockResolvedValue([]);
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText(/本期付款池还是空的/);

    fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));

    expect(await screen.findByText('没有已移出或已删除的回单。')).toBeInTheDocument();
  });

  it('merges split screenshots in the company ledger and reports it in company words', async () => {
    const first = companyReceipt({ id: 'p', status: 'ready', paidFen: 1000, original: { ...companyReceipt().original, id: 'image-p' } });
    const second = companyReceipt({ id: 'q', status: 'ready', paidFen: 2000, original: { ...companyReceipt().original, id: 'image-q' } });
    let poolRows = [first, second];
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? poolRows : []));
    mockedApi.mergeReceipts.mockResolvedValue(companyReceipt({ id: 'm', status: 'recognizing', mergedFrom: ['p', 'q'] }));
    mockedApi.progress.mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 });
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    poolRows = [companyReceipt({ id: 'm', status: 'ready', paidFen: 3000, mergedFrom: ['p', 'q'] })];

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['p', 'q']));
    expect(await screen.findByText('合并完成，重新识别通过，已加入付款池。')).toBeInTheDocument();
    // 合并后重新取的是公账区的付款池
    expect(mockedApi.receipts.mock.calls.filter(([view]) => view === 'pool').every(([, ledger]) => ledger === 'company')).toBe(true);
  });

  it('asks before taking a merged receipt apart, in company words', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? [companyReceipt({ id: 'm', status: 'ready', mergedFrom: ['p', 'q'] })] : []));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    expect(confirm).toHaveBeenCalledWith('拆开后，这张合并回单的识别结果和修改会丢掉，截图恢复成合并前的几张。确定拆开吗？');
    expect(mockedApi.splitReceipt).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows the error when the company pool cannot be loaded, in company words', async () => {
    mockedApi.receipts.mockRejectedValue('boom');
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('获取付款池失败');
  });
});

// 后台的报错是写给店内的（凭证、报销……），公账页面显示前要换成回单、付款的说法
describe('PoolPage in the company ledger: what the server says is shown in company words', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? [companyReceipt({ id: 'meat', status: 'ready' })] : []));
    mockedApi.totals.mockResolvedValue(companyTotals);
    mockedApi.settings.mockResolvedValue(companySettings);
  });

  async function shown(): Promise<HTMLElement> {
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/凭证|报销/);
    return alert;
  }

  it('when the pool cannot be loaded', async () => {
    mockedApi.receipts.mockRejectedValue(new Error('凭证不存在'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);

    expect(await shown()).toHaveTextContent('回单不存在');
  });

  it('when the totals cannot be refreshed after a receipt was moved out', async () => {
    mockedApi.setPoolMembership.mockResolvedValue({});
    mockedApi.totals.mockResolvedValueOnce(companyTotals).mockRejectedValueOnce(new Error('报销批次不存在'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('button', { name: '移出本次付款池' }));

    expect(await shown()).toHaveTextContent('付款批次不存在');
  });

  it('when a receipt cannot be moved out of the pool', async () => {
    mockedApi.setPoolMembership.mockRejectedValue(new Error('凭证已进入报销单，不能移出'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('button', { name: '移出本次付款池' }));

    expect(await shown()).toHaveTextContent('回单已进入付款单，不能移出');
  });

  it('when the bin cannot be loaded', async () => {
    mockedApi.receipts.mockImplementation(async (view: string) => {
      if (view === 'pool') return [companyReceipt({ id: 'meat', status: 'ready' })];
      throw new Error('凭证不存在');
    });
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');

    fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));

    expect(await shown()).toHaveTextContent('回单不存在');
  });

  it('when a receipt cannot be restored from the bin', async () => {
    const out = companyReceipt({ id: 'out', status: 'ready', category: '水费', paidFen: 4886 });
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'excluded' ? [out] : []));
    mockedApi.setPoolMembership.mockRejectedValue(new Error('凭证不存在'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText(/本期付款池还是空的/);
    fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));

    fireEvent.click(await screen.findByRole('button', { name: '恢复回单' }));

    expect(await shown()).toHaveTextContent('回单不存在');
  });

  it('when the pool cannot be reloaded after a restore', async () => {
    const out = companyReceipt({ id: 'out', status: 'ready', category: '水费', paidFen: 4886 });
    let poolCalls = 0;
    mockedApi.receipts.mockImplementation(async (view: string) => {
      if (view === 'excluded') return [out];
      if (view !== 'pool') return [];
      poolCalls += 1;
      if (poolCalls > 1) throw new Error('报销批次不存在');
      return [];
    });
    mockedApi.setPoolMembership.mockResolvedValue({});
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText(/本期付款池还是空的/);
    fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));

    fireEvent.click(await screen.findByRole('button', { name: '恢复回单' }));

    expect(await shown()).toHaveTextContent('付款批次不存在');
  });

  it('when the payment form cannot be generated', async () => {
    mockedApi.createBatch.mockRejectedValue(new Error('凭证当前状态不可生成'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('可付款笔数：2');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 肉款 · 12909.49' }));

    fireEvent.click(screen.getByRole('button', { name: '生成付款单' }));

    expect(await shown()).toHaveTextContent('回单当前状态不可生成');
  });

  it('when screenshots cannot be merged', async () => {
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool'
      ? [companyReceipt({ id: 'p', status: 'ready', paidFen: 1000 }), companyReceipt({ id: 'q', status: 'ready', paidFen: 2000 })]
      : []));
    mockedApi.mergeReceipts.mockRejectedValue(new Error('有凭证还在识别中，请等识别完成后再合并'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await shown()).toHaveTextContent('有回单还在识别中，请等识别完成后再合并');
  });

  it('when the progress of a merged receipt cannot be asked for', async () => {
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool'
      ? [companyReceipt({ id: 'p', status: 'ready', paidFen: 1000 }), companyReceipt({ id: 'q', status: 'ready', paidFen: 2000 })]
      : []));
    mockedApi.mergeReceipts.mockResolvedValue(companyReceipt({ id: 'm', status: 'recognizing', mergedFrom: ['p', 'q'] }));
    mockedApi.progress.mockRejectedValue(new Error('凭证不存在'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await shown()).toHaveTextContent('回单不存在');
  });

  it('when the pool cannot be reloaded after the merged receipt was recognised', async () => {
    let poolCalls = 0;
    mockedApi.receipts.mockImplementation(async (view: string) => {
      if (view !== 'pool') return [];
      poolCalls += 1;
      if (poolCalls > 1) throw new Error('报销批次不存在');
      return [companyReceipt({ id: 'p', status: 'ready', paidFen: 1000 }), companyReceipt({ id: 'q', status: 'ready', paidFen: 2000 })];
    });
    mockedApi.mergeReceipts.mockResolvedValue(companyReceipt({ id: 'm', status: 'recognizing', mergedFrom: ['p', 'q'] }));
    mockedApi.progress.mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 });
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    const boxes = await screen.findAllByRole('checkbox', { name: /^选择 / });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await shown()).toHaveTextContent('付款批次不存在');
  });

  it('when a merged receipt cannot be taken apart', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedApi.receipts.mockImplementation(async (view: string) => (view === 'pool' ? [companyReceipt({ id: 'm', status: 'ready', mergedFrom: ['p', 'q'] })] : []));
    mockedApi.splitReceipt.mockRejectedValue(new Error('这张合并凭证已登记过退款，不能拆开'));
    render(<PoolPage ledger="company" onBatch={vi.fn()} />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    expect(await shown()).toHaveTextContent('这张合并回单已登记过退款，不能拆开');
    confirm.mockRestore();
  });

  it('keeps the store words of a server message for the store', async () => {
    mockedApi.receipts.mockRejectedValue(new Error('凭证不存在'));
    render(<PoolPage onBatch={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('凭证不存在');
  });
});
