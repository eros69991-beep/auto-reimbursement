import { useEffect, useState } from 'react';

import { fetchBlobUrl } from '../api';

/**
 * 通过带鉴权的 fetch 加载资源并转为 object URL。
 * 后端开启访问码后，<img src> 无法携带 Authorization 头，必须走这里。
 */
function revoke(url: string): void {
  // jsdom 等测试环境没有 URL.revokeObjectURL
  if (typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function useAuthedUrl(path: string | null): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (path === null) {
      setUrl(null);
      setFailed(false);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    Promise.resolve()
      .then(() => fetchBlobUrl(path))
      .then((created) => {
        if (!active) {
          revoke(created);
          return;
        }
        objectUrl = created;
        setUrl(created);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl !== null) revoke(objectUrl);
    };
  }, [path]);

  return { url, failed };
}

export function AuthedImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const { url, failed } = useAuthedUrl(path);

  if (failed) {
    return <span className={className} role="img" aria-label={alt}>图片加载失败</span>;
  }
  if (url === null) {
    return <span className={className} aria-hidden="true" />;
  }
  return <img className={className} src={url} alt={alt} loading="lazy" decoding="async" />;
}
