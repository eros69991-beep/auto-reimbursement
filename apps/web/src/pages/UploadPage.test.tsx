import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Progress, UploadResult } from '@auto-reimbursement/contracts';
import { UploadPage } from './UploadPage';

const emptyProgress: Progress = { total: 0, recognizing: 0, ready: 0, pending: 0 };

afterEach(cleanup);

function uploadResult(acceptedIds: string[] = []): UploadResult {
  return {
    accepted: acceptedIds.map((id) => ({ id }) as UploadResult['accepted'][number]),
    rejected: []
  };
}

describe('UploadPage', () => {
  it('rejects a batch larger than fifty files before uploading', () => {
    const client = {
      upload: vi.fn().mockResolvedValue({ accepted: [], rejected: [] }),
      progress: vi.fn(),
      imageUrl: (id: string) => `/api/images/${id}`
    };

    render(<UploadPage client={client} />);

    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: {
        files: Array.from(
          { length: 51 },
          (_, index) => new File(['x'], `${index}.png`, { type: 'image/png' })
        )
      }
    });

    expect(screen.getByRole('alert')).toHaveTextContent('单次最多 50 张');
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('uploads dropped files in their received order', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult()),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`
    };
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.webp', { type: 'image/webp' });

    render(<UploadPage client={client} />);
    fireEvent.drop(screen.getByLabelText('拖放或选择凭证图片'), {
      dataTransfer: { files: [first, second] }
    });

    await waitFor(() => expect(client.upload).toHaveBeenCalledWith([first, second]));
  });

  it('shows rejected duplicate filenames with a link to the exact duplicate', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue({
        accepted: [],
        rejected: [{ index: 0, code: 'DUPLICATE_EXACT', duplicateId: 'receipt-2' }]
      } satisfies UploadResult),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`
    };

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [new File(['x'], 'duplicate.png', { type: 'image/png' })] }
    });

    expect(await screen.findByRole('list', { name: '被拒绝文件' })).toHaveTextContent(
      '重复文件：duplicate.png'
    );
    expect(screen.getByRole('link', { name: '查看重复凭证' })).toHaveAttribute(
      'href',
      '/api/images/receipt-2'
    );
  });

  it('offers a retry after progress polling fails', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult(['receipt-1'])),
      progress: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 }),
      imageUrl: (id: string) => `/api/images/${id}`
    };

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [new File(['x'], 'receipt.png', { type: 'image/png' })] }
    });

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('成功数：1')).toBeInTheDocument());
    expect(client.progress).toHaveBeenCalledTimes(2);
  });

  it('stops polling after recognition completes', async () => {
    vi.useFakeTimers();
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult(['receipt-1'])),
      progress: vi.fn().mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 }),
      imageUrl: (id: string) => `/api/images/${id}`
    };

    try {
      render(<UploadPage client={client} />);
      fireEvent.change(screen.getByLabelText('选择凭证图片'), {
        target: { files: [new File(['x'], 'receipt.png', { type: 'image/png' })] }
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(client.progress).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(client.progress).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
