import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Batch, Ledger } from '@auto-reimbursement/contracts';

// 渲染真实 App 会请求后端，所以和 App.test.tsx 一样把 api 整个换掉
const { batchApi, historyApi, cancelBatchApi, crash } = vi.hoisted(() => ({
  batchApi: vi.fn(),
  historyApi: vi.fn(),
  cancelBatchApi: vi.fn(),
  // 想让哪个替身页渲染时报错，就把它的名字放进来（测出错页用）
  crash: { page: null as string | null },
}));

vi.mock('./api', () => ({
  UNAUTHORIZED_EVENT: 'api:unauthorized',
  api: {
    batch: batchApi,
    history: historyApi,
    saveBatchOptions: vi.fn(),
    createBatchNote: vi.fn(),
    updateBatchNote: vi.fn(),
    moveGroup: vi.fn(),
    exportBatch: vi.fn(),
    cancelBatch: cancelBatchApi,
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed: vi.fn(),
}));

vi.mock('./components/PdfPreview', () => ({
  PdfPreview: ({ url }: { url: string }) => <div data-testid="pdf-preview" data-url={url} />,
}));

// 上传、池、待处理、历史、设置五页换成替身：这里只测 App 把「哪个区」和回调交给了对的页面，
// 页面自己的行为各有各的测试。替身带一个输入框，用来看换区时整页有没有重新挂载。
function stubPage(name: string) {
  return function Stub({ ledger, onBatch, onPreview }: { ledger?: Ledger; onBatch?: (id: string) => void; onPreview?: (id: string) => void }) {
    const [draft, setDraft] = useState('');
    if (crash.page === name) throw new Error('页面渲染失败');
    const open = onBatch ?? onPreview;
    return (
      <main data-testid="page" data-page={name} data-ledger={ledger}>
        <input aria-label="草稿" value={draft} onChange={(event) => setDraft(event.target.value)} />
        {open !== undefined && <button type="button" onClick={() => open(`${ledger}-${name}-batch`)}>选这个批次</button>}
      </main>
    );
  };
}
vi.mock('./pages/UploadPage', () => ({ UploadPage: stubPage('upload') }));
vi.mock('./pages/PoolPage', () => ({ PoolPage: stubPage('pool') }));
vi.mock('./pages/PendingPage', () => ({ PendingPage: stubPage('pending') }));
vi.mock('./pages/HistoryPage', () => ({ HistoryPage: stubPage('history') }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: stubPage('settings') }));

import App from './App';

function batch(id: string, ledger: Ledger, overrides: Partial<Batch> = {}): Batch {
  return {
    id,
    ...(ledger === 'company' ? { ledger } : {}),
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 0,
    items: [],
    sheets: [],
    options: {
      department: ledger === 'company' ? '武汉市火门里餐饮管理有限公司' : '武汉测试店',
      date: '2026-09-26',
      signerMode: 'text',
      signerName: '测试经办人',
      signature: null,
    },
    notes: [],
    pdfPath: null,
    archivedAt: null,
    ...overrides,
  };
}

const storeDraft = batch('store-draft', 'store');
const companyDraft = batch('company-draft', 'company');

function page(): HTMLElement {
  return screen.getByTestId('page');
}

function switchTo(name: '店内报销' | '公账付款'): void {
  fireEvent.click(within(screen.getByRole('group', { name: '切换区域' })).getByRole('button', { name }));
}

async function arrivesAt(hash: string): Promise<void> {
  await waitFor(() => expect(window.location.hash).toBe(hash));
}

describe('App with two ledgers', () => {
  beforeEach(() => {
    batchApi.mockImplementation(async (id: string) => (id.startsWith('company') ? batch(id, 'company') : batch(id, 'store')));
    historyApi.mockImplementation(async (ledger?: Ledger) => [{ month: '2026-09', batches: [ledger === 'company' ? companyDraft : storeDraft] }]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    crash.page = null;
    window.location.hash = '';
  });

  describe('the header', () => {
    it('keeps the title and puts a switch between the two ledgers beside it, the current one pressed', () => {
      window.location.hash = '#home';
      render(<App />);

      expect(screen.getByRole('heading', { name: '自动报销助手' })).toBeInTheDocument();
      const buttons = within(screen.getByRole('group', { name: '切换区域' })).getAllByRole('button');
      expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
        ['店内报销', 'true'],
        ['公账付款', 'false'],
      ]);
      expect(screen.getByRole('banner')).toHaveAttribute('data-ledger', 'store');
    });

    it('presses the company button, and marks the header, on a company address', () => {
      window.location.hash = '#company/history';
      render(<App />);

      const buttons = within(screen.getByRole('group', { name: '切换区域' })).getAllByRole('button');
      expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
        ['店内报销', 'false'],
        ['公账付款', 'true'],
      ]);
      expect(screen.getByRole('banner')).toHaveAttribute('data-ledger', 'company');
      expect(screen.getByRole('heading', { name: '自动报销助手' })).toBeInTheDocument();
    });

    it('keeps the store navigation exactly as it was', () => {
      window.location.hash = '#pool';
      render(<App />);

      const nav = within(screen.getByRole('navigation', { name: '主导航' })).getAllByRole('button');
      expect(nav.map((button) => button.textContent)).toEqual(['首页', '上传凭证', '本期报销池', '待处理', '生成预览', '历史报销单', '设置']);
      expect(nav.filter((button) => button.getAttribute('aria-current') === 'page').map((button) => button.textContent)).toEqual(['本期报销池']);
    });

    it('names the company navigation in payment words, with no 首页', () => {
      window.location.hash = '#company/pool';
      render(<App />);

      const nav = within(screen.getByRole('navigation', { name: '主导航' })).getAllByRole('button');
      expect(nav.map((button) => button.textContent)).toEqual(['上传回单', '本期付款池', '待处理', '付款单预览', '历史付款单', '设置']);
      expect(nav.filter((button) => button.getAttribute('aria-current') === 'page').map((button) => button.textContent)).toEqual(['本期付款池']);
    });

    it('marks the upload page as current on the bare #company address', () => {
      window.location.hash = '#company';
      render(<App />);

      expect(screen.getByRole('button', { name: '上传回单' })).toHaveAttribute('aria-current', 'page');
    });
  });

  describe('which page and ledger the address opens', () => {
    it.each([
      ['#company', 'upload'],
      ['#company/upload', 'upload'],
      ['#company/pool', 'pool'],
      ['#company/pending', 'pending'],
      ['#company/history', 'history'],
      ['#company/settings', 'settings'],
      ['#company/anything-else', 'upload'],
    ])('opens the company %s as the company %s page', (hash, name) => {
      window.location.hash = hash;
      render(<App />);

      expect(page()).toHaveAttribute('data-page', name);
      expect(page()).toHaveAttribute('data-ledger', 'company');
    });

    it.each([
      ['#home', 'upload'],
      ['#upload', 'upload'],
      ['#pool', 'pool'],
      ['#pending', 'pending'],
      ['#history', 'history'],
      ['#settings', 'settings'],
      ['#', 'upload'],
    ])('opens the store %s as the store %s page', (hash, name) => {
      window.location.hash = hash;
      render(<App />);

      expect(page()).toHaveAttribute('data-page', name);
      expect(page()).toHaveAttribute('data-ledger', 'store');
    });

    it('does not take #companyx for the company ledger', () => {
      window.location.hash = '#companyx';
      render(<App />);

      expect(page()).toHaveAttribute('data-ledger', 'store');
    });
  });

  describe('moving around', () => {
    it.each([
      ['#company', '本期付款池', '#company/pool'],
      ['#company/pool', '付款单预览', '#company/preview'],
      ['#company/pool', '历史付款单', '#company/history'],
      ['#company/history', '上传回单', '#company/upload'],
      ['#pool', '历史报销单', '#history'],
      ['#home', '生成预览', '#preview'],
      ['#pool', '首页', '#home'],
    ])('on %s the button %s goes to %s', async (from, button, to) => {
      window.location.hash = from;
      render(<App />);

      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: button }));

      await arrivesAt(to);
    });

    it.each([
      ['#home', '#company/upload'],
      ['#upload', '#company/upload'],
      ['#pool', '#company/pool'],
      ['#pending', '#company/pending'],
      ['#history', '#company/history'],
      ['#settings', '#company/settings'],
      ['#batches/store-draft/preview', '#company/preview'],
    ])('switching to the company from the store %s lands on %s', async (from, to) => {
      window.location.hash = from;
      render(<App />);

      switchTo('公账付款');

      await arrivesAt(to);
      await waitFor(() => expect(screen.getByRole('banner')).toHaveAttribute('data-ledger', 'company'));
    });

    it.each([
      ['#company', '#upload'],
      ['#company/upload', '#upload'],
      ['#company/pool', '#pool'],
      ['#company/pending', '#pending'],
      ['#company/history', '#history'],
      ['#company/settings', '#settings'],
      ['#company/batches/company-draft/preview', '#preview'],
    ])('switching back to the store from the company %s lands on %s', async (from, to) => {
      window.location.hash = from;
      render(<App />);

      switchTo('店内报销');

      await arrivesAt(to);
    });

    it('leaves the address alone when the ledger that is already open is pressed', () => {
      window.location.hash = '#company';
      render(<App />);

      switchTo('公账付款');

      expect(window.location.hash).toBe('#company');
    });

    it('renders the other ledger from scratch: what was typed or opened on the page does not follow', async () => {
      window.location.hash = '#upload';
      render(<App />);
      fireEvent.change(screen.getByLabelText('草稿'), { target: { value: '店内写了一半' } });
      expect(screen.getByLabelText('草稿')).toHaveValue('店内写了一半');

      switchTo('公账付款');

      await waitFor(() => expect(page()).toHaveAttribute('data-ledger', 'company'));
      expect(screen.getByLabelText('草稿')).toHaveValue('');
    });
  });

  describe('opening a preview', () => {
    it('opens a company batch from its address in payment words, asking for that batch only', async () => {
      window.location.hash = '#company/batches/company-draft/preview';
      render(<App />);

      expect(await screen.findByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
      expect(batchApi).toHaveBeenCalledWith('company-draft');
      expect(historyApi).not.toHaveBeenCalled();
    });

    it.each([
      ['company', '#company/batches/company-draft/preview', '付款单预览'],
      ['store', '#batches/store-draft/preview', '生成预览'],
    ])('already calls the %s preview by its own name while the batch is loading, and when it cannot be loaded', async (_ledger, hash, heading) => {
      batchApi.mockReturnValueOnce(new Promise(() => undefined));
      window.location.hash = hash;
      const loading = render(<App />);
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.getByText('正在加载预览…')).toBeInTheDocument();
      loading.unmount();

      batchApi.mockRejectedValueOnce(new Error('找不到这个批次'));
      render(<App />);
      expect(await screen.findByRole('alert')).toHaveTextContent('找不到这个批次');
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    });

    it('opens a store batch from its address as before', async () => {
      window.location.hash = '#batches/store-draft/preview';
      render(<App />);

      expect(await screen.findByRole('heading', { name: '生成预览' })).toBeInTheDocument();
      expect(batchApi).toHaveBeenCalledWith('store-draft');
    });

    it('jumps from #company/preview to the latest draft of the company, not of the store', async () => {
      const finalized = batch('company-final', 'company', { createdAt: '2026-09-29T00:00:00.000Z', pdfPath: '2026-09/exports/x.pdf' });
      const cancelled = batch('company-cancelled', 'company', { createdAt: '2026-09-30T00:00:00.000Z', cancelledAt: '2026-09-30T01:00:00.000Z' });
      const archived = batch('company-archived', 'company', { createdAt: '2026-09-28T12:00:00.000Z', archivedAt: '2026-09-29T00:00:00.000Z' });
      const older = batch('company-older', 'company', { createdAt: '2026-09-20T00:00:00.000Z' });
      historyApi.mockImplementation(async (ledger?: Ledger) => (
        ledger === 'company'
          ? [{ month: '2026-09', batches: [cancelled, finalized, archived, older, companyDraft] }]
          : [{ month: '2026-09', batches: [storeDraft] }]
      ));
      window.location.hash = '#company/preview';
      render(<App />);

      await arrivesAt('#company/batches/company-draft/preview');
      expect(historyApi).toHaveBeenCalledWith('company');
      expect(historyApi).not.toHaveBeenCalledWith();
      expect(await screen.findByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
    });

    it('jumps from #preview to the latest draft of the store, asking the store history', async () => {
      window.location.hash = '#preview';
      render(<App />);

      await arrivesAt('#batches/store-draft/preview');
      expect(historyApi).toHaveBeenCalledWith();
      expect(historyApi).not.toHaveBeenCalledWith('company');
    });

    it('guides the company to make a payment form first when it has no draft, in payment words', async () => {
      historyApi.mockResolvedValue([{ month: '2026-09', batches: [batch('company-final', 'company', { pdfPath: 'x.pdf' })] }]);
      window.location.hash = '#company/preview';
      render(<App />);

      expect(await screen.findByText('请先在付款池生成付款单，或从历史付款单中选择一个批次。')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
      expect(window.location.hash).toBe('#company/preview');
    });

    it('guides the store the way it always did when it has no draft', async () => {
      historyApi.mockResolvedValue([]);
      window.location.hash = '#preview';
      render(<App />);

      expect(await screen.findByText('请先在报销池生成报销单，或从历史报销单中选择一个批次。')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '生成预览' })).toBeInTheDocument();
    });

    it('also shows the guidance when the history cannot be loaded', async () => {
      historyApi.mockRejectedValue(new Error('网络错误'));
      window.location.hash = '#company/preview';
      render(<App />);

      expect(await screen.findByText('请先在付款池生成付款单，或从历史付款单中选择一个批次。')).toBeInTheDocument();
    });

    it('says it is looking for the draft in payment words while the history loads', () => {
      historyApi.mockReturnValue(new Promise(() => undefined));
      window.location.hash = '#company/preview';
      render(<App />);

      expect(screen.getByText('正在查找进行中的付款单…')).toBeInTheDocument();
    });

    it('opens the batch that a company page picks, in the company address', async () => {
      window.location.hash = '#company/pool';
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: '选这个批次' }));

      await arrivesAt('#company/batches/company-pool-batch/preview');
      expect(await screen.findByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
      expect(batchApi).toHaveBeenCalledWith('company-pool-batch');
    });

    it('opens the batch that a store page picks, in the store address', async () => {
      window.location.hash = '#history';
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: '选这个批次' }));

      await arrivesAt('#batches/store-history-batch/preview');
      await waitFor(() => expect(batchApi).toHaveBeenCalledWith('store-history-batch'));
    });

    it('remembers the open batch of each ledger separately and never shows one in the other', async () => {
      window.location.hash = '#history';
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: '选这个批次' }));
      await arrivesAt('#batches/store-history-batch/preview');
      await screen.findByRole('heading', { name: '生成预览' });

      // 切到公账区：店内选中的批次不跟过去，公账区自己去找最近的草稿
      switchTo('公账付款');
      await arrivesAt('#company/batches/company-draft/preview');
      expect(historyApi).toHaveBeenCalledWith('company');
      expect(batchApi).not.toHaveBeenCalledWith('company-history-batch');
      expect(await screen.findByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
      historyApi.mockClear();
      batchApi.mockClear();

      // 切回店内区：回到店内刚才选的批次，不用再去找草稿，也不会带上公账的
      switchTo('店内报销');
      await arrivesAt('#preview');
      await waitFor(() => expect(batchApi).toHaveBeenCalledWith('store-history-batch'));
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
      expect(historyApi).not.toHaveBeenCalled();
    });

    it('remembers the company batch when the company page is reopened from the store', async () => {
      window.location.hash = '#company/history';
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: '选这个批次' }));
      await arrivesAt('#company/batches/company-history-batch/preview');
      await screen.findByRole('heading', { name: '付款单预览' });
      batchApi.mockClear();

      // 店内区没有选中的批次，自己去找最近的草稿
      switchTo('店内报销');
      await arrivesAt('#batches/store-draft/preview');
      await screen.findByRole('heading', { name: '生成预览' });
      expect(batchApi).not.toHaveBeenCalledWith('company-history-batch');
      historyApi.mockClear();
      batchApi.mockClear();

      // 回到公账区：还是公账刚才选的批次，不用再去找草稿，也不会带上店内的
      switchTo('公账付款');
      await arrivesAt('#company/preview');
      await waitFor(() => expect(batchApi).toHaveBeenCalledWith('company-history-batch'));
      expect(batchApi).not.toHaveBeenCalledWith('store-draft');
      expect(historyApi).not.toHaveBeenCalled();
    });

    it.each([
      ['company', '#company/pool', '撤销并退回付款池', '付款单预览', '#company/batches/company-draft/preview'],
      ['store', '#pool', '撤销并退回报销池', '生成预览', '#batches/store-draft/preview'],
    ] as const)('forgets the open %s batch once it is cancelled: the next preview looks for a draft instead of reopening it', async (ledger, pool, cancelButton, previewButton, draftHash) => {
      const picked = `${ledger}-pool-batch`;
      batchApi.mockImplementation(async (id: string) => batch(id, id.startsWith('company') ? 'company' : 'store', id === picked ? { pdfPath: '2026-09/exports/x.pdf' } : {}));
      cancelBatchApi.mockResolvedValue(undefined);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      window.location.hash = pool;
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: '选这个批次' }));
      fireEvent.click(await screen.findByRole('button', { name: cancelButton }));

      await waitFor(() => expect(cancelBatchApi).toHaveBeenCalledWith(picked));
      await arrivesAt(pool);
      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'pool'));
      batchApi.mockClear();
      historyApi.mockClear();
      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: previewButton }));

      await arrivesAt(draftHash);
      expect(batchApi).not.toHaveBeenCalledWith(picked);
      expect(historyApi).toHaveBeenCalled();
    });
  });

  // 找草稿的请求回来之前，用户可能已经换了区、或者去了别的页面：请求回来后不能再把人拉回预览页
  describe('looking for the latest draft while the user moves on', () => {
    function slowHistory(): { resolve: (value: unknown) => void } {
      let resolve: (value: unknown) => void = () => undefined;
      const pending = new Promise((done) => { resolve = done; });
      historyApi.mockImplementation((ledger?: Ledger) => (
        ledger === 'company' ? pending : Promise.resolve([{ month: '2026-09', batches: [storeDraft] }])
      ));
      return { resolve };
    }

    async function settle(): Promise<void> {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 30));
      });
    }

    it('does not pull the user back to the company preview after they switched to the store', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);
      expect(screen.getByText('正在查找进行中的付款单…')).toBeInTheDocument();

      switchTo('店内报销');
      await arrivesAt('#batches/store-draft/preview');
      await screen.findByRole('heading', { name: '生成预览' });
      await act(async () => { slow.resolve([{ month: '2026-09', batches: [companyDraft] }]); });
      await settle();

      expect(window.location.hash).toBe('#batches/store-draft/preview');
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
      expect(screen.getByRole('banner')).toHaveAttribute('data-ledger', 'store');
    });

    it('does not pull the user to the preview after they went to another page of the same ledger', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);

      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '历史付款单' }));
      await arrivesAt('#company/history');
      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'history'));
      await act(async () => { slow.resolve([{ month: '2026-09', batches: [companyDraft] }]); });
      await settle();

      expect(window.location.hash).toBe('#company/history');
      expect(page()).toHaveAttribute('data-page', 'history');
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
    });

    it('does not remember the draft for the ledger the user already left either', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);
      switchTo('店内报销');
      await arrivesAt('#batches/store-draft/preview');
      await act(async () => { slow.resolve([{ month: '2026-09', batches: [companyDraft] }]); });
      await settle();
      batchApi.mockClear();

      // 回到公账区的预览：没有记住的批次，自己重新找草稿，而不是直接打开刚才那个迟到的结果
      historyApi.mockImplementation(async (ledger?: Ledger) => [{ month: '2026-09', batches: [ledger === 'company' ? batch('company-newer', 'company') : storeDraft] }]);
      switchTo('公账付款');

      await arrivesAt('#company/batches/company-newer/preview');
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
    });

    it('still opens the draft when the user stays on the preview page', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);

      await act(async () => { slow.resolve([{ month: '2026-09', batches: [companyDraft] }]); });

      await arrivesAt('#company/batches/company-draft/preview');
    });

    it('lets only the visit that asked decide: an old answer is ignored after the user left the preview page and came back to it', async () => {
      const answers: Array<(value: unknown) => void> = [];
      historyApi.mockImplementation((ledger?: Ledger) => (
        ledger === 'company'
          ? new Promise((done) => { answers.push(done); })
          : Promise.resolve([{ month: '2026-09', batches: [storeDraft] }])
      ));
      window.location.hash = '#company/preview';
      render(<App />);
      const nav = (): ReturnType<typeof within> => within(screen.getByRole('navigation', { name: '主导航' }));

      fireEvent.click(nav().getByRole('button', { name: '历史付款单' }));
      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'history'));
      fireEvent.click(nav().getByRole('button', { name: '付款单预览' }));
      // 回到预览页后重新问了一次；第一次的答复这时才到，不能抢着决定打开哪个草稿
      await waitFor(() => expect(answers).toHaveLength(2));
      await act(async () => { answers[0]!([{ month: '2026-09', batches: [companyDraft] }]); });
      await settle();

      expect(window.location.hash).toBe('#company/preview');
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
      await act(async () => { answers[1]!([{ month: '2026-09', batches: [batch('company-newer', 'company')] }]); });
      await arrivesAt('#company/batches/company-newer/preview');
    });

    // 点按钮时地址当场就变了，页面要等下一个任务才跟着换：请求恰好在这个空档回来，组件还没卸载。
    // 下面只放行 promise 的回调、不放行定时器，空档就一直开着
    async function answerInTheGap(slow: { resolve: (value: unknown) => void }): Promise<void> {
      slow.resolve([{ month: '2026-09', batches: [companyDraft] }]);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    }

    it('does not pull the user back either when the answer comes in the instant after pressing the store button', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);

      switchTo('店内报销');
      expect(window.location.hash).toBe('#preview');
      await answerInTheGap(slow);

      expect(window.location.hash).toBe('#preview');
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
      await arrivesAt('#batches/store-draft/preview');
      expect(screen.getByRole('banner')).toHaveAttribute('data-ledger', 'store');
    });

    it('does not pull the user back either when the answer comes in the instant after pressing another page of the same ledger', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);

      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '历史付款单' }));
      expect(window.location.hash).toBe('#company/history');
      await answerInTheGap(slow);

      expect(window.location.hash).toBe('#company/history');
      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'history'));
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
    });

    it('does not open a draft either when the address was typed to a batch of its own in that instant', async () => {
      const slow = slowHistory();
      window.location.hash = '#company/preview';
      render(<App />);

      window.location.hash = '#company/batches/company-typed/preview';
      await answerInTheGap(slow);

      expect(window.location.hash).toBe('#company/batches/company-typed/preview');
      await waitFor(() => expect(batchApi).toHaveBeenCalledWith('company-typed'));
      expect(batchApi).not.toHaveBeenCalledWith('company-draft');
    });
  });

  // 页面渲染出错时只显示出错页；它的「返回」要回到当前这个区自己的第一页
  describe('when a page breaks', () => {
    it.each([
      { ledger: 'store', from: '#pool', name: '首页', to: '#home' },
      { ledger: 'company', from: '#company/pool', name: '上传回单', to: '#company/upload' },
    ])('the $ledger error page leads back to $to, in its own ledger', async ({ ledger, from, name, to }) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      crash.page = 'pool';
      window.location.hash = from;
      render(<App />);

      expect(screen.getByRole('alert')).toHaveTextContent(`页面渲染时发生错误，请返回${name}重试`);
      // 出错的那一页还是会崩（脏数据没变）：点「返回」后出错页先留着，等地址真的换了才放手
      fireEvent.click(screen.getByRole('button', { name: `返回${name}` }));
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await arrivesAt(to);
      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'upload'));
      expect(page()).toHaveAttribute('data-ledger', ledger);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lets the user leave a broken page with the navigation bar too, not only with the back button', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      crash.page = 'pool';
      window.location.hash = '#company/pool';
      render(<App />);
      expect(screen.getByRole('alert')).toBeInTheDocument();

      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '历史付款单' }));

      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'history'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the error page again if the page the user moved to breaks too, and lets them move on once more', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      crash.page = 'pool';
      window.location.hash = '#company/pool';
      render(<App />);

      crash.page = 'history';
      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '历史付款单' }));
      await arrivesAt('#company/history');
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(screen.queryByTestId('page')).not.toBeInTheDocument();

      crash.page = null;
      fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '设置' }));

      await waitFor(() => expect(page()).toHaveAttribute('data-page', 'settings'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
