import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { progress: vi.fn() } }));

import { api } from './api';
import { useRecognitionWatch, type WatchOutcome } from './useRecognitionWatch';

const progress = api.progress as unknown as ReturnType<typeof vi.fn>;

const recognizing = (count: number) => ({ total: 1, recognizing: count, ready: 0, pending: 0 });

let watch: (ids: string[]) => void;
let watching = false;
const settled: Array<{ outcome: WatchOutcome; reason?: unknown }> = [];

function Harness(): null {
  const result = useRecognitionWatch((outcome, reason) => settled.push({ outcome, reason }));
  watch = result.watch;
  watching = result.watching;
  return null;
}

// 让正在等待的异步任务（progress 的 Promise）先跑完
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRecognitionWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    settled.length = 0;
    watching = false;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does nothing until there is something to watch', async () => {
    render(<Harness />);
    await flush();

    expect(progress).not.toHaveBeenCalled();
    expect(watching).toBe(false);
  });

  it('asks once a second until nothing is recognizing any more, then reports done', async () => {
    progress
      .mockResolvedValueOnce(recognizing(1))
      .mockResolvedValueOnce(recognizing(1))
      .mockResolvedValue(recognizing(0));
    render(<Harness />);

    act(() => watch(['m']));
    await flush();
    expect(progress).toHaveBeenCalledWith(['m']);
    expect(watching).toBe(true);
    expect(settled).toEqual([]);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(settled).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(progress).toHaveBeenCalledTimes(3);
    expect(settled).toEqual([{ outcome: 'done', reason: undefined }]);
    expect(watching).toBe(false);

    // 报告过就不再问了
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it('gives up after a minute of polling and reports a timeout', async () => {
    progress.mockResolvedValue(recognizing(1));
    render(<Harness />);

    act(() => watch(['m']));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });

    expect(progress).toHaveBeenCalledTimes(60);
    expect(settled).toEqual([{ outcome: 'timeout', reason: undefined }]);
    expect(watching).toBe(false);
  });

  it('reports an error, with the reason, when the progress check fails', async () => {
    const failure = new Error('网络错误');
    progress.mockRejectedValue(failure);
    render(<Harness />);

    act(() => watch(['m']));
    await flush();

    expect(settled).toEqual([{ outcome: 'error', reason: failure }]);
    expect(watching).toBe(false);
  });

  it('stops asking when the page goes away', async () => {
    progress.mockResolvedValue(recognizing(1));
    const view = render(<Harness />);
    act(() => watch(['m']));
    await flush();
    expect(progress).toHaveBeenCalledTimes(1);

    view.unmount();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(progress).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([]);
  });
});
