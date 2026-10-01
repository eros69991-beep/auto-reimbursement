import { useEffect, useState } from 'react';

function matchNow(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * 当前浏览器窗口是否匹配某个媒体查询，窗口大小变化（手机横竖屏切换）时跟着更新。
 * 测试环境（jsdom）没有 matchMedia 时一律当作不匹配。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchNow(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);
    update();
    // 老版本 Safari（14 以前）的 MediaQueryList 只有 addListener
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}
