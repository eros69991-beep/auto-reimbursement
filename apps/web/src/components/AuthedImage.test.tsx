import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchBlobUrl } from '../api';

vi.mock('../api', () => ({ fetchBlobUrl: vi.fn() }));

import { AuthedImage, useAuthedUrl } from './AuthedImage';

describe('authenticated image loading', () => {
  beforeEach(() => {
    vi.mocked(fetchBlobUrl).mockReset().mockResolvedValue('blob:one');
  });
  afterEach(() => cleanup());

  it('loads the file with the access code and hands back an object URL', async () => {
    const { result } = renderHook(() => useAuthedUrl('/api/images/a?size=thumb'));

    await waitFor(() => expect(result.current.url).toBe('blob:one'));
    expect(result.current).toMatchObject({ failed: false, error: '' });
    expect(vi.mocked(fetchBlobUrl)).toHaveBeenCalledWith('/api/images/a?size=thumb', expect.any(AbortSignal));
  });

  it('keeps the reason when the file cannot be fetched', async () => {
    vi.mocked(fetchBlobUrl).mockRejectedValue(new Error('无法连接服务器，请检查网络后重试'));

    const { result } = renderHook(() => useAuthedUrl('/api/images/a'));

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current).toMatchObject({ url: null, error: '无法连接服务器，请检查网络后重试' });
  });

  it('cancels the download that is still running when the path changes or the component goes away', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(fetchBlobUrl).mockImplementation((_path, signal) => {
      signals.push(signal!);
      return new Promise(() => undefined);
    });
    const { rerender, unmount } = renderHook(({ path }) => useAuthedUrl(path), { initialProps: { path: '/api/images/a' as string | null } });
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ path: '/api/images/b' });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    unmount();
    expect(signals[1]!.aborted).toBe(true);
  });

  it('does not report the cancelled request as a failure', async () => {
    let rejectFirst: (reason: unknown) => void = () => undefined;
    vi.mocked(fetchBlobUrl)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce('blob:two');
    const { result, rerender } = renderHook(({ path }) => useAuthedUrl(path), { initialProps: { path: '/api/images/a' } });

    rerender({ path: '/api/images/b' });
    // 被取消的第一个请求以 AbortError 结束，不能让界面显示「加载失败」
    rejectFirst(new DOMException('The operation was aborted.', 'AbortError'));

    await waitFor(() => expect(result.current.url).toBe('blob:two'));
    expect(result.current).toMatchObject({ failed: false, error: '' });
  });

  it('shows the image, or a failure note, in the thumbnail component', async () => {
    const { rerender } = render(<AuthedImage path="/api/images/a" alt="缩略图" />);
    expect(await screen.findByRole('img', { name: '缩略图' })).toHaveAttribute('src', 'blob:one');

    vi.mocked(fetchBlobUrl).mockRejectedValue(new Error('加载失败'));
    rerender(<AuthedImage path="/api/images/b" alt="缩略图" />);
    expect(await screen.findByText('图片加载失败')).toBeInTheDocument();
  });
});
