import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Batch } from '@auto-reimbursement/contracts';

const { batchApi, saveBatchOptions, createBatchNote, updateBatchNote } = vi.hoisted(() => ({
  batchApi: vi.fn(),
  saveBatchOptions: vi.fn(),
  createBatchNote: vi.fn(),
  updateBatchNote: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    batch: batchApi,
    saveBatchOptions,
    createBatchNote,
    updateBatchNote,
    moveGroup: vi.fn(),
    exportBatch: vi.fn(),
    cancelBatch: vi.fn(),
  },
  apiUrl: (path: string) => `http://api.test${path}`,
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
    updateBatchNote.mockResolvedValue(sampleBatch());

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑备注' }));
    const textarea = await screen.findByLabelText('备注内容');
    expect(textarea).toHaveValue('旧内容');
    fireEvent.change(textarea, { target: { value: '新内容\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateBatchNote).toHaveBeenCalledWith('batch-1', 'note-own', { content: '新内容\n第二行' }));
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
    updateBatchNote.mockResolvedValue(sampleBatch({
      notes: [{ id: 'note-own', name: '第 1 页手写备注', content: '新内容' }],
      sheets: [{ ...sampleBatch().sheets[0]!, noteId: 'note-own' }],
    }));

    render(<PreviewPage batchId="batch-1" />);
    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '未保存的新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑备注' }));
    fireEvent.change(await screen.findByLabelText('备注内容'), { target: { value: '新内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateBatchNote).toHaveBeenCalledWith('batch-1', 'note-own', { content: '新内容' }));
    await waitFor(() => expect(screen.getByLabelText('部门')).toHaveValue('未保存的新部门'));
  });
});
