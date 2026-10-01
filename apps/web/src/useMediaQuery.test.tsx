import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from './useMediaQuery';

const QUERY = '(max-width: 899px)';

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function installMatchMedia(initial: boolean, legacy = false) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const media = legacy
    ? {
      get matches() { return matches; },
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    }
    : {
      get matches() { return matches; },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => media) });
  return {
    listeners,
    change(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('useMediaQuery', () => {
  it('is false where the browser cannot answer (no matchMedia)', () => {
    const { result } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);
  });

  it('starts with the current answer and follows the window being resized or rotated', () => {
    const media = installMatchMedia(true);
    const { result, unmount } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(true);

    act(() => media.change(false));
    expect(result.current).toBe(false);
    act(() => media.change(true));
    expect(result.current).toBe(true);

    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('works with the old listener API of Safari before 14', () => {
    const media = installMatchMedia(false, true);
    const { result, unmount } = renderHook(() => useMediaQuery(QUERY));
    expect(result.current).toBe(false);

    act(() => media.change(true));
    expect(result.current).toBe(true);

    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
