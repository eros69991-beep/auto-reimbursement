import './styles.css';
import { useEffect, useState } from 'react';
import { api, UNAUTHORIZED_EVENT } from './api';
import { AccessGate } from './components/AccessGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PendingPage } from './pages/PendingPage';
import { PoolPage } from './pages/PoolPage';
import { UploadPage } from './pages/UploadPage';
import { PreviewPage } from './pages/PreviewPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

type NavKey = 'home' | 'upload' | 'pool' | 'pending' | 'preview' | 'history' | 'settings';

// P-28：直接进入 #preview（刷新后内存中没有选中批次）时，
// 自动跳到最近一个未撤销、未归档的草稿批次；没有草稿才显示引导
function LatestDraftPreview({ onResolve }: { onResolve: (id: string) => void }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'empty'>('loading');
  useEffect(() => {
    let active = true;
    void api.history().then((months) => {
      const draft = months
        .flatMap((month) => month.batches)
        .filter((batch) => batch.cancelledAt === null && batch.archivedAt === null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (draft !== undefined) {
        onResolve(draft.id);
        return;
      }
      if (active) setState('empty');
    }, () => {
      if (active) setState('empty');
    });
    return () => {
      active = false;
    };
    // onResolve 由 App 内联提供，每次渲染都是新引用；只在挂载时解析一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (state === 'loading') {
    return (
      <main className="page-content">
        <h2>生成预览</h2>
        <p>正在查找进行中的报销单…</p>
      </main>
    );
  }
  return (
    <main className="page-content">
      <h2>生成预览</h2>
      <p>请先在报销池生成报销单，或从历史报销单中选择一个批次。</p>
    </main>
  );
}

// P-14：导航当前页高亮
function activeNav(route: string): NavKey {
  if (route === '#pool') return 'pool';
  if (route === '#pending') return 'pending';
  if (route === '#preview' || /^#batches\/[^/]+\/preview$/.test(route)) return 'preview';
  if (route === '#history') return 'history';
  if (route === '#settings') return 'settings';
  if (route === '#upload') return 'upload';
  return 'home';
}

export default function App() {
  const [route, setRoute] = useState(window.location.hash);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [accessRequired, setAccessRequired] = useState(false);

  useEffect(() => {
    const handleHashChange = () => {
      // 必须等本次 hashchange 的全部监听器（含预览页 P-05 离开守卫）执行完再更新路由。
      // 同步 setRoute 或 queueMicrotask 都不行：浏览器派发事件时，每个监听器返回后
      // 都会做 microtask checkpoint（JS 栈已空），React 19 会在派发途中同步重渲染，
      // 把排在后面的守卫监听器直接卸载（e2e 复现）。宏任务才会在整次派发结束后运行。
      setTimeout(() => setRoute(window.location.hash), 0);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => setAccessRequired(true);
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  const previewId = /^#batches\/([^/]+)\/preview$/.exec(route)?.[1] ?? selectedBatch;
  const content = route === '#pool'
    ? <PoolPage onBatch={(id) => { setSelectedBatch(id); window.location.hash = `#batches/${id}/preview`; }} />
    : route === '#pending'
      ? <PendingPage />
      : (route === '#preview' || /^#batches\/[^/]+\/preview$/.test(route))
        ? previewId === null
          // P-28：没有选中批次时自动落到最近一个未撤销、未归档的草稿
          ? <LatestDraftPreview onResolve={(id) => { setSelectedBatch(id); window.location.hash = `#batches/${id}/preview`; }} />
          : <PreviewPage batchId={previewId} onCancelled={() => setSelectedBatch(null)} />
        : route === '#history'
          ? <HistoryPage onPreview={(id) => { setSelectedBatch(id); window.location.hash = `#batches/${id}/preview`; }} />
          : route === '#settings'
            ? <SettingsPage />
            : <UploadPage />;

  if (accessRequired) {
    return <AccessGate onPassed={() => window.location.reload()} />;
  }

  const nav = activeNav(route);
  const current = (key: NavKey): 'page' | undefined => (nav === key ? 'page' : undefined);

  return (
    <>
      <header className="app-header">
        <h1>自动报销助手</h1>
        <nav aria-label="主导航">
          <button type="button" aria-current={current('home')} onClick={() => { window.location.hash = '#home'; }}>首页</button>
          <button type="button" aria-current={current('upload')} onClick={() => { window.location.hash = '#upload'; }}>上传凭证</button>
          <button type="button" aria-current={current('pool')} onClick={() => { window.location.hash = '#pool'; }}>本期报销池</button>
          <button type="button" aria-current={current('pending')} onClick={() => { window.location.hash = '#pending'; }}>待处理</button>
          <button type="button" aria-current={current('preview')} onClick={() => { window.location.hash = '#preview'; }}>生成预览</button>
          <button type="button" aria-current={current('history')} onClick={() => { window.location.hash = '#history'; }}>历史报销单</button>
          <button type="button" aria-current={current('settings')} onClick={() => { window.location.hash = '#settings'; }}>设置</button>
        </nav>
      </header>
      <ErrorBoundary>{content}</ErrorBoundary>
    </>
  );
}
