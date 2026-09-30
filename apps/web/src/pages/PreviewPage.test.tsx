import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Batch } from '@auto-reimbursement/contracts';

const { batchApi, saveBatchOptions, createBatchNote, updateBatchNote, moveGroup, exportBatch } = vi.hoisted(() => ({
  batchApi: vi.fn(),
  saveBatchOptions: vi.fn(),
  createBatchNote: vi.fn(),
  updateBatchNote: vi.fn(),
  moveGroup: vi.fn(),
  exportBatch: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    batch: batchApi,
    saveBatchOptions,
    createBatchNote,
    updateBatchNote,
    moveGroup,
    exportBatch,
    cancelBatch: vi.fn(),
  },
  apiUrl: (path: string) => `http://api.test${path}`,
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed: vi.fn(),
}));

vi.mock('../components/PdfPreview', () => ({
  PdfPreview: ({ url }: { url: string }) => <div data-testid="pdf-preview" data-url={url} />,
}));

import { PreviewPage } from './PreviewPage';

function sampleBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    month: '2026-09',
    createdAt: '2026-09-26T00:00:00.000Z',
    totalFen: 15000,
    items: [],
    sheets: [
      {
        id: 'sheet-1',
        noteId: null,
        groups: [{ category: '百慕达食材', totalFen: 10000, receiptIds: ['a'], amountsFen: [10000] }],
      },
    ],
    options: {
      department: '武汉测试店',
      date: '2026-09-26',
      signerMode: 'text',
      signerName: '测试报销人甲',
      signature: null,
    },
    notes: [{ id: 'note-template', name: '通用模板', content: '模板内容' }],
    pdfPath: null,
    archivedAt: null,
    ...overrides,
  };
}

// 与真实接口一致：PATCH options 返回保存后的完整批次（选项与每页备注关联按请求落库）
function echoSave(base: Batch) {
  return async (_id: string, options: Batch['options'], noteBySheet: Record<string, string | null>) => ({
    ...base,
    options,
    sheets: base.sheets.map((sheet) => ({ ...sheet, noteId: noteBySheet[sheet.id] ?? null })),
  });
}

describe('preview page note editing', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    batchApi.mockResolvedValue(sampleBatch());
  });

  it('creates a multi-line note for a sheet without one and attaches it', async () => {
    createBatchNote.mockImplementation(async (_id: string, input: { name: string; content: string }) =>
      sampleBatch({ notes: [...sampleBatch().notes, { id: 'note-new', name: input.name, content: input.content }] }),
    );
    saveBatchOptions.mockImplementation(async (_id: string, _options: unknown, noteBySheet: Record<string, string | null>) =>
      sampleBatch({
        notes: [...sampleBatch().notes, { id: 'note-new', name: '第 1 页手写备注', content: '第一行\n第二行' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: noteBySheet['sheet-1'] ?? null }],
      }),
    );

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    const textarea = await screen.findByLabelText('备注内容');
    fireEvent.change(textarea, { target: { value: '第一行\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(createBatchNote).toHaveBeenCalledWith('batch-1', { name: '第 1 页手写备注', content: '第一行\n第二行' }));
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith(
        'batch-1',
        expect.anything(),
        expect.objectContaining({ 'sheet-1': 'note-new' }),
      ),
    );
    // 保存成功后弹窗关闭
    await waitFor(() => expect(screen.queryByLabelText('备注内容')).not.toBeInTheDocument());
  });

  it('updates an existing unshared note in place', async () => {
    batchApi.mockResolvedValue(
      sampleBatch({
        notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '旧内容' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
      }),
    );
    const updated = sampleBatch({
      notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '新内容\n第二行' }],
      sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
    });
    updateBatchNote.mockResolvedValue(updated);
    saveBatchOptions.mockImplementation(echoSave(updated));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    const textarea = await screen.findByLabelText('备注内容');
    expect(textarea).toHaveValue('旧内容');
    fireEvent.change(textarea, { target: { value: '新内容\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateBatchNote).toHaveBeenCalledWith('batch-1', 'note-own', { content: '新内容\n第二行' }));
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith('batch-1', expect.anything(), expect.objectContaining({ 'sheet-1': 'note-own' })),
    );
    expect(createBatchNote).not.toHaveBeenCalled();
  });

  it('cancel closes without saving and clear-detaches the sheet note', async () => {
    batchApi.mockResolvedValue(
      sampleBatch({
        notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '旧内容' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
      }),
    );
    saveBatchOptions.mockResolvedValue(sampleBatch());

    render(<PreviewPage batchId="batch-1" />);
    // 取消：修改后不保存
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    fireEvent.change(await screen.findByLabelText('备注内容'), { target: { value: '改动' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(saveBatchOptions).not.toHaveBeenCalled();
    expect(updateBatchNote).not.toHaveBeenCalled();

    // 清空：清空按钮 + 保存空字符串 → 解除关联（noteId 置 null）
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith(
        'batch-1',
        expect.anything(),
        expect.objectContaining({ 'sheet-1': null }),
      ),
    );
    expect(updateBatchNote).not.toHaveBeenCalled();
  });

  it('keeps the input and shows the error when saving fails', async () => {
    updateBatchNote.mockRejectedValue(Object.assign(new Error('请求参数无效'), { code: 'INVALID_NOTE' }));
    batchApi.mockResolvedValue(
      sampleBatch({
        notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '旧内容' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
      }),
    );

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    fireEvent.change(await screen.findByLabelText('备注内容'), { target: { value: '未保存的输入' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('INVALID_NOTE：请求参数无效');
    expect(screen.getByLabelText('备注内容')).toHaveValue('未保存的输入');
  });

  it('keeps unsaved option edits when saving a note (create path)', async () => {
    createBatchNote.mockImplementation(async (_id: string, input: { name: string; content: string }) =>
      sampleBatch({ notes: [...sampleBatch().notes, { id: 'note-new', name: input.name, content: input.content }] }),
    );
    saveBatchOptions.mockImplementation(async (_id: string, options: { department: string }, noteBySheet: Record<string, string | null>) =>
      sampleBatch({
        options: { ...sampleBatch().options, department: options.department },
        notes: [...sampleBatch().notes, { id: 'note-new', name: '第 1 页手写备注', content: '备注文字' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: noteBySheet['sheet-1'] ?? null }],
      }),
    );

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '未保存的新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑备注' }));
    fireEvent.change(await screen.findByLabelText('备注内容'), { target: { value: '备注文字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // 保存备注必须带上本地未保存的部门输入，且界面不回写成服务器旧值
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith(
        'batch-1',
        expect.objectContaining({ department: '未保存的新部门' }),
        expect.objectContaining({ 'sheet-1': 'note-new' }),
      ),
    );
    expect(screen.getByLabelText('部门')).toHaveValue('未保存的新部门');
  });

  it('keeps unsaved option edits when updating a note in place', async () => {
    batchApi.mockResolvedValue(
      sampleBatch({
        notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '旧内容' }],
        sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
      }),
    );
    const updated = sampleBatch({
      notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '新内容' }],
      sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
    });
    updateBatchNote.mockResolvedValue(updated);
    saveBatchOptions.mockImplementation(echoSave(updated));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '未保存的新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑备注' }));
    fireEvent.change(await screen.findByLabelText('备注内容'), { target: { value: '新内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateBatchNote).toHaveBeenCalledWith('batch-1', 'note-own', { content: '新内容' }));
    // 保存备注时一并保存本地输入，界面不回写成服务器旧值
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith(
        'batch-1',
        expect.objectContaining({ department: '未保存的新部门' }),
        expect.objectContaining({ 'sheet-1': 'note-own' }),
      ),
    );
    await waitFor(() => expect(screen.getByLabelText('部门')).toHaveValue('未保存的新部门'));
  });

  it('attaches a template to the sheet when it is picked and then edited (review #4)', async () => {
    // 服务器上本页没有备注；批次里有一条模板快照
    updateBatchNote.mockImplementation(async (_id: string, noteId: string, input: { content: string }) =>
      sampleBatch({ notes: [{ id: noteId, name: '通用模板', content: input.content }] }),
    );
    saveBatchOptions.mockImplementation(echoSave(sampleBatch({ notes: [{ id: 'note-template', name: '通用模板', content: '模板内容（本月补充说明）' }] })));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('第 1 页备注模板'), { target: { value: 'note-template' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑备注' }));
    const textarea = await screen.findByLabelText('备注内容');
    expect(textarea).toHaveValue('模板内容');
    fireEvent.change(textarea, { target: { value: '模板内容（本月补充说明）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // 关联必须落库：本页 → 这条模板备注
    await waitFor(() =>
      expect(saveBatchOptions).toHaveBeenCalledWith('batch-1', expect.anything(), expect.objectContaining({ 'sheet-1': 'note-template' })),
    );
    await waitFor(() => expect(screen.queryByLabelText('备注内容')).not.toBeInTheDocument());
    expect(screen.getByLabelText('第 1 页备注模板')).toHaveValue('note-template');
    expect(screen.queryByText(/有未保存的修改/)).not.toBeInTheDocument();
  });
});

describe('preview page unsaved-changes handling (P-05)', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    batchApi.mockResolvedValue(sampleBatch());
  });

  it('shows a dirty hint after editing and a saved notice after saving', async () => {
    saveBatchOptions.mockImplementation(async (_id: string, options: { department: string }) =>
      sampleBatch({ options: { ...sampleBatch().options, department: options.department } }),
    );

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '新部门' } });
    expect(screen.getByRole('status')).toHaveTextContent('有未保存的修改');

    fireEvent.click(screen.getByRole('button', { name: '保存预览设置' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'));
  });

  it('saves unsaved edits before exporting and asks for confirmation (P-05)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    saveBatchOptions.mockImplementation(async (_id: string, options: { department: string }) =>
      sampleBatch({ options: { ...sampleBatch().options, department: options.department } }),
    );
    exportBatch.mockResolvedValue(sampleBatch({ pdfPath: 'exports/batch-1.pdf' }));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '未保存的新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '生成 PDF' }));

    // 先保存（带本地未保存的部门），再导出；顺序不能反
    await waitFor(() => expect(exportBatch).toHaveBeenCalledWith('batch-1'));
    expect(saveBatchOptions).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ department: '未保存的新部门' }),
      expect.anything(),
    );
    expect(saveBatchOptions.mock.invocationCallOrder[0]!).toBeLessThan(exportBatch.mock.invocationCallOrder[0]!);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('未保存的新部门'));
    confirmSpy.mockRestore();
  });

  it('does not export when the confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '生成 PDF' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(exportBatch).not.toHaveBeenCalled();
    expect(saveBatchOptions).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('keeps unsaved option edits when moving a category across sheets (P-05)', async () => {
    moveGroup.mockResolvedValue(sampleBatch());

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '未保存的新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(moveGroup).toHaveBeenCalledWith('batch-1', '百慕达食材', 1));
    // 服务器返回的旧快照不能覆盖本地未保存输入
    await waitFor(() => expect(screen.getByLabelText('部门')).toHaveValue('未保存的新部门'));
    expect(screen.getByRole('status')).toHaveTextContent('有未保存的修改');
  });

  it('does not report unsaved changes just because a move added a page', async () => {
    moveGroup.mockResolvedValue(
      sampleBatch({
        sheets: [
          { id: 'sheet-1', noteId: null, groups: [] },
          { id: 'sheet-2', noteId: null, groups: [{ category: '百慕达食材', totalFen: 10000, receiptIds: ['a'], amountsFen: [10000] }] },
        ],
      }),
    );

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '下一页' }));
    await waitFor(() => expect(moveGroup).toHaveBeenCalled());
    await screen.findByLabelText('第 2 页备注模板');
    expect(screen.queryByText(/有未保存的修改/)).not.toBeInTheDocument();
  });

  it('clears an earlier error once a later save succeeds', async () => {
    saveBatchOptions
      .mockRejectedValueOnce(Object.assign(new Error('请求参数无效'), { code: 'INVALID_OPTIONS' }))
      .mockImplementation(echoSave(sampleBatch()));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '保存预览设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请求参数无效');
    fireEvent.click(screen.getByRole('button', { name: '保存预览设置' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  // P-27：快速切换批次时，迟到的旧批次响应不能覆盖新批次
  it('ignores a stale batch response after switching batches', async () => {
    let resolveFirst: (batch: Batch) => void = () => undefined;
    batchApi.mockImplementation((id: string) =>
      id === 'batch-1'
        ? new Promise<Batch>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(sampleBatch({
            id: 'batch-2',
            options: { ...sampleBatch().options, department: '新批次部门' },
          })),
    );

    const { rerender } = render(<PreviewPage batchId="batch-1" />);
    rerender(<PreviewPage batchId="batch-2" />);

    expect(await screen.findByLabelText('部门')).toHaveValue('新批次部门');

    resolveFirst(sampleBatch({ id: 'batch-1', options: { ...sampleBatch().options, department: '旧批次部门' } }));
    await waitFor(() => expect(screen.getByLabelText('部门')).toHaveValue('新批次部门'));
    expect(screen.queryByDisplayValue('旧批次部门')).not.toBeInTheDocument();
  });
});

describe('preview page category order', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const food = { category: '食材' as const, receiptIds: ['a', 'b'], amountsFen: [10000, 10001], totalFen: 20001 };

  it('does not offer to move a category up when it is already on the first page', async () => {
    batchApi.mockResolvedValue(sampleBatch());

    render(<PreviewPage batchId="batch-1" />);

    expect(await screen.findByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
  });

  it('can move a category that sits on a later page back up', async () => {
    batchApi.mockResolvedValue(sampleBatch({
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [{ ...food, category: '肉类' }] },
        { id: 'sheet-2', noteId: null, groups: [food] },
      ],
    }));
    moveGroup.mockResolvedValue(sampleBatch());

    render(<PreviewPage batchId="batch-1" />);
    const row = (await screen.findByText(/^食材/)).closest('p')!;
    fireEvent.click(within(row).getByRole('button', { name: '上一页' }));

    await waitFor(() => expect(moveGroup).toHaveBeenCalledWith('batch-1', '食材', -1));
  });

  it('locks a category that was split across several pages and says why', async () => {
    batchApi.mockResolvedValue(sampleBatch({
      sheets: [
        { id: 'sheet-1', noteId: null, groups: [{ ...food, part: 1 }] },
        { id: 'sheet-2', noteId: null, groups: [{ ...food, part: 2 }, { category: '酒水', receiptIds: ['c'], amountsFen: [5600], totalFen: 5600 }] },
      ],
    }));

    render(<PreviewPage batchId="batch-1" />);

    const splitRow = (await screen.findByText(/凭证较多，分在第 1、2 页上，不能单独移动/)).closest('p')!;
    expect(splitRow).toHaveTextContent(/^食材/);
    for (const name of ['上一页', '下一页']) {
      expect(within(splitRow).getByRole('button', { name })).toBeDisabled();
    }
    // 没拆开的分类照常可以移动
    const wineRow = screen.getByText(/^酒水/).closest('p')!;
    expect(within(wineRow).getByRole('button', { name: '上一页' })).toBeEnabled();
    expect(within(wineRow).getByRole('button', { name: '下一页' })).toBeEnabled();
  });
});
