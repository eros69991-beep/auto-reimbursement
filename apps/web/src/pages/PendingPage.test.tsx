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
    // 商户与退款不再出现在编辑框里：有退款就直接把金额改成实际花的钱
    expect(screen.queryByLabelText('商户')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('退款金额')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /退款/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /查看原图/ })[0]).toHaveAttribute(
      'href',
      '/api/images/image-a',
    );
    fireEvent.change(amounts[0]!, { target: { value: '36.33' } });
    fireEvent.change(categories[0]!, { target: { value: '耗材' } });
    fireEvent.click(screen.getAllByRole('button', { name: '确认可报销' })[0]!);

    // P-10：修改与确认合并为一次原子请求，不再先 PATCH 再 confirm
    // 日期随确认一起提交；商户不再由用户填，不会随请求发送
    await waitFor(() => expect(mockedApi.confirmReceipt).toHaveBeenCalledWith('a', {
      paidFen: 3633,
      category: '耗材',
      date: '2026-09-02',
    }));
    expect(mockedApi.updateReceipt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('金额无法确定')).not.toBeInTheDocument());
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('titles each exception with 分类 · 金额 rather than the merchant name or internal id', async () => {
    render(<PendingPage />);
    await screen.findByText('金额无法确定');

    // a：分类和金额都没识别出来；duplicate / failed：耗材 36.33
    expect(screen.getByRole('heading', { name: '分类待确认 · 金额待确认' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: '耗材 · 36.33' })).toHaveLength(2);
    expect(screen.queryByText(/示例商户/)).not.toBeInTheDocument();
    for (const id of ['a', 'duplicate', 'failed']) expect(screen.queryByText(id)).not.toBeInTheDocument();
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
    expect(mockedApi.confirmReceipt).toHaveBeenLastCalledWith('a', { paidFen: 3633, category: '耗材', date: '2026-09-02' });
    expect(mockedApi.updateReceipt).not.toHaveBeenCalled();
  });

  it('spells out a learned rule conflict and notes when a fixed rule chose the category', async () => {
    mockedApi.receipts.mockResolvedValue([
      receipt({
        id: 'conflict',
        status: 'pending',
        merchant: '武汉仓',
        category: '酒水',
        pendingReasons: ['rule_conflict'],
        ruleMatch: { mode: 'suggested', ruleId: 'merchant:武汉仓', key: '武汉仓', category: '百慕达食材' },
      }),
      receipt({
        id: 'fixed',
        status: 'pending',
        category: '百慕达食材',
        pendingReasons: ['amount_uncertain'],
        ruleMatch: { mode: 'applied', ruleId: 'fixed-1', key: '武汉仓', category: '百慕达食材' },
      }),
    ]);
    render(<PendingPage />);

    expect(
      await screen.findByText('历史规则冲突：「武汉仓」以前都归「百慕达食材」，这次 AI 判断为「酒水」'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '改用规则分类：百慕达食材' })).toBeInTheDocument();
    expect(screen.getByText('按固定规则「武汉仓」归类')).toBeInTheDocument();
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

// 试点反馈 3：同一单被截成两张，各自识别成「一个订单」找不到实付金额
describe('PendingPage merging screenshots of one order', () => {
  const image = (id: string) => ({ ...receipt().original, id: `image-${id}` });
  // 只有商品清单、读不出实付金额的那半张
  const half = (id: string, order: number, overrides: Parameters<typeof receipt>[0] = {}) => receipt({
    id,
    original: image(id),
    uploadOrder: order,
    status: 'pending',
    pendingReasons: ['incomplete_screenshot', 'amount_uncertain'],
    paidFen: null,
    recognizedFen: null,
    category: null,
    analysis: { ...receipt().analysis!, amount: null, incomplete: true },
    ...overrides,
  });
  // 和别的凭证没有任何关联（商户、日期都不同），不会触发「疑似同一单」提示
  const loner = (id: string, order: number) => half(id, order, {
    merchant: `商户${id}`,
    date: `2026-08-0${order}`,
    analysis: { ...receipt().analysis!, amount: null, incomplete: true, merchant: `商户${id}` },
  });
  const merged = (overrides: Parameters<typeof receipt>[0] = {}) => receipt({
    id: 'm',
    original: image('m'),
    uploadOrder: 1,
    status: 'pending',
    pendingReasons: ['category_uncertain'],
    category: null,
    mergedFrom: ['a', 'b'],
    ...overrides,
  });

  let pendingRows: ReturnType<typeof receipt>[];
  let poolRows: ReturnType<typeof receipt>[];

  beforeEach(() => {
    vi.clearAllMocks();
    pendingRows = [loner('a', 1), loner('b', 2), loner('c', 3), loner('d', 4)];
    poolRows = [];
    mockedApi.receipts.mockImplementation(async (view: string) => {
      if (view === 'pending') return pendingRows;
      if (view === 'pool') return poolRows;
      return [];
    });
    mockedApi.mergeReceipts.mockResolvedValue(merged({ status: 'recognizing' }));
    mockedApi.progress.mockResolvedValue({ total: 1, recognizing: 0, ready: 0, pending: 1 });
    mockedApi.splitReceipt.mockResolvedValue([loner('a', 1), loner('b', 2)]);
  });

  it('explains an incomplete screenshot and how to merge it', async () => {
    render(<PendingPage />);

    expect(await screen.findAllByText('截图不完整：可能只是同一单的一部分，可以和相邻的截图合并')).toHaveLength(4);
    expect(screen.getByText(/同一单被截成几张？勾选这几张（最多 3 张）/)).toBeInTheDocument();
    // 没勾选时没有底部合并栏
    expect(screen.queryByRole('button', { name: '合并为一单' })).not.toBeInTheDocument();
  });

  it('merges the ticked screenshots in list order, whatever order they were ticked in', async () => {
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);

    const boxes = screen.getAllByRole('checkbox', { name: '选择合并 分类待确认 · 金额待确认' });
    fireEvent.click(boxes[2]!);
    expect(screen.getByText(/已选 1 张，再选 1–2 张同一单的截图/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '合并为一单' })).toBeDisabled();
    fireEvent.click(boxes[0]!);
    expect(screen.getByText('已选 2 张')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    // 第 3 张先勾、第 1 张后勾，但拼的时候按列表（上传）顺序：a 在左，c 在右
    await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['a', 'c']));
    expect(await screen.findByRole('status')).toHaveTextContent('已合并，正在重新识别拼好的图…');
  });

  it('shows the merged receipt once recognized, with a note and a way to take it apart', async () => {
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    // 合并后列表里没有被隐藏的 a、b，只有新的这张
    pendingRows = [merged(), loner('c', 3), loner('d', 4)];

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    await waitFor(() => expect(mockedApi.progress).toHaveBeenCalledWith(['m']));
    expect(await screen.findByText('由 2 张截图合并（左右拼成一张图）')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('合并完成，重新识别后这张还需要你确认');
    expect(screen.getByRole('button', { name: '拆开' })).toBeInTheDocument();
    // 合并出来的不能再被勾选合并，别的还可以
    expect(screen.getAllByRole('checkbox', { name: /选择合并/ })).toHaveLength(2);
    expect(screen.queryByText('已选 2 张')).not.toBeInTheDocument();
  });

  it('says so when the merged receipt passed recognition and went straight to the pool', async () => {
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    pendingRows = [loner('c', 3), loner('d', 4)];
    poolRows = [merged({ status: 'ready', pendingReasons: [], category: '百慕达食材', paidFen: 58800 })];

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await screen.findByText('合并完成，重新识别通过，已进入报销池。')).toBeInTheDocument();
  });

  it('stops at three ticked screenshots', async () => {
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });

    for (const box of boxes.slice(0, 3)) fireEvent.click(box);

    expect(screen.getByText('已选 3 张')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '合并为一单' })).not.toBeDisabled();
    expect(boxes[3]).toBeDisabled();
    fireEvent.click(boxes[0]!);
    expect(boxes[3]).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(screen.queryByText(/已选 \d 张/)).not.toBeInTheDocument();
  });

  it('shows the reason and refreshes the list when the server refuses to merge', async () => {
    mockedApi.mergeReceipts.mockRejectedValue(new Error('有凭证还在识别中，请等识别完成后再合并'));
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    const loads = mockedApi.receipts.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('有凭证还在识别中，请等识别完成后再合并');
    await waitFor(() => expect(mockedApi.receipts.mock.calls.length).toBeGreaterThan(loads));
    // 失败了，几张还在，还能再试
    expect(screen.getAllByRole('checkbox', { name: /选择合并/ })).toHaveLength(4);
  });

  it('keeps asking while the merged picture is being recognized, then refreshes', async () => {
    mockedApi.progress
      .mockResolvedValueOnce({ total: 1, recognizing: 1, ready: 0, pending: 0 })
      .mockResolvedValue({ total: 1, recognizing: 0, ready: 0, pending: 1 });
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    pendingRows = [merged(), loner('c', 3), loner('d', 4)];

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    await screen.findByText('已合并，正在重新识别拼好的图…');
    // 识别没完成之前，不能再动合并按钮
    expect(mockedApi.progress).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('由 2 张截图合并（左右拼成一张图）', undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(mockedApi.progress).toHaveBeenCalledTimes(2);
  });

  it('refreshes anyway and says so when the progress check fails', async () => {
    mockedApi.progress.mockRejectedValue(new Error('网络错误'));
    render(<PendingPage />);
    await screen.findAllByLabelText(/选择合并/);
    const boxes = screen.getAllByRole('checkbox', { name: /选择合并/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    pendingRows = [merged(), loner('c', 3), loner('d', 4)];

    fireEvent.click(screen.getByRole('button', { name: '合并为一单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
    expect(await screen.findByText('由 2 张截图合并（左右拼成一张图）')).toBeInTheDocument();
  });

  it('takes a merged receipt apart after confirmation and brings the screenshots back', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    pendingRows = [merged(), loner('c', 3)];
    render(<PendingPage />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');
    pendingRows = [loner('a', 1), loner('b', 2), loner('c', 3)];

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    await waitFor(() => expect(mockedApi.splitReceipt).toHaveBeenCalledWith('m'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('确定拆开吗？'));
    expect(await screen.findByText('已拆开，恢复成 2 张截图。')).toBeInTheDocument();
    expect(screen.queryByText('由 2 张截图合并（左右拼成一张图）')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /选择合并/ })).toHaveLength(3);
    confirm.mockRestore();
  });

  it('does nothing when the confirmation to take apart is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    pendingRows = [merged(), loner('c', 3)];
    render(<PendingPage />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    expect(mockedApi.splitReceipt).not.toHaveBeenCalled();
    expect(screen.getByText('由 2 张截图合并（左右拼成一张图）')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('shows why taking apart failed and leaves the merged receipt where it is', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedApi.splitReceipt.mockRejectedValue(new Error('合并前的截图记录不完整，无法拆开'));
    pendingRows = [merged()];
    render(<PendingPage />);
    await screen.findByText('由 2 张截图合并（左右拼成一张图）');

    fireEvent.click(screen.getByRole('button', { name: '拆开' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('合并前的截图记录不完整，无法拆开');
    expect(screen.getByText('由 2 张截图合并（左右拼成一张图）')).toBeInTheDocument();
    confirm.mockRestore();
  });

  describe('suggestions', () => {
    // 同一次上传里相邻的两张，同一个商户和日期，其中一张读不出实付金额
    const suggestedPair = () => [
      half('a', 1),
      half('b', 2, {
        status: 'pending',
        pendingReasons: ['category_uncertain'],
        category: null,
        paidFen: 5880,
        recognizedFen: 5880,
        analysis: { ...receipt().analysis!, amount: '58.80' },
      }),
    ];

    it('points out two neighbouring screenshots that look like one order, with the reason', async () => {
      pendingRows = suggestedPair();
      render(<PendingPage />);

      const section = await screen.findByRole('region', { name: '疑似同一单' });
      expect(section).toHaveTextContent('这几张可能是同一单');
      expect(section).toHaveTextContent('商户相同、日期相同');
      expect(screen.getByRole('link', { name: '查看第 1 张截图' })).toHaveAttribute('href', '/api/images/image-a');
      expect(screen.getByRole('link', { name: '查看第 2 张截图' })).toHaveAttribute('href', '/api/images/image-b');
    });

    it('merges the suggested pair with one tap', async () => {
      pendingRows = suggestedPair();
      render(<PendingPage />);
      await screen.findByRole('region', { name: '疑似同一单' });

      fireEvent.click(screen.getByRole('button', { name: '合并这 2 张' }));

      await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['a', 'b']));
      await waitFor(() => expect(screen.queryByRole('region', { name: '疑似同一单' })).not.toBeInTheDocument());
    });

    it('stops suggesting a pair once it is dismissed, without calling the server', async () => {
      pendingRows = suggestedPair();
      render(<PendingPage />);
      await screen.findByRole('region', { name: '疑似同一单' });

      fireEvent.click(screen.getByRole('button', { name: '不是同一单' }));

      expect(screen.queryByRole('region', { name: '疑似同一单' })).not.toBeInTheDocument();
      expect(mockedApi.mergeReceipts).not.toHaveBeenCalled();
      // 两张仍然是各自的待处理凭证
      expect(screen.getAllByRole('checkbox', { name: /选择合并/ })).toHaveLength(2);
    });

    it('also compares with receipts that already reached the pool', async () => {
      pendingRows = [half('a', 1)];
      poolRows = [receipt({ id: 'p', original: image('p'), uploadOrder: 2 })];
      render(<PendingPage />);
      await screen.findByRole('region', { name: '疑似同一单' });

      fireEvent.click(screen.getByRole('button', { name: '合并这 2 张' }));

      await waitFor(() => expect(mockedApi.mergeReceipts).toHaveBeenCalledWith(['a', 'p']));
    });

    it('says nothing when both look complete or nothing connects them', async () => {
      pendingRows = [
        half('a', 1, { analysis: { ...receipt().analysis!, amount: '10.00' }, paidFen: 1000 }),
        half('b', 2, { analysis: { ...receipt().analysis!, amount: '20.00' }, paidFen: 2000 }),
      ];
      render(<PendingPage />);
      await screen.findAllByText('截图不完整：可能只是同一单的一部分，可以和相邻的截图合并');

      expect(screen.queryByRole('region', { name: '疑似同一单' })).not.toBeInTheDocument();
    });

    it('still lists the pending receipts when the pool cannot be loaded', async () => {
      pendingRows = suggestedPair();
      mockedApi.receipts.mockImplementation(async (view: string) => {
        if (view === 'pool') throw new Error('报销池暂时不可用');
        return pendingRows;
      });
      render(<PendingPage />);

      // 对子都在待处理里，提示照样有；报销池取不到不弹错
      expect(await screen.findByRole('region', { name: '疑似同一单' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
