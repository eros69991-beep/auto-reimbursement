import './styles.css';
import { useEffect, useState } from 'react';
import { PendingPage } from './pages/PendingPage';
import { PoolPage } from './pages/PoolPage';
import { UploadPage } from './pages/UploadPage';

export default function App() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const content = route === '#pool'
    ? <PoolPage onBatch={(id) => { window.location.hash = `#batches/${id}/preview`; }} />
    : route === '#pending'
      ? <PendingPage />
      : <UploadPage />;

  return (
    <>
      <header className="app-header">
        <h1>Automatic Reimbursement Assistant</h1>
        <nav aria-label="主导航">
          <a href="#home">首页</a>
          <a href="#upload">上传凭证</a>
          <a href="#pool">报销池</a>
          <a href="#pending">异常处理</a>
        </nav>
      </header>
      {content}
    </>
  );
}
