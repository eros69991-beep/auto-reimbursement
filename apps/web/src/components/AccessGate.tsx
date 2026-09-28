import { useState } from 'react';

import { api, setAccessCode } from '../api';

/**
 * 访问码输入页：后端开启 ACCESS_CODE_SHA256 后，任何 401 都会触发本页。
 * 验证通过后刷新页面，让所有数据请求携带新访问码重新加载。
 */
export function AccessGate({ onPassed }: { onPassed: () => void }): React.JSX.Element {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = code.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    setAccessCode(trimmed);
    try {
      await api.apiStatus();
      onPassed();
    } catch {
      setAccessCode('');
      setError('访问码不正确，请重试。');
      setBusy(false);
    }
  }

  return (
    <main className="page-content access-gate">
      <h2>请输入访问码</h2>
      <p>本系统包含财务数据，需要访问码才能继续使用。</p>
      {error !== null && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          访问码
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || code.trim() === ''}>
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </main>
  );
}
