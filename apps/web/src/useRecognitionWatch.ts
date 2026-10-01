import { useEffect, useRef, useState } from 'react';

import { api } from './api';

const POLL_INTERVAL_MS = 1_000;
// 最多等 60 次（约一分钟）：AI 偶尔很慢，等太久就先把列表刷新出来，让用户知道还在识别
const MAX_POLLS = 60;

export type WatchOutcome = 'done' | 'timeout' | 'error';

/**
 * 合并截图后，拼出来的新凭证要重新识别。watch(ids) 之后每秒问一次进度，
 * 识别完（或等得太久、或进度查询失败）就调用一次 onSettled，由页面去刷新自己的列表。
 */
export function useRecognitionWatch(
  onSettled: (outcome: WatchOutcome, reason?: unknown) => void,
): { watching: boolean; watch: (ids: string[]) => void } {
  const [ids, setIds] = useState<string[]>([]);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  useEffect(() => {
    if (ids.length === 0) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const poll = async (): Promise<void> => {
      polls += 1;
      try {
        const progress = await api.progress(ids);
        if (disposed) return;
        if (progress.recognizing > 0 && polls < MAX_POLLS) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        setIds([]);
        settled.current(progress.recognizing > 0 ? 'timeout' : 'done');
      } catch (reason) {
        if (disposed) return;
        setIds([]);
        settled.current('error', reason);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ids]);

  return { watching: ids.length > 0, watch: setIds };
}
