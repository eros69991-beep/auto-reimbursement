import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { receipt } from '../test/fixtures';

const { confirmReceipt } = vi.hoisted(() => ({ confirmReceipt: vi.fn() }));
vi.mock('../api', () => ({
  api: { confirmReceipt, setRefund: vi.fn(), addRefundImage: vi.fn(), deleteReceipt: vi.fn() },
}));

import { ReceiptEditor } from './ReceiptEditor';

describe('receipt editor', () => {
  afterEach(() => cleanup());

  it('confirms a receipt whose merchant and date the AI could not read without forcing made-up values', async () => {
    const unread = receipt({ merchant: null, date: null, paidFen: null, category: null, status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...unread, paidFen: 3633, category: '耗材', status: 'ready' });
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={unread} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('最终实付金额'), { target: { value: '36.33' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '耗材' } });
    fireEvent.click(screen.getByRole('button', { name: '确认可报销' }));

    // 商户、日期留空时不提交这两个字段（保持原值），也不拦截确认
    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', { paidFen: 3633, category: '耗材' }));
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
