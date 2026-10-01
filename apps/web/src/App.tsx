import './styles.css';
import { useEffect, useState } from 'react';
import { LEDGERS, type Ledger } from '@auto-reimbursement/contracts';
import { UNAUTHORIZED_EVENT } from './api';
import { apiFor } from './ledgerApi';
import { NAV_PAGES, parseRoute, routeHash, switchLedgerHash, type PageKey } from './routes';
import { LEDGER_NAMES, sayFor } from './wording';
import { AccessGate } from './components/AccessGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PendingPage } from './pages/PendingPage';
import { PoolPage } from './pages/PoolPage';
import { UploadPage } from './pages/UploadPage';
import { PreviewPage } from './pages/PreviewPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

// 导航栏上的字用店内的说法写，公账区由 sayFor 换成付款、回单（「生成预览」在公账区叫「付款单预览」）
const NAV_LABELS: Record<PageKey, string> = {
  home: '首页',
  upload: '上传凭证',
  pool: '本期报销池',
  pending: '待处理',
  preview: '生成预览',
  history: '历史报销单',
  settings: '设置',
};

// P-28：直接进入 #preview（刷新后内存中没有选中批次）时，
// 自动跳到最近一个未撤销、未归档、尚未生成 PDF 的草稿批次；没有草稿才显示引导。
// 注意：正常批次没有 cancelledAt 字段（只有撤销时才写入），不能用 === null 判断。
// 两个区各找各的草稿：公账区的预览不会落到店内的草稿上。
function LatestDraftPreview({ ledger, onResolve }: { ledger: Ledger; onResolve: (id: string) => void }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'empty'>('loading');
  const say = sayFor(ledger);
  useEffect(() => {
    let active = true;
    void apiFor(ledger).history().then((months) => {
      const draft = months
        .flatMap((month) => month.batches)
        .filter((batch) => !batch.cancelledAt && !batch.archivedAt && batch.pdfPath === null)
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
        <h2>{say('生成预览')}</h2>
        <p>{say('正在查找进行中的报销单…')}</p>
      </main>
    );
  }
  return (
    <main className="page-content">
      <h2>{say('生成预览')}</h2>
      <p>{say('请先在报销池生成报销单，或从历史报销单中选择一个批次。')}</p>
    </main>
  );
}

export default function App() {
  const [route, setRoute] = useState(window.location.hash);
  // 两个区各记各的当前批次，切换区时不会把一个区的批次拿到另一个区去预览
  const [selectedBatch, setSelectedBatch] = useState<Record<Ledger, string | null>>({ store: null, company: null });
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

  const current = parseRoute(route);
  const { ledger } = current;
  const say = sayFor(ledger);
  const go = (page: PageKey, batchId?: string): void => { window.location.hash = routeHash(ledger, page, batchId); };
  const selectBatch = (id: string | null): void => setSelectedBatch((previous) => ({ ...previous, [ledger]: id }));
  const openPreview = (id: string): void => { selectBatch(id); go('preview', id); };

  const previewId = current.batchId ?? selectedBatch[ledger];
  const content = current.page === 'pool'
    ? <PoolPage ledger={ledger} onBatch={openPreview} />
    : current.page === 'pending'
      ? <PendingPage ledger={ledger} />
      : current.page === 'preview'
        ? previewId === null
          // P-28：没有选中批次时自动落到最近一个未撤销、未归档的草稿
          ? <LatestDraftPreview ledger={ledger} onResolve={openPreview} />
          : <PreviewPage ledger={ledger} batchId={previewId} onCancelled={() => selectBatch(null)} />
        : current.page === 'history'
          ? <HistoryPage ledger={ledger} onPreview={openPreview} />
          : current.page === 'settings'
            ? <SettingsPage ledger={ledger} />
            : <UploadPage ledger={ledger} />;

  if (accessRequired) {
    return <AccessGate onPassed={() => window.location.reload()} />;
  }

  return (
    <>
      <header className="app-header" data-ledger={ledger}>
        <h1>自动报销助手</h1>
        {/* 店内报销和公账付款是两个互相隔离的区：凭证、池、待处理、历史、规则各用各的，在这里切换 */}
        <div className="ledger-switch" role="group" aria-label="切换区域">
          {LEDGERS.map((target) => (
            <button
              type="button"
              key={target}
              aria-pressed={target === ledger}
              onClick={() => { if (target !== ledger) window.location.hash = switchLedgerHash(current, target); }}
            >
              {LEDGER_NAMES[target]}
            </button>
          ))}
        </div>
        <nav aria-label="主导航">
          {NAV_PAGES[ledger].map((page) => (
            <button
              type="button"
              key={page}
              aria-current={current.page === page ? 'page' : undefined}
              onClick={() => go(page)}
            >
              {say(NAV_LABELS[page])}
            </button>
          ))}
        </nav>
      </header>
      {/* 换区时整页重新挂载：上一个区的列表、输入、弹窗都不能留到另一个区 */}
      <ErrorBoundary key={ledger}>{content}</ErrorBoundary>
    </>
  );
}
