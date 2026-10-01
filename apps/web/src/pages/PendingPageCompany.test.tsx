import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Receipt } from '@auto-reimbursement/contracts';
import { companyNotice, companyReceipt, receipt } from '../test/fixtures';

vi.mock('../api', () => ({
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  api: {
    receipts: vi.fn(),
    imageUrl: (id: string) => `/api/images/${id}`,
    receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    openAuthed: vi.fn(),
    confirmReceipt: vi.fn(),
    confirmDistinct: vi.fn(),
    retryReceipt: vi.fn(),
    deleteReceipt: vi.fn(),
    mergeReceipts: vi.fn(),
    splitReceipt: vi.fn(),
    progress: vi.fn(),
  },
}));

import { api } from '../api';
import { PendingPage } from './PendingPage';

afterEach(cleanup);

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

// 后台的报错是写给店内的（凭证、报销……），公账页面显示前要换成回单、付款的说法
async function shownInCompanyWords(): Promise<HTMLElement> {
  const alert = await screen.findByRole('alert');
  expect(alert).not.toHaveTextContent(/凭证|报销/);
  return alert;
}

describe('PendingPage in the company ledger', () => {
  let pendingRows: Receipt[];
  let poolRows: Receipt[];

  beforeEach(() => {
    vi.clearAllMocks();
    pendingRows = [
      companyNotice({ id: 'notice', status: 'pending', pendingReasons: ['lines_mismatch'], recognizedFen: 3_956_000 }),
      companyReceipt({ id: 'dup', status: 'pending', pendingReasons: ['suspected_duplicate'], duplicateIds: ['old-company-receipt'] }),
      companyReceipt({
        id: 'conflict',
        status: 'pending',
        category: '其他公账支出',
        pendingReasons: ['rule_conflict'],
        ruleMatch: { mode: 'suggested', ruleId: 'merchant:示例食品', key: '示例食品', category: '肉款' },
      }),
    ];
    poolRows = [];
    // 只有带着 ledger=company 来问才给公账的数据；漏了区域参数的调用拿到空列表，测试会因此失败
    mockedApi.receipts.mockImplementation(async (view: string, ledger?: string) => {
      if (ledger !== 'company') return [];
      if (view === 'pending') return pendingRows;
      if (view === 'pool') return poolRows;
      return [];
    });
    mockedApi.confirmReceipt.mockResolvedValue(companyReceipt({ status: 'ready' }));
    mockedApi.deleteReceipt.mockResolvedValue(undefined);
    mockedApi.progress.mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 });
  });

  it('asks only for the company ledger, for the pending list and for the pool it compares against', async () => {
    render(<PendingPage ledger="company" />);
    await screen.findAllByRole('region', { name: '编辑回单' });

    expect(mockedApi.receipts).toHaveBeenCalledWith('pending', 'company');
    expect(mockedApi.receipts).toHaveBeenCalledWith('pool', 'company');
    expect(mockedApi.receipts).not.toHaveBeenCalledWith('pending');
    expect(mockedApi.receipts).not.toHaveBeenCalledWith('pool');
  });

  it('keeps asking the way it always did on the store page', async () => {
    mockedApi.receipts.mockResolvedValue([]);
    render(<PendingPage />);
    await screen.findByText('暂无待处理凭证');

    expect(mockedApi.receipts).toHaveBeenCalledWith('pending');
    expect(mockedApi.receipts).toHaveBeenCalledWith('pool');
  });

  it('shows each exception with the company editor and company words', async () => {
    render(<PendingPage ledger="company" />);

    expect(await screen.findAllByRole('region', { name: '编辑回单' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '确认可付款' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '删除回单' })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '确认可报销' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('最终实付金额')).not.toBeInTheDocument();
    // 状态标签
    expect(screen.getAllByText('待处理').length).toBeGreaterThan(0);
  });

  it('says why a notice is waiting and shows the AI total beside the sum of its items', async () => {
    render(<PendingPage ledger="company" />);
    const reasons = await screen.findAllByRole('list', { name: '待处理原因' });

    expect(reasons[0]).toHaveTextContent('各项金额加起来和合计对不上，请核对每一项');
    const card = screen.getByRole('heading', { name: '含 5 项 · 39561.63' }).closest('article')!;
    // 编辑框默认就是展开的（待处理页不折叠）：五行，合计，和 AI 读到的合计对不上的提醒
    expect(within(card).getByLabelText('第 5 项金额')).toHaveValue('162.00');
    expect(within(card).getByRole('status')).toHaveTextContent('合计：39561.63');
    expect(within(card).getByText('AI 读到的通知单合计是 39560.00，和各项相加不一样，请对着图核对每一项。')).toBeInTheDocument();
  });

  it('confirms a corrected notice and takes it off the list', async () => {
    mockedApi.confirmReceipt.mockResolvedValue({ ...pendingRows[0]!, status: 'ready', pendingReasons: [] });
    render(<PendingPage ledger="company" />);
    const card = (await screen.findByRole('heading', { name: '含 5 项 · 39561.63' })).closest('article')!;

    fireEvent.click(within(card).getByRole('button', { name: '确认可付款' }));

    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledWith('notice', expect.objectContaining({
      lines: expect.arrayContaining([{ category: '水费', fen: 4_886, period: '2026-07' }]),
    })));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '含 5 项 · 39561.63' })).not.toBeInTheDocument());
  });

  it('spells out a learned rule conflict in the company ledger and lets the user take the rule category', async () => {
    render(<PendingPage ledger="company" />);

    expect(await screen.findByText('历史规则冲突：「示例食品」以前都归「肉款」，这次 AI 判断为「其他公账支出」')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '改用规则分类：肉款' }));
    const card = screen.getAllByRole('heading', { name: '其他公账支出 · 12909.49' })[0]!.closest('article')!;
    expect(within(card).getByLabelText('分类')).toHaveValue('肉款');
  });

  it('shows the duplicate evidence in company words', async () => {
    render(<PendingPage ledger="company" />);

    expect(await screen.findByText('疑似重复')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看历史回单' })).toHaveAttribute('href', '/api/receipts/old-company-receipt/original-image');
    expect(screen.queryByRole('link', { name: '查看历史凭证' })).not.toBeInTheDocument();
  });

  it('says there is nothing to handle in company words', async () => {
    pendingRows = [];
    render(<PendingPage ledger="company" />);

    expect(await screen.findByText('暂无待处理回单')).toBeInTheDocument();
  });

  it('shows a load failure in company words', async () => {
    mockedApi.receipts.mockRejectedValue('boom');
    render(<PendingPage ledger="company" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('获取待处理回单失败');
  });

  describe('what the server says is shown in company words', () => {
    it('when the list cannot be loaded', async () => {
      mockedApi.receipts.mockRejectedValue(new Error('凭证不存在'));
      render(<PendingPage ledger="company" />);

      expect(await shownInCompanyWords()).toHaveTextContent('回单不存在');
    });

    it('when "not a duplicate" is refused', async () => {
      mockedApi.confirmDistinct.mockRejectedValue(new Error('凭证当前状态不可确认'));
      render(<PendingPage ledger="company" />);

      fireEvent.click(await screen.findByRole('button', { name: '确认不是重复，继续加入' }));

      expect(await shownInCompanyWords()).toHaveTextContent('回单当前状态不可确认');
    });

    it('when a retry is refused', async () => {
      pendingRows = [companyReceipt({ id: 'failed', status: 'pending', pendingReasons: ['api_failed'] })];
      mockedApi.retryReceipt.mockRejectedValue(new Error('凭证不存在'));
      render(<PendingPage ledger="company" />);

      fireEvent.click(await screen.findByRole('button', { name: '重试识别' }));

      expect(await shownInCompanyWords()).toHaveTextContent('回单不存在');
    });

    it('keeps the words of the server for the store page', async () => {
      mockedApi.receipts.mockRejectedValue(new Error('凭证不存在'));
      render(<PendingPage />);

      expect(await screen.findByRole('alert')).toHaveTextContent('凭证不存在');
    });
  });

  describe('merging screenshots of one company 回单', () => {
    const image = (id: string) => ({ ...companyReceipt().original, id: `image-${id}` });
    const lone = (id: string, order: number): Receipt => companyReceipt({
      id,
      original: image(id),
      uploadOrder: order,
      status: 'pending',
      pendingReasons: ['incomplete_screenshot'],
      merchant: `商户${id}`,
      date: `2026-08-0${order}`,
      paidFen: null,
      recognizedFen: null,
      category: null,
      payee: undefined,
      analysis: { ...companyReceipt().analysis!, amount: null, incomplete: true, merchant: `商户${id}` },
    });

    beforeEach(() => {
      pendingRows = [lone('a', 1), lone('b', 2), lone('c', 3)];
      mockedApi.mergeReceipts.mockResolvedValue(companyReceipt({ id: 'm', status: 'recognizing', mergedFrom: ['a', 'b'] }));
    });

    it('merges the ticked screenshots and, when they pass recognition, says they reached the payment pool', async () => {
      render(<PendingPage ledger="company" />);
      await screen.findAllByLabelText(/选择合并/);
      const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
      fireEvent.click(boxes[0]!);
      fireEvent.click(boxes[1]!);
      pendingRows = [lone('c', 3)];
      poolRows = [companyReceipt({ id: 'm', status: 'ready', mergedFrom: ['a', 'b'] })];

      fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

      await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['a', 'b']));
      expect(await screen.findByText('合并完成，重新识别通过，已进入付款池。')).toBeInTheDocument();
      // 合并后重新取的列表也都是公账的
      expect(mockedApi.receipts.mock.calls.every(([, ledger]) => ledger === 'company')).toBe(true);
    });

    async function tickTwoAndMerge(): Promise<void> {
      await screen.findAllByLabelText(/选择合并/);
      const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
      fireEvent.click(boxes[0]!);
      fireEvent.click(boxes[1]!);
      fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));
    }

    it('shows what the server says about a refused merge in company words', async () => {
      mockedApi.mergeReceipts.mockRejectedValue(new Error('有凭证还在识别中，请等识别完成后再合并'));
      render(<PendingPage ledger="company" />);

      await tickTwoAndMerge();

      expect(await shownInCompanyWords()).toHaveTextContent('有回单还在识别中，请等识别完成后再合并');
    });

    it('shows a failed progress check of the merged receipt in company words', async () => {
      mockedApi.progress.mockRejectedValue(new Error('凭证不存在'));
      render(<PendingPage ledger="company" />);

      await tickTwoAndMerge();

      expect(await shownInCompanyWords()).toHaveTextContent('回单不存在');
    });

    it('shows a failed reload after the merged receipt was recognised in company words', async () => {
      let pendingCalls = 0;
      mockedApi.receipts.mockImplementation(async (view: string) => {
        if (view !== 'pending') return [];
        pendingCalls += 1;
        if (pendingCalls > 1) throw new Error('报销批次不存在');
        return pendingRows;
      });
      render(<PendingPage ledger="company" />);

      await tickTwoAndMerge();

      expect(await shownInCompanyWords()).toHaveTextContent('付款批次不存在');
    });

    it('shows what the server says about a refused split in company words', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      pendingRows = [companyReceipt({ id: 'm', status: 'pending', pendingReasons: ['category_uncertain'], mergedFrom: ['a', 'b'] })];
      mockedApi.splitReceipt.mockRejectedValue(new Error('这张凭证不是合并来的，没有可以拆开的截图'));
      render(<PendingPage ledger="company" />);
      await screen.findByText('由 2 张截图合并（左右拼成一张图）');

      fireEvent.click(screen.getByRole('button', { name: '拆开' }));

      expect(await shownInCompanyWords()).toHaveTextContent('这张回单不是合并来的，没有可以拆开的截图');
    });

    it('asks before taking a merged company receipt apart, in company words', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      pendingRows = [companyReceipt({ id: 'm', status: 'pending', pendingReasons: ['category_uncertain'], mergedFrom: ['a', 'b'] })];
      render(<PendingPage ledger="company" />);
      await screen.findByText('由 2 张截图合并（左右拼成一张图）');

      fireEvent.click(screen.getByRole('button', { name: '拆开' }));

      expect(confirm).toHaveBeenCalledWith('拆开后，这张合并回单的识别结果和修改会丢掉，截图恢复成合并前的几张。确定拆开吗？');
      expect(mockedApi.splitReceipt).not.toHaveBeenCalled();
      confirm.mockRestore();
    });
  });

  it('keeps a store receipt on the store page with the store editor', async () => {
    mockedApi.receipts.mockResolvedValue([receipt({ id: 's', status: 'pending', pendingReasons: ['amount_uncertain'] })]);
    render(<PendingPage />);

    expect(await screen.findByLabelText('最终实付金额')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认可报销' })).toBeInTheDocument();
    expect(screen.queryByLabelText('银行账号')).not.toBeInTheDocument();
  });
});
