import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { companyNotice, companyReceipt, receipt } from '../test/fixtures';

vi.mock('../api', () => ({
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  api: {
    imageUrl: (id: string) => `/api/images/${id}`,
    openAuthed: vi.fn(),
  },
}));

import { ReceiptCard } from './ReceiptCard';

describe('receipt card in the company ledger', () => {
  afterEach(() => cleanup());

  it('is titled by category and amount, and says 可付款 instead of 可报销', () => {
    render(<ReceiptCard receipt={companyReceipt({ status: 'ready' })} />);

    expect(screen.getByRole('heading', { name: '肉款 · 12909.49' })).toBeInTheDocument();
    expect(screen.getByText('可付款')).toBeInTheDocument();
    expect(screen.queryByText('可报销')).not.toBeInTheDocument();
  });

  it('uses 回单 in the picture description and the generated-form status', async () => {
    const generated = render(<ReceiptCard receipt={companyReceipt({ status: 'generated' })} />);
    expect(screen.getByText('已生成付款单')).toBeInTheDocument();
    // 缩略图要等带鉴权的下载完成才画出来
    expect(await screen.findByRole('img', { name: '肉款 · 12909.49 原始回单缩略图' })).toBeInTheDocument();
    generated.unmount();

    render(<ReceiptCard receipt={receipt({ status: 'generated' })} />);
    expect(screen.getByText('已生成报销单')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: '耗材 · 36.33 原始凭证缩略图' })).toBeInTheDocument();
  });

  it('names the month of a bill in its title', () => {
    render(<ReceiptCard receipt={companyReceipt({ category: '电费', period: '2026-07', paidFen: 1_146_687 })} />);

    expect(screen.getByRole('heading', { name: '电费（2026年7月） · 11466.87' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看原图 电费（2026年7月） · 11466.87' })).toBeInTheDocument();
  });

  it('shows a split notice as one card with its items and total', () => {
    render(<ReceiptCard receipt={companyNotice({ status: 'ready' })} />);

    expect(screen.getByRole('heading', { name: '含 5 项 · 39561.63' })).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: '收费项目' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      '店面租金（2026年9月） 22814.10',
      '物业费（2026年9月） 5069.80',
      '水费（2026年7月） 48.86',
      '电费（2026年7月） 11466.87',
      '空调能源费（2026年7月） 162.00',
    ]);
  });

  it('shows the payee: name, bank and account, in that order', () => {
    render(<ReceiptCard receipt={companyReceipt()} />);

    const payee = screen.getByLabelText('收款方');
    expect(within(payee).getAllByRole('term').map((term) => term.textContent)).toEqual(['收款户名', '开户银行', '银行账号']);
    expect(within(payee).getAllByRole('definition').map((value) => value.textContent)).toEqual(['示例食品销售有限公司', '示例银行上海分行', '1234567890123456789']);
  });

  it('shows only the payee parts that exist, and no payee box without any', () => {
    const partial = render(<ReceiptCard receipt={companyReceipt({ payee: { account: '1234567890123456789' } })} />);
    expect(within(screen.getByLabelText('收款方')).getAllByRole('term').map((term) => term.textContent)).toEqual(['银行账号']);
    partial.unmount();

    render(<ReceiptCard receipt={companyReceipt({ payee: undefined })} />);
    expect(screen.queryByLabelText('收款方')).not.toBeInTheDocument();
    expect(screen.queryByText('银行账号')).not.toBeInTheDocument();
  });

  it('shows no items list and no payee on a store receipt', () => {
    render(<ReceiptCard receipt={receipt()} />);

    expect(screen.queryByRole('list', { name: '收费项目' })).not.toBeInTheDocument();
    expect(screen.queryByText('收款户名')).not.toBeInTheDocument();
  });
});
