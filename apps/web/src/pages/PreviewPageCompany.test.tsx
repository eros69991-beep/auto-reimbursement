import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Batch, FormGroup } from '@auto-reimbursement/contracts';

const { batchApi, saveBatchOptions, moveGroup, exportBatch, cancelBatch, openAuthed } = vi.hoisted(() => ({
  batchApi: vi.fn(),
  saveBatchOptions: vi.fn(),
  moveGroup: vi.fn(),
  exportBatch: vi.fn(),
  cancelBatch: vi.fn(),
  openAuthed: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    batch: batchApi,
    saveBatchOptions,
    createBatchNote: vi.fn(),
    updateBatchNote: vi.fn(),
    moveGroup,
    exportBatch,
    cancelBatch,
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed,
}));

vi.mock('../components/PdfPreview', () => ({
  PdfPreview: ({ url, ledger }: { url: string; ledger?: string }) => <div data-testid="pdf-preview" data-url={url} data-ledger={ledger ?? 'store'} />,
}));

import { PreviewPage } from './PreviewPage';

const meat: FormGroup = { category: '肉款', receiptIds: ['meat'], amountsFen: [1_290_949], totalFen: 1_290_949 };
const rent: FormGroup = { category: '店面租金', period: '2026-09', receiptIds: ['notice'], amountsFen: [2_281_410], totalFen: 2_281_410 };
const electricJuly: FormGroup = { category: '电费', period: '2026-07', receiptIds: ['notice'], amountsFen: [1_146_687], totalFen: 1_146_687 };
const electricAugust: FormGroup = { category: '电费', period: '2026-08', receiptIds: ['aug'], amountsFen: [90_000], totalFen: 90_000 };
const waterJuly: FormGroup = { category: '水费', period: '2026-07', receiptIds: ['notice'], amountsFen: [4_886], totalFen: 4_886 };

function companyBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 4_443_932,
    ledger: 'company',
    items: [],
    sheets: [{ id: 'sheet-1', noteId: null, groups: [meat, rent, electricJuly, waterJuly] }],
    options: {
      department: '武汉市火门里餐饮管理有限公司',
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

function storeBatch(overrides: Partial<Batch> = {}): Batch {
  return companyBatch({
    ledger: undefined,
    totalFen: 10_000,
    sheets: [{ id: 'sheet-1', noteId: null, groups: [{ category: '百慕达食材', receiptIds: ['a'], amountsFen: [10_000], totalFen: 10_000 }] }],
    options: { department: '武汉测试店', date: '2026-09-26', signerMode: 'text', signerName: '测试报销人甲', signature: null },
    ...overrides,
  });
}

describe('preview page for a company payment form', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    batchApi.mockResolvedValue(companyBatch());
  });

  it('talks about a payment form: title, options, payer and handler', async () => {
    render(<PreviewPage ledger="company" batchId="batch-1" />);

    expect(await screen.findByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '付款单选项' })).toBeInTheDocument();
    expect(screen.getByLabelText('付款单位')).toHaveValue('武汉市火门里餐饮管理有限公司');
    expect(screen.getByLabelText('经办人')).toHaveValue('测试经办人');
    expect(screen.queryByLabelText('部门')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('签名人')).not.toBeInTheDocument();
    expect(screen.queryByText(/报销/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '预览完整 PDF（未定稿，含回单页）' })).toBeInTheDocument();
  });

  it('takes its wording from the batch when the address did not say which ledger it is', async () => {
    render(<PreviewPage batchId="batch-1" />);

    expect(await screen.findByLabelText('付款单位')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
  });

  it('keeps the store words for a store batch', async () => {
    batchApi.mockResolvedValue(storeBatch());
    render(<PreviewPage batchId="batch-1" />);

    expect(await screen.findByLabelText('部门')).toHaveValue('武汉测试店');
    expect(screen.getByLabelText('签名人')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '生成预览' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '报销单选项' })).toBeInTheDocument();
  });

  it('shows the company title while the batch is loading and when none is chosen', async () => {
    batchApi.mockReturnValue(new Promise(() => undefined));
    const loading = render(<PreviewPage ledger="company" batchId="batch-1" />);
    expect(screen.getByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
    expect(screen.getByText('正在加载预览…')).toBeInTheDocument();
    loading.unmount();

    render(<PreviewPage ledger="company" batchId={null} />);
    expect(screen.getByRole('heading', { name: '付款单预览' })).toBeInTheDocument();
    expect(screen.getByText('请先在付款池生成付款单，或从历史付款单中选择一个批次。')).toBeInTheDocument();
  });

  it('lists the rows of the form in the order they appear, each with its month', async () => {
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await screen.findByRole('heading', { name: '分类顺序' });

    const rows = screen.getAllByRole('button', { name: '下一页' }).map((button) => button.closest('p')!.textContent?.replace(/\s+/g, ' ').trim());
    expect(rows).toEqual(['肉款 上一页 下一页', '店面租金（2026年9月） 上一页 下一页', '电费（2026年7月） 上一页 下一页', '水费（2026年7月） 上一页 下一页']);
    expect(screen.queryByText(/^食材/)).not.toBeInTheDocument();
  });

  it('moves a row with a month together with that month, and a row without one the way the store does', async () => {
    moveGroup.mockResolvedValue(companyBatch());
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await screen.findByRole('heading', { name: '分类顺序' });

    const electric = screen.getByText(/^电费（2026年7月）/).closest('p')!;
    fireEvent.click(within(electric).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(moveGroup).toHaveBeenCalledWith('batch-1', '电费', 1, '2026-07'));

    const meatRow = screen.getByText(/^肉款/).closest('p')!;
    fireEvent.click(within(meatRow).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(moveGroup).toHaveBeenCalledTimes(2));
    // 没有月份的行：调用写法和店内一模一样，不带第四个参数
    expect(moveGroup).toHaveBeenLastCalledWith('batch-1', '肉款', 1);
    expect(moveGroup.mock.calls[1]).toHaveLength(3);
  });

  it('treats the same category in two months as two rows that move on their own', async () => {
    batchApi.mockResolvedValue(companyBatch({
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [electricJuly] },
        { id: 'sheet-2', noteId: null, groups: [electricAugust] },
      ],
    }));
    moveGroup.mockResolvedValue(companyBatch());
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await screen.findByRole('heading', { name: '分类顺序' });

    const july = screen.getByText(/^电费（2026年7月）/).closest('p')!;
    const august = screen.getByText(/^电费（2026年8月）/).closest('p')!;
    // 7 月在第一页，不能再往前；8 月在第二页，可以往前
    expect(within(july).getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(within(august).getByRole('button', { name: '上一页' })).toBeEnabled();
    fireEvent.click(within(august).getByRole('button', { name: '上一页' }));

    await waitFor(() => expect(moveGroup).toHaveBeenCalledWith('batch-1', '电费', -1, '2026-08'));
  });

  it('locks a row that did not fit on one page, and says it in company words', async () => {
    batchApi.mockResolvedValue(companyBatch({
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [{ ...meat, part: 1 }] },
        { id: 'sheet-2', noteId: null, groups: [{ ...meat, part: 2 }, rent] },
      ],
    }));
    render(<PreviewPage ledger="company" batchId="batch-1" />);

    const splitRow = (await screen.findByText(/回单较多，分在第 1、2 页上，不能单独移动/)).closest('p')!;
    expect(splitRow).toHaveTextContent(/^肉款/);
    for (const name of ['上一页', '下一页']) expect(within(splitRow).getByRole('button', { name })).toBeDisabled();
    const rentRow = screen.getByText(/^店面租金（2026年9月）/).closest('p')!;
    expect(within(rentRow).getByRole('button', { name: '下一页' })).toBeEnabled();
  });

  it('tells the PDF preview which ledger it is showing, so it can skip the attachment pages', async () => {
    render(<PreviewPage ledger="company" batchId="batch-1" />);

    const preview = await screen.findByTestId('pdf-preview');
    expect(preview).toHaveAttribute('data-ledger', 'company');
  });

  it('opens the unfinished PDF under a payment-form file name', async () => {
    openAuthed.mockResolvedValue(undefined);
    render(<PreviewPage ledger="company" batchId="batch-1" />);

    fireEvent.click(await screen.findByRole('link', { name: '预览完整 PDF（未定稿，含回单页）' }));

    expect(openAuthed).toHaveBeenCalledWith('/api/batches/batch-1/preview.pdf?attachments=1', '付款单-2026-09-batch-1.pdf');
  });

  it('asks before locking, naming the payer and the handler in company words', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PreviewPage ledger="company" batchId="batch-1" />);

    fireEvent.click(await screen.findByRole('button', { name: '生成 PDF' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('生成后将锁定：付款单位 武汉市火门里餐饮管理有限公司、经办人 测试经办人、日期 2026-09-26。确定生成 PDF 吗？'));
    expect(exportBatch).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('explains a finished payment form and takes it back to the payment pool', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    batchApi.mockResolvedValue(companyBatch({ pdfPath: 'exports/batch-1.pdf' }));
    cancelBatch.mockResolvedValue(companyBatch({ cancelledAt: '2026-09-27' }));
    const onCancelled = vi.fn();
    render(<PreviewPage ledger="company" batchId="batch-1" onCancelled={onCancelled} />);

    const notice = await screen.findByRole('region', { name: '已定稿提示' });
    expect(notice).toHaveTextContent('已生成 PDF，付款单已定稿，付款单位、日期、经办人与备注不可直接修改。');
    expect(notice).toHaveTextContent('票据将退回本次付款池，可修正后重新生成；原 PDF 保留为作废件备查。');
    fireEvent.click(within(notice).getByRole('button', { name: '撤销并退回付款池' }));

    expect(confirmSpy).toHaveBeenCalledWith('撤销后票据将退回本次付款池，可修正后重新生成付款单；已生成的 PDF 将保留为作废件。确定撤销吗？');
    await waitFor(() => expect(cancelBatch).toHaveBeenCalledWith('batch-1'));
    expect(onCancelled).toHaveBeenCalled();
    // 回到公账的付款池，不是店内的报销池
    expect(window.location.hash).toBe('#company/pool');
    confirmSpy.mockRestore();
  });

  it('sends a cancelled store batch back to the store pool', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    batchApi.mockResolvedValue(storeBatch({ pdfPath: 'exports/batch-1.pdf' }));
    cancelBatch.mockResolvedValue(storeBatch({ cancelledAt: '2026-09-27' }));
    render(<PreviewPage batchId="batch-1" />);

    fireEvent.click(await screen.findByRole('button', { name: '撤销并退回报销池' }));

    await waitFor(() => expect(cancelBatch).toHaveBeenCalledWith('batch-1'));
    expect(window.location.hash).toBe('#pool');
    confirmSpy.mockRestore();
  });
});

// P-05：有未保存修改时离开要确认；留在本区的预览页不算离开，换到别的页或另一个区才算
describe('leaving the preview page with unsaved changes', () => {
  afterEach(() => cleanup());

  async function editAndWait(label: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText(label), { target: { value: '改过了' } });
    await screen.findByText(/有未保存的修改/);
  }

  async function goTo(hash: string): Promise<void> {
    window.location.hash = hash;
    await waitFor(() => expect(window.location.hash).toBe(hash));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '#company/batches/batch-1/preview';
    batchApi.mockResolvedValue(companyBatch());
  });

  it('asks when going to another company page, and stays when the user says no', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await editAndWait('付款单位');

    window.location.hash = '#company/pool';

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('有未保存的修改，确定离开吗？'));
    await waitFor(() => expect(window.location.hash).toBe('#company/batches/batch-1/preview'));
    confirmSpy.mockRestore();
  });

  it('asks when going to the store ledger, even to its preview page', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await editAndWait('付款单位');

    await goTo('#preview');

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('does not ask when moving to another batch preview of the same company ledger', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await editAndWait('付款单位');

    await goTo('#company/batches/batch-2/preview');
    await goTo('#company/preview');

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('asks a store batch when it goes to the company preview, but not to the store preview', async () => {
    window.location.hash = '#batches/batch-1/preview';
    batchApi.mockResolvedValue(storeBatch());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PreviewPage batchId="batch-1" />);
    await editAndWait('部门');

    await goTo('#preview');
    expect(confirmSpy).not.toHaveBeenCalled();

    await goTo('#company/preview');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('does not ask when nothing was changed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PreviewPage ledger="company" batchId="batch-1" />);
    await screen.findByLabelText('付款单位');

    await goTo('#company/pool');

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
