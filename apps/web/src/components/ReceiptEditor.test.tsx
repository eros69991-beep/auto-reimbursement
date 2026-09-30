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
});
