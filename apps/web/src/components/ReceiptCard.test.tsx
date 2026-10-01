import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { receipt } from '../test/fixtures';

vi.mock('../api', () => ({
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  api: {
    imageUrl: (id: string) => `/api/images/${id}`,
    openAuthed: vi.fn(),
  },
}));

import { ReceiptCard } from './ReceiptCard';

describe('receipt card', () => {
  afterEach(() => cleanup());

  it('is titled 分类 · 金额, with the date underneath', () => {
    render(<ReceiptCard receipt={receipt({ category: '食材', paidFen: 12000, date: '2026-09-02' })} />);

    expect(screen.getByRole('heading', { name: '食材 · 120.00' })).toBeInTheDocument();
    expect(screen.getByText('2026-09-02')).toBeInTheDocument();
    expect(screen.getByText('可报销')).toBeInTheDocument();
  });

  it('shows neither the merchant name nor the internal id, and no separate original/refund/net rows', () => {
    render(<ReceiptCard receipt={receipt({ id: 'internal-id-123', merchant: '某某商户' })} />);

    expect(screen.queryByText(/某某商户/)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal-id-123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/原金额|已退款|净额/)).not.toBeInTheDocument();
    // 缩略图链接和图片的读屏名称也跟着用「分类 · 金额」
    expect(screen.getByRole('link', { name: '查看原图 耗材 · 36.33' })).toHaveAttribute('href', '/api/images/image-a');
  });

  it('says what is still unknown on a receipt waiting for confirmation', () => {
    render(<ReceiptCard receipt={receipt({ status: 'pending', category: null, paidFen: null, date: null })} />);

    expect(screen.getByRole('heading', { name: '分类待确认 · 金额待确认' })).toBeInTheDocument();
    expect(screen.getByText('日期待确认')).toBeInTheDocument();
  });

  it('shows one amount — the net — and a read-only note for a refund registered before', () => {
    render(<ReceiptCard receipt={receipt({ paidFen: 12000, refundFen: 8000 })} />);

    expect(screen.getByRole('heading', { name: '耗材 · 40.00' })).toBeInTheDocument();
    expect(screen.getByText('已扣除退款 80.00')).toBeInTheDocument();
    // 没有任何可点的退款控件
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('has no refund note when nothing was refunded', () => {
    render(<ReceiptCard receipt={receipt({ refundFen: 0 })} />);
    expect(screen.queryByText(/已扣除退款/)).not.toBeInTheDocument();
  });

  it('asks for a fresh amount when old data has a refund larger than the payment', () => {
    render(<ReceiptCard receipt={receipt({ paidFen: 2000, refundFen: 3000 })} />);
    expect(screen.getByRole('heading', { name: '耗材 · 金额异常，请重新填写' })).toBeInTheDocument();
  });

  it('keeps the fixed-rule note and the recognition details', () => {
    render(
      <ReceiptCard
        receipt={receipt({
          category: '百慕达食材',
          ruleMatch: { mode: 'applied', ruleId: 'fixed-1', key: '武汉仓', category: '百慕达食材' },
        })}
      />,
    );

    expect(screen.getByText('按固定规则「武汉仓」归类')).toBeInTheDocument();
    expect(screen.getByText('查看识别详情')).toBeInTheDocument();
  });
});
