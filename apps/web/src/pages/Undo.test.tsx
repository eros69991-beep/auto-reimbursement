import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { receipt } from '../test/fixtures';
import { PoolPage } from './PoolPage';
import { HistoryPage } from './HistoryPage';
import { settings, totals } from '../test/fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('removes a pool receipt, reloads totals and recovers a soft-deleted receipt', async () => {
  vi.spyOn(api, 'receipts').mockImplementation(async (view) => view === 'pool' ? [receipt()] : view === 'deleted' ? [receipt({ deletedAt: '2026-09-22' })] : []);
  vi.spyOn(api, 'totals').mockResolvedValue(totals);
  vi.spyOn(api, 'settings').mockResolvedValue(settings);
  const membership = vi.spyOn(api, 'setPoolMembership').mockResolvedValue(receipt({ poolExcluded: true }));
  const restore = vi.spyOn(api, 'restoreReceipt').mockResolvedValue(receipt());
  render(<PoolPage onBatch={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '移出本次报销池' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 耗材 · 36.33' })).not.toBeInTheDocument());
  expect(membership).toHaveBeenCalledWith('a', false);
  fireEvent.click(screen.getByRole('button', { name: '查看已移出 / 回收站' }));
  fireEvent.click(await screen.findByRole('button', { name: '恢复凭证' }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith('a'));
  expect(await screen.findByText('已恢复 耗材 · 36.33')).toBeInTheDocument();
  // P-31：恢复后报销池列表立即刷新，不用手动重进页面
  expect(await screen.findByRole('checkbox', { name: '选择 耗材 · 36.33' })).toBeInTheDocument();
});
it('requires confirmation, cancels a batch and labels preserved historical PDFs as void', async () => {
  const batch = { id: 'batch', month: '2026-09', createdAt: '', totalFen: 3633, items: [], sheets: [], notes: [], options: { department: '', date: null, signerMode: 'text' as const, signerName: '', signature: null }, pdfPath: 'file.pdf', archivedAt: null };
  vi.spyOn(api, 'history').mockResolvedValueOnce([{ month: '2026-09', batches: [batch] }]).mockResolvedValue([{ month: '2026-09', batches: [{ ...batch, cancelledAt: '2026-09-22' }] }]);
  const cancel = vi.spyOn(api, 'cancelBatch').mockResolvedValue({ ...batch, cancelledAt: '2026-09-22' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<HistoryPage onPreview={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '撤销本单报销' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('batch'));
  expect(await screen.findByText(/已撤销，票据已退回/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /作废 PDF/ }).getAttribute('href')).toContain('http');
  expect(screen.queryByRole('button', { name: '查看预览' })).not.toBeInTheDocument();
});
it('offers unarchive for an archived month even though active batches carry no cancelledAt field', async () => {
  // 真实接口返回的正常批次没有 cancelledAt 字段（只有撤销后才写入）
  const archived = { id: 'batch-archived', month: '2026-08', createdAt: '2026-08-31T00:00:00.000Z', totalFen: 3633, items: [], sheets: [], notes: [], options: { department: '', date: null, signerMode: 'text' as const, signerName: '', signature: null }, pdfPath: 'file.pdf', archivedAt: '2026-09-01T00:00:00.000Z' };
  vi.spyOn(api, 'history').mockResolvedValue([{ month: '2026-08', batches: [archived] }]);
  const unarchive = vi.spyOn(api, 'unarchive').mockResolvedValue({ affected: 1 });
  render(<HistoryPage onPreview={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '取消归档' }));
  await waitFor(() => expect(unarchive).toHaveBeenCalledWith('2026-08'));
});
