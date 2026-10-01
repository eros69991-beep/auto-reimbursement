import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { receipt } from '../test/fixtures';

// 不 mock setRefund / addRefundImage：编辑框不该再调用它们，调用了会因为函数不存在而失败
const { confirmReceipt, deleteReceipt } = vi.hoisted(() => ({ confirmReceipt: vi.fn(), deleteReceipt: vi.fn() }));
vi.mock('../api', () => ({
  api: { confirmReceipt, deleteReceipt },
}));

import { ReceiptEditor } from './ReceiptEditor';

describe('receipt editor', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('confirms a receipt whose date the AI could not read without forcing a made-up value', async () => {
    const unread = receipt({ merchant: null, date: null, paidFen: null, category: null, status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...unread, paidFen: 3633, category: '耗材', status: 'ready' });
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={unread} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '36.33' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '耗材' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    // 日期留空时不提交这个字段（保持原值），也不拦截确认
    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 3633, category: '耗材' }));
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('only offers date, amount, category, confirm and delete — no merchant or refund controls', () => {
    render(<ReceiptEditor receipt={receipt({ status: 'pending' })} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('日期')).toBeInTheDocument();
    expect(screen.getByLabelText('最终实付金额')).toBeInTheDocument();
    expect(screen.getByLabelText('分类')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认可报销' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除凭证' })).toBeInTheDocument();

    expect(screen.queryByLabelText('商户')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('退款金额')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('上传退款凭证')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /退款/ })).not.toBeInTheDocument();
    // 取而代之的一句提示：有退款就直接把金额改成实际花的钱
    expect(screen.getByText('有退款的，填扣掉退款后实际花的钱')).toBeInTheDocument();
    expect(screen.getByLabelText('最终实付金额')).toHaveAccessibleDescription('有退款的，填扣掉退款后实际花的钱');
  });

  it('does not send the merchant, even when the AI recognised one', async () => {
    const recognised = receipt({ status: 'pending', merchant: '示例商户', date: '2026-09-02' });
    confirmReceipt.mockResolvedValue({ ...recognised, status: 'ready' });
    render(<ReceiptEditor receipt={recognised} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 3633, category: '耗材', date: '2026-09-02' });
    expect(confirmReceipt.mock.calls[0]![1]).not.toHaveProperty('merchant');
  });

  it('turns "I got money back" into a plain amount edit: the box holds what was actually spent', async () => {
    // 新做法：花了 120.00、退了 80.00，就把金额直接改成 40.00
    const bought = receipt({ status: 'pending', paidFen: 12000, refundFen: 0 });
    confirmReceipt.mockResolvedValue({ ...bought, paidFen: 4000, status: 'ready' });
    render(<ReceiptEditor receipt={bought} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '40.00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 4000, category: '耗材', date: '2026-09-02' }));
  });

  it('shows the net amount of a receipt with an old refund and adds the refund back on save, so it is not deducted twice', async () => {
    // 旧数据：实付 120.00、已登记退款 80.00 → 实际花了 40.00，框里就是 40.00
    const legacy = receipt({ status: 'pending', paidFen: 12000, refundFen: 8000 });
    confirmReceipt.mockResolvedValue({ ...legacy, status: 'ready' });
    render(<ReceiptEditor receipt={legacy} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('最终实付金额')).toHaveValue('40.00');

    // 不改金额直接确认：后台的实付仍是 120.00，退款登记不变，净额还是 40.00
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));
    await waitFor(() => expect(confirmReceipt).toHaveBeenLastCalledWith('a', { paidFen: 12000, category: '耗材', date: '2026-09-02' }));

    // 改成 30.00：实付 = 30.00 + 已登记的 80.00 = 110.00，净额恰好是 30.00
    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '30.00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));
    await waitFor(() => expect(confirmReceipt).toHaveBeenLastCalledWith('a', { paidFen: 11000, category: '耗材', date: '2026-09-02' }));
  });

  it('no longer blocks an amount below the registered refund: the box is the net, so it cannot undercut the refund', async () => {
    // 以前输入的实付 < 已登记退款会被拦住；现在输入的是净额，怎么填实付都不会小于退款
    const legacy = receipt({ status: 'pending', paidFen: 12000, refundFen: 8000 });
    confirmReceipt.mockResolvedValue({ ...legacy, status: 'ready' });
    render(<ReceiptEditor receipt={legacy} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '0.01' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 8001, category: '耗材', date: '2026-09-02' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves the amount empty for dirty legacy data (refund larger than the payment) and repairs it on save', async () => {
    const dirty = receipt({ status: 'pending', paidFen: 2000, refundFen: 3000 });
    confirmReceipt.mockResolvedValue({ ...dirty, paidFen: 4000, status: 'ready' });
    render(<ReceiptEditor receipt={dirty} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('最终实付金额')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    // 实付 = 10.00 + 30.00 = 40.00 ≥ 退款 30.00，数据恢复一致
    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 4000, category: '耗材', date: '2026-09-02' }));
  });

  it('refuses an amount that, with the old refund added back, is beyond what can be recorded', () => {
    const huge = receipt({ status: 'pending', paidFen: 999_999_999_999, refundFen: 999_999_999_900 });
    render(<ReceiptEditor receipt={huge} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    expect(screen.getByRole('alert')).toHaveTextContent('金额过大');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('asks for a category and a valid amount before confirming', () => {
    render(<ReceiptEditor receipt={receipt({ status: 'pending', paidFen: null, category: null })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择分类');

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '耗材' } });
    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '三十' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正确的金额');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('deletes the receipt after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteReceipt.mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={receipt({ status: 'pending' })} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: '删除凭证' }));

    await waitFor(() => expect(deleteReceipt).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', deletedAt: expect.any(String) })));
    confirm.mockRestore();
  });

  it('offers the learned rule category as a one-tap alternative on a rule conflict', async () => {
    // 冲突时分类保持 AI 的判断（酒水），规则的分类（百慕达食材）一键可选
    const conflict = receipt({
      status: 'pending',
      category: '酒水',
      pendingReasons: ['rule_conflict'],
      ruleMatch: { mode: 'suggested', ruleId: 'merchant:武汉仓', key: '武汉仓', category: '百慕达食材' },
    });
    confirmReceipt.mockResolvedValue({ ...conflict, category: '百慕达食材', status: 'ready' });
    render(<ReceiptEditor receipt={conflict} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('分类')).toHaveValue('酒水');
    fireEvent.click(screen.getByRole('button', { name: '改用规则分类：百慕达食材' }));
    expect(screen.getByLabelText('分类')).toHaveValue('百慕达食材');
    expect(screen.queryByRole('button', { name: '改用规则分类：百慕达食材' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));
    await waitFor(() => expect(confirmReceipt).toHaveBeenLastCalledWith('a', expect.objectContaining({ category: '百慕达食材' })));
  });

  it('shows no rule suggestion without a conflict', () => {
    render(<ReceiptEditor receipt={receipt({ status: 'pending', pendingReasons: ['amount_uncertain'] })} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /改用规则分类/ })).not.toBeInTheDocument();
  });
});
