import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadResult } from '@auto-reimbursement/contracts';

import { api } from '../api';
import { companyReceipt, receipt } from '../test/fixtures';
import { UploadPage } from './UploadPage';

// 公账区的上传页：同一个页面，说法换成回单，上传和查进度都走公账区
beforeEach(() => {
  vi.spyOn(api, 'apiStatus').mockResolvedValue({ configured: true, provider: 'deepseek' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pdfLikePng = (name: string): File => new File(['x'], name, { type: 'image/png' });

describe('UploadPage in the company ledger', () => {
  it('talks about 回单 and explains what a 收费通知单 turns into', async () => {
    render(<UploadPage ledger="company" />);

    expect(screen.getByRole('heading', { name: '上传回单' })).toBeInTheDocument();
    expect(screen.getByLabelText('拖放回单图片')).toBeInTheDocument();
    expect(screen.getByLabelText('选择回单图片')).toBeInTheDocument();
    expect(screen.getByText(/银行电子回单、收费通知单/)).toHaveTextContent('一张收费通知单会按项目拆成几行');
    expect(screen.getByText(/银行电子回单、收费通知单/)).toHaveTextContent('备注栏');
    expect(screen.queryByLabelText('选择凭证图片')).not.toBeInTheDocument();
    await waitFor(() => expect(api.apiStatus).toHaveBeenCalled());
  });

  it('keeps the store page exactly as it was: store words, no company explanation', async () => {
    render(<UploadPage />);

    expect(screen.getByRole('heading', { name: '上传凭证' })).toBeInTheDocument();
    expect(screen.getByLabelText('选择凭证图片')).toBeInTheDocument();
    expect(screen.queryByText(/收费通知单/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.apiStatus).toHaveBeenCalled());
  });

  it('uploads to the company ledger and polls progress for the new receipts', async () => {
    const upload = vi.spyOn(api, 'upload').mockResolvedValue({ accepted: [{ id: 'c-1' }, { id: 'c-2' }] as UploadResult['accepted'], rejected: [] });
    const progress = vi.spyOn(api, 'progress').mockResolvedValue({ total: 2, recognizing: 0, ready: 2, pending: 0 });
    render(<UploadPage ledger="company" />);

    fireEvent.change(screen.getByLabelText('选择回单图片'), {
      target: { files: [pdfLikePng('肉款.png'), pdfLikePng('品牌费.png')] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [files, , ledger] = upload.mock.calls[0]!;
    expect((files as File[]).map((file) => file.name)).toEqual(['肉款.png', '品牌费.png']);
    expect(ledger).toBe('company');
    await waitFor(() => expect(progress).toHaveBeenCalled());
    expect(progress.mock.calls[0]![0]).toEqual(['c-1', 'c-2']);
    expect(await screen.findByText('成功数：2')).toBeInTheDocument();
  });

  it('uploads a store page to the store, without naming a ledger', async () => {
    const upload = vi.spyOn(api, 'upload').mockResolvedValue({ accepted: [], rejected: [] });
    render(<UploadPage />);

    fireEvent.change(screen.getByLabelText('选择凭证图片'), { target: { files: [pdfLikePng('a.png')] } });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]).toHaveLength(2);
  });

  it('warns in company words when the AI is not configured, with a link to the company settings', async () => {
    vi.spyOn(api, 'apiStatus').mockResolvedValue({ configured: false, provider: null });
    render(<UploadPage ledger="company" />);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('AI 识别未配置：上传的回单将全部转为人工录入。可在设置中配置识别服务。');
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('href', '#company/settings');
  });

  it('links the store warning to the store settings', async () => {
    vi.spyOn(api, 'apiStatus').mockResolvedValue({ configured: false, provider: null });
    render(<UploadPage />);

    expect(await screen.findByRole('status')).toHaveTextContent('AI 识别未配置：上传的凭证将全部转为人工录入');
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('href', '#settings');
  });

  it('tells the user the same picture is already in the other ledger, instead of a bare "duplicate"', async () => {
    vi.spyOn(api, 'upload').mockResolvedValue({
      accepted: [],
      rejected: [{ index: 0, code: 'DUPLICATE_EXACT', duplicateId: 'store-receipt', duplicateLedger: 'store' }],
    });
    render(<UploadPage ledger="company" />);

    fireEvent.change(screen.getByLabelText('选择回单图片'), { target: { files: [pdfLikePng('same.png')] } });

    expect(await screen.findByRole('list', { name: '被拒绝文件' })).toHaveTextContent('重复文件（已在「店内报销」里）：same.png');
    // 公账页上看到的链接用公账的说法
    expect(screen.getByRole('link', { name: '查看重复回单' })).toBeInTheDocument();
  });

  it('says the same from the store page for a picture that is already in the company ledger', async () => {
    vi.spyOn(api, 'upload').mockResolvedValue({
      accepted: [],
      rejected: [{ index: 0, code: 'DUPLICATE_EXACT', duplicateId: 'company-receipt', duplicateLedger: 'company' }],
    });
    render(<UploadPage />);

    fireEvent.change(screen.getByLabelText('选择凭证图片'), { target: { files: [pdfLikePng('same.png')] } });

    expect(await screen.findByRole('list', { name: '被拒绝文件' })).toHaveTextContent('重复文件（已在「公账付款」里）：same.png');
    expect(screen.getByRole('link', { name: '查看重复凭证' })).toBeInTheDocument();
  });

  it('keeps a plain duplicate in the same ledger as a plain duplicate', async () => {
    vi.spyOn(api, 'upload').mockResolvedValue({
      accepted: [],
      rejected: [{ index: 0, code: 'DUPLICATE_EXACT', duplicateId: 'receipt-2' }],
    });
    render(<UploadPage ledger="company" />);

    fireEvent.change(screen.getByLabelText('选择回单图片'), { target: { files: [pdfLikePng('same.png')] } });

    const list = await screen.findByRole('list', { name: '被拒绝文件' });
    expect(list).toHaveTextContent('重复文件：same.png');
    expect(list).not.toHaveTextContent('已在');
  });

  it('restores a receipt from the recycle bin and sends the user to the company payment pool', async () => {
    const restore = vi.spyOn(api, 'restoreReceipt').mockResolvedValue(companyReceipt({ id: 'gone' }));
    vi.spyOn(api, 'upload').mockResolvedValue({
      accepted: [],
      rejected: [{ index: 0, code: 'DELETED_DUPLICATE', duplicateId: 'gone' }],
    });
    render(<UploadPage ledger="company" />);

    fireEvent.change(screen.getByLabelText('选择回单图片'), { target: { files: [pdfLikePng('肉款.png')] } });
    fireEvent.click(await screen.findByRole('button', { name: '从回收站恢复' }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith('gone'));
    expect(await screen.findByRole('status')).toHaveTextContent('已从回收站恢复 肉款 · 12909.49，请到「本期付款池」查看。');
  });

  it('sends a store user to the store pool after the same restore', async () => {
    vi.spyOn(api, 'restoreReceipt').mockResolvedValue(receipt({ id: 'gone', category: '食材', paidFen: 12000 }));
    vi.spyOn(api, 'upload').mockResolvedValue({
      accepted: [],
      rejected: [{ index: 0, code: 'DELETED_DUPLICATE', duplicateId: 'gone' }],
    });
    render(<UploadPage />);

    fireEvent.change(screen.getByLabelText('选择凭证图片'), { target: { files: [pdfLikePng('a.png')] } });
    fireEvent.click(await screen.findByRole('button', { name: '从回收站恢复' }));

    expect(await screen.findByRole('status')).toHaveTextContent('已从回收站恢复 食材 · 120.00，请到「本期报销池」查看。');
  });
});
