import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settings } from '../test/fixtures';

const { backup } = vi.hoisted(() => ({ backup: vi.fn() }));
vi.mock('../api', () => ({
  api: {
    settings: vi.fn().mockResolvedValue(settings),
    apiStatus: vi.fn().mockResolvedValue({ configured: false, provider: null }),
    notes: vi.fn().mockResolvedValue([]),
    rules: vi.fn().mockResolvedValue([]),
    backup,
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
});
