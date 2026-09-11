import './styles.css';
import { useEffect, useState } from 'react';
import { PendingPage } from './pages/PendingPage';
import { PoolPage } from './pages/PoolPage';
import { UploadPage } from './pages/UploadPage';
import { PreviewPage } from './pages/PreviewPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  const [route, setRoute] = useState(window.location.hash);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const previewId = /^#batches\/([^/]+)\/preview$/.exec(route)?.[1] ?? selectedBatch;
  const content = route === '#pool'
    ? <PoolPage onBatch={(id) => { setSelectedBatch(id); window.location.hash = `#batches/${id}/preview`; }} />
    : route === '#pending'
      ? <PendingPage />
      : (route === '#preview' || /^#batches\/[^/]+\/preview$/.test(route))
        ? <PreviewPage batchId={previewId} />
        : route === '#history'
          ? <HistoryPage onPreview={(id) => { setSelectedBatch(id); window.location.hash = `#batches/${id}/preview`; }} />
          : route === '#settings'
            ? <SettingsPage />
            : <UploadPage />;

  return (
    <>
      <header className="app-header">
        <h1>Automatic Reimbursement Assistant</h1>
        <nav aria-label="主导航">
          <button type="button" onClick={() => { window.location.hash = '#home'; }}>首页</button>
          <button type="button" onClick={() => { window.location.hash = '#upload'; }}>上传凭证</button>
          <button type="button" onClick={() => { window.location.hash = '#pool'; }}>本期报销池</button>
          <button type="button" onClick={() => { window.location.hash = '#pending'; }}>待处理</button>
          <button type="button" onClick={() => { window.location.hash = '#preview'; }}>生成预览</button>
          <button type="button" onClick={() => { window.location.hash = '#history'; }}>历史报销单</button>
          <button type="button" onClick={() => { window.location.hash = '#settings'; }}>设置</button>
        </nav>
      </header>
      {content}
    </>
  );
}
