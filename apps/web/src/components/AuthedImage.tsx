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

/**
 * path 变了或组件卸载时，还没下完的请求会被取消：手机在慢网下连点「下一张」时，
 * 不会让好几张大图同时抢带宽，只下当前看的这一张。
 * error 是失败的原因（例如「无法连接服务器」「加载失败」），拿不到原因时为空字符串。
 */
export function useAuthedUrl(path: string | null): { url: string | null; failed: boolean; error: string } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (path === null) {
      setUrl(null);
      setFailed(false);
      setError('');
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setUrl(null);
    setFailed(false);
    setError('');
    Promise.resolve()
      .then(() => fetchBlobUrl(path, controller.signal))
      .then((created) => {
        if (!active) {
          revoke(created);
          return;
        }
        objectUrl = created;
        setUrl(created);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setFailed(true);
        setError(cause instanceof Error ? cause.message : '');
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl !== null) revoke(objectUrl);
    };
  }, [path]);

  return { url, failed, error };
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
