import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settings } from '../test/fixtures';

const { backup, saveSettings, saveNote, saveRule } = vi.hoisted(() => ({ backup: vi.fn(), saveSettings: vi.fn(), saveNote: vi.fn(), saveRule: vi.fn() }));
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
  },
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
    fireEvent.change(screen.getAllByLabelText('自定义日期').at(-1)!, { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getAllByLabelText('金额阈值').at(-1)!, { target: { value: '0.91' } });
    fireEvent.change(screen.getAllByLabelText('分类阈值').at(-1)!, { target: { value: '0.88' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存设置' }).at(-1)!);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ dateMode: 'custom', customDate: '2026-10-01', amountThreshold: 0.91, categoryThreshold: 0.88 })));
  });
});
