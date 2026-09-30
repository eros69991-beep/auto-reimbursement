import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settings } from '../test/fixtures';

const { backup, saveSettings, saveNote, saveRule, reapplyRules } = vi.hoisted(() => ({ backup: vi.fn(), saveSettings: vi.fn(), saveNote: vi.fn(), saveRule: vi.fn(), reapplyRules: vi.fn() }));
vi.mock('../api', () => ({
  api: {
    settings: vi.fn().mockResolvedValue(settings),
    apiStatus: vi.fn().mockResolvedValue({ configured: false, provider: null }),
    notes: vi.fn().mockResolvedValue([]),
    rules: vi.fn().mockResolvedValue([]),
    backup,
    saveSettings,
    saveNote,
    saveRule,
    reapplyRules,
  },
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed: vi.fn(),
}));

import { SettingsPage } from './SettingsPage';

describe('workflow pages', () => {
  beforeEach(() => backup.mockResolvedValue({ downloadUrl: '/api/backups/one', includesImages: false }));

  it('explains the structured backup after creating it', async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '备份全部数据' }));
    await waitFor(() => expect(backup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('此备份包含数据库、设置、学习规则和文件索引，不包含图片和 PDF')).toBeInTheDocument();
  });

  it('edits all decision defaults before saving', async () => {
    saveSettings.mockResolvedValue(settings);
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('日期默认值'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('自定义日期'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('金额阈值'), { target: { value: '0.91' } });
    fireEvent.change(screen.getByLabelText('分类阈值'), { target: { value: '0.88' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ dateMode: 'custom', customDate: '2026-10-01', amountThreshold: 0.91, categoryThreshold: 0.88 })));
  });

  it('creates a fixed rule that takes effect without any confirmations', async () => {
    // 试点反馈 1：手动加的规则以前要确认满 3 次才生效，等于不起作用
    saveRule.mockImplementation(async (rule: unknown) => rule);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '新建固定规则' }));
    expect(screen.queryByLabelText('强规则')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: ' 武汉仓 ' } });
    fireEvent.change(screen.getByLabelText('归到分类'), { target: { value: '百慕达食材' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    await waitFor(() => expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'keyword', key: '武汉仓', category: '百慕达食材', source: 'manual', strong: false, confirmations: 0,
    })));
    expect(await screen.findByRole('status')).toHaveTextContent('固定规则已保存');
    expect(screen.getByRole('list', { name: '固定规则' })).toHaveTextContent('包含「武汉仓」（商户或图中文字） → 百慕达食材');
  });

  it('does not allow a one-character fixed rule', async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '新建固定规则' }));
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: '仓' } });
    expect(screen.getByRole('button', { name: '保存规则' })).toBeDisabled();
    expect(screen.getByText('至少 2 个字，避免把无关的凭证也归进来。')).toBeInTheDocument();
  });

  it('shows a safe rule-save error', async () => {
    saveRule.mockRejectedValue(new Error('请求参数无效'));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '新建固定规则' }));
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: 'coffee' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请求参数无效');
  });

  it('reapplies rules to pending receipts and reports how many changed', async () => {
    reapplyRules.mockResolvedValue({ affected: 2 });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '套用到待处理凭证' }));
    await waitFor(() => expect(reapplyRules).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('已重新套用规则，2 张待处理凭证有变化');
  });
});
