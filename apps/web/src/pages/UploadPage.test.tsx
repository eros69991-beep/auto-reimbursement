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
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
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
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    };
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.webp', { type: 'image/webp' });

    render(<UploadPage client={client} />);
    fireEvent.drop(screen.getByLabelText('拖放凭证图片'), {
      dataTransfer: { files: [first, second] }
    });

    // P-12：upload 第二参是 XHR 进度回调，这里只断言文件顺序
    await waitFor(() => expect(client.upload).toHaveBeenCalled());
    expect(client.upload.mock.calls[0]?.[0]).toEqual([first, second]);
  });

  it('shows rejected duplicate filenames with a link to the exact duplicate', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue({
        accepted: [],
        rejected: [{ index: 0, code: 'DUPLICATE_EXACT', duplicateId: 'receipt-2' }]
      } satisfies UploadResult),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
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
      '/api/receipts/receipt-2/original-image'
    );
  });

  it('offers a retry after progress polling fails', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult(['receipt-1'])),
      progress: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ total: 1, recognizing: 0, ready: 1, pending: 0 }),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
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
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
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

  it('validates each file before upload and reports per-file reasons (P-12)', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult(['receipt-1'])),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    };
    const good = new File(['x'], 'good.png', { type: 'image/png' });
    const gif = new File(['x'], 'ani.gif', { type: 'image/gif' });
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [good, gif, big] }
    });

    // 只有合法文件进入上传
    await waitFor(() => expect(client.upload).toHaveBeenCalled());
    expect(client.upload.mock.calls[0]?.[0]).toEqual([good]);
    const failures = await screen.findByRole('list', { name: '上传失败文件' });
    expect(failures).toHaveTextContent('ani.gif：格式不支持');
    expect(failures).toHaveTextContent('big.png：超过 20 MB 限制');
    // 校验失败不可重试，不显示重试按钮
    expect(screen.queryByRole('button', { name: '重试失败文件' })).not.toBeInTheDocument();
  });

  it('resets the file input so re-selecting the same files fires change again (P-12)', async () => {
    const client = {
      upload: vi.fn().mockResolvedValue(uploadResult()),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    };

    render(<UploadPage client={client} />);
    const input = screen.getByLabelText('选择凭证图片') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] }
    });

    await waitFor(() => expect(client.upload).toHaveBeenCalled());
    expect(input.value).toBe('');
  });

  it('retries only the network-failed files without re-uploading the rest (P-12)', async () => {
    const client = {
      upload: vi.fn()
        .mockRejectedValueOnce(new Error('无法连接服务器，请检查网络后重试'))
        .mockResolvedValue(uploadResult(['receipt-1'])),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    };
    const file = new File(['x'], 'retry.png', { type: 'image/png' });

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), {
      target: { files: [file] }
    });

    const failures = await screen.findByRole('list', { name: '上传失败文件' });
    // 显示服务器/网络层给出的真实原因，而不是笼统的「网络错误」
    expect(failures).toHaveTextContent('retry.png：无法连接服务器，请检查网络后重试');

    fireEvent.click(screen.getByRole('button', { name: '重试失败文件' }));
    await waitFor(() => expect(client.upload).toHaveBeenCalledTimes(2));
    expect(client.upload.mock.calls[1]?.[0]).toEqual([file]);
    await waitFor(() => expect(screen.queryByRole('list', { name: '上传失败文件' })).not.toBeInTheDocument());
    expect(await screen.findByRole('list', { name: '已接收文件' })).toHaveTextContent('已接收：retry.png');
  });
  it('shows the server reason for a rate-limited batch and keeps earlier results after retrying it', async () => {
    const client = {
      upload: vi.fn(async (files: File[]) => {
        if (files.some((file) => file.name === 'd.png') && client.upload.mock.calls.length <= 2) {
          throw new Error('上传过于频繁，请稍后再试');
        }
        return uploadResult(files.map((file) => `id-${file.name}`));
      }),
      progress: vi.fn().mockResolvedValue(emptyProgress),
      imageUrl: (id: string) => `/api/images/${id}`,
      receiptOriginalUrl: (id: string) => `/api/receipts/${id}/original-image`,
    };
    const files = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => new File(['x'], name, { type: 'image/png' }));

    render(<UploadPage client={client} />);
    fireEvent.change(screen.getByLabelText('选择凭证图片'), { target: { files } });

    const failures = await screen.findByRole('list', { name: '上传失败文件' });
    expect(failures).toHaveTextContent('d.png：上传过于频繁，请稍后再试');
    expect(screen.getByRole('list', { name: '已接收文件' })).toHaveTextContent('已接收：c.png');

    fireEvent.click(screen.getByRole('button', { name: '重试失败文件' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: '上传失败文件' })).not.toBeInTheDocument());
    // 重试成功后追加，之前已接收的 a/b/c 仍在列表里
    const accepted = screen.getByRole('list', { name: '已接收文件' });
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) {
      expect(accepted).toHaveTextContent(`已接收：${name}`);
    }
  });
});
