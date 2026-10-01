import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UploadResult } from '@auto-reimbursement/contracts';
import { receipt } from '../test/fixtures';

const { restoreReceipt } = vi.hoisted(() => ({ restoreReceipt: vi.fn() }));

vi.mock('../api', () => ({
  api: {
    restoreReceipt,
    apiStatus: vi.fn().mockResolvedValue({ configured: true, provider: 'test' }),
    openAuthed: vi.fn(),
  },
}));

import { UploadPage } from './UploadPage';

function clientWith(result: UploadResult) {
  return {
    upload: vi.fn().mockResolvedValue(result),
    progress: vi.fn().mockResolvedValue({ total: 0, recognizing: 0, ready: 0, pending: 0 }),
    imageUrl: (id: string) => `/api/images/${id}`,
    receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
  };
}

// P-32：删除后重新上传同一张图，应提示「在回收站」并可直接恢复
describe('deleted duplicate restore (P-32)', () => {
  it('offers a recycle-bin restore for DELETED_DUPLICATE rejections', async () => {
    restoreReceipt.mockResolvedValue(receipt({ id: 'r1', merchant: '沃尔玛', category: '食材', paidFen: 12000 }));
    const client = clientWith({
      accepted: [],
      rejected: [{ index: 0, code: 'DELETED_DUPLICATE', duplicateId: 'r1' }],
    });

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    const restore = await screen.findByRole('button', { name: '从回收站恢复' });
    expect(screen.getByText(/重复文件（在回收站）/)).toBeInTheDocument();
    fireEvent.click(restore);

    expect(restoreReceipt).toHaveBeenCalledWith('r1');
    // 提示里写「分类 · 金额」，不用商户名
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('已从回收站恢复 食材 · 120.00');
    expect(notice).not.toHaveTextContent('沃尔玛');
  });

  it('keeps the original-image link for normal duplicates', async () => {
    const client = clientWith({
      accepted: [],
      rejected: [{ index: 0, code: 'EXACT_DUPLICATE', duplicateId: 'r2' }],
    });

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })] },
    });

    expect(await screen.findByRole('link', { name: '查看重复凭证' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从回收站恢复' })).not.toBeInTheDocument();
  });
});

// 试点反馈 3：同一单的几张截图合并后，再上传其中一张，要说清楚它已经在哪一单里
describe('merged duplicate', () => {
  it('says the screenshot was merged into another receipt and links to the merged picture', async () => {
    const client = clientWith({
      accepted: [],
      rejected: [{ index: 0, code: 'MERGED_DUPLICATE', duplicateId: 'merged-1' }],
    });

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [new File(['x'], 'part-1.jpg', { type: 'image/jpeg' })] },
    });

    expect(await screen.findByText(/重复文件（已合并进某一单）/)).toBeInTheDocument();
    expect(screen.getByText(/part-1\.jpg/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看合并后的凭证' })).toHaveAttribute(
      'href',
      '/api/receipts/merged-1/original-image',
    );
    expect(screen.queryByRole('link', { name: '查看重复凭证' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从回收站恢复' })).not.toBeInTheDocument();
  });
});
