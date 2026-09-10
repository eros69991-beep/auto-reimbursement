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
      : route === '#preview'
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
          <a href="#home">首页</a>
          <a href="#upload">上传凭证</a>
          <a href="#pool">本期报销池</a>
          <a href="#pending">待处理</a>
          <a href="#preview">生成预览</a>
          <a href="#history">历史报销单</a>
          <a href="#settings">设置</a>
        </nav>
      </header>
      {content}
    </>
  );
}
