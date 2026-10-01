import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@auto-reimbursement/contracts';

import { settings } from '../test/fixtures';

const { rules, saveSettings, saveRule, reapplyRules, deleteRule } = vi.hoisted(() => ({
  rules: vi.fn(),
  saveSettings: vi.fn(),
  saveRule: vi.fn(),
  reapplyRules: vi.fn(),
  deleteRule: vi.fn(),
}));
vi.mock('../api', () => ({
  api: {
    settings: vi.fn(),
    apiStatus: vi.fn().mockResolvedValue({ configured: true, provider: 'deepseek' }),
    notes: vi.fn().mockResolvedValue([]),
    rules,
    saveSettings,
    saveRule,
    deleteRule,
    reapplyRules,
    backup: vi.fn(),
    saveSignature: vi.fn(),
  },
  fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock'),
  openAuthed: vi.fn(),
}));

import { api } from '../api';
import { SettingsPage } from './SettingsPage';

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const companyRule: Rule = {
  id: 'fixed-meat',
  kind: 'keyword',
  key: '新沣',
  originalCategory: null,
  category: '肉款',
  confirmations: 0,
  strong: false,
  updatedAt: '2026-09-30T00:00:00.000Z',
  source: 'manual',
};

describe('SettingsPage in the company ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.settings.mockResolvedValue({ ...settings, department: '店内的部门', companyDepartment: '武汉市火门里餐饮管理有限公司' });
    mockedApi.apiStatus.mockResolvedValue({ configured: true, provider: 'deepseek' });
    mockedApi.notes.mockResolvedValue([]);
    rules.mockResolvedValue([companyRule]);
    saveSettings.mockImplementation(async (value: unknown) => value);
    saveRule.mockImplementation(async (rule: unknown) => rule);
    reapplyRules.mockResolvedValue({ affected: 2 });
    deleteRule.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('asks for the company rules, and the store page for the store rules', async () => {
    const company = render(<SettingsPage ledger="company" />);
    await screen.findByRole('heading', { name: '设置' });
    expect(rules).toHaveBeenCalledWith('company');
    company.unmount();

    render(<SettingsPage />);
    await screen.findByRole('heading', { name: '设置' });
    expect(rules).toHaveBeenLastCalledWith('store');
  });

  it('loads the rules of the other ledger when the same page is switched over, without a remount', async () => {
    rules.mockImplementation(async (ledger: string) => (ledger === 'company' ? [companyRule] : []));
    const view = render(<SettingsPage />);
    await screen.findByLabelText('部门');
    expect(screen.queryByRole('list', { name: '固定规则' })).not.toBeInTheDocument();

    view.rerender(<SettingsPage ledger="company" />);

    expect(await screen.findByRole('list', { name: '固定规则' })).toHaveTextContent('包含「新沣」（商户或图中文字） → 肉款');
    expect(rules).toHaveBeenLastCalledWith('company');
  });

  it('shows the payment unit of the company instead of the store department, with a note on what is shared', async () => {
    render(<SettingsPage ledger="company" />);

    const unit = await screen.findByLabelText('公账付款单位');
    expect(unit).toHaveValue('武汉市火门里餐饮管理有限公司');
    expect(screen.queryByLabelText('部门')).not.toBeInTheDocument();
    expect(screen.getByText(/公账付款区的设置：付款单位和固定规则是公账自己的/)).toBeInTheDocument();
  });

  it('calls the signer 经办人 in the company ledger, as the form and the preview do, and 签名人 in the store', async () => {
    const company = render(<SettingsPage ledger="company" />);
    expect(await screen.findByLabelText('经办人')).toBeInTheDocument();
    expect(screen.queryByLabelText('签名人')).not.toBeInTheDocument();
    expect(screen.getByText(/日期、经办人、识别阈值和备注模板与店内报销共用/)).toBeInTheDocument();
    company.unmount();

    render(<SettingsPage />);
    expect(await screen.findByLabelText('签名人')).toBeInTheDocument();
    expect(screen.queryByLabelText('经办人')).not.toBeInTheDocument();
  });

  it('shows the department of the store and no company wording on the store page', async () => {
    render(<SettingsPage />);

    expect(await screen.findByLabelText('部门')).toHaveValue('店内的部门');
    expect(screen.queryByLabelText('公账付款单位')).not.toBeInTheDocument();
    expect(screen.queryByText(/公账付款区的设置/)).not.toBeInTheDocument();
  });

  it('saves the payment unit without touching the store department', async () => {
    render(<SettingsPage ledger="company" />);

    fireEvent.change(await screen.findByLabelText('公账付款单位'), { target: { value: '武汉市火门里餐饮管理有限公司（新）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      companyDepartment: '武汉市火门里餐饮管理有限公司（新）',
      department: '店内的部门',
    })));
    expect(await screen.findByRole('status')).toHaveTextContent('设置已保存');
  });

  it('shows the error, not the earlier "saved" note, when a later save fails', async () => {
    saveSettings.mockImplementationOnce(async (value: unknown) => value).mockRejectedValueOnce(new Error('请求参数无效'));
    render(<SettingsPage ledger="company" />);
    await screen.findByLabelText('公账付款单位');

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('设置已保存');
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请求参数无效');
    expect(screen.queryByText('设置已保存')).not.toBeInTheDocument();
  });

  // 后台的报错是写给店内的（凭证、报销……），公账页面显示前要换成回单、付款的说法
  it('shows what the server says in company words: loading, saving, uploading the signature, backing up', async () => {
    mockedApi.settings.mockRejectedValueOnce(new Error('凭证不存在'));
    const loading = render(<SettingsPage ledger="company" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('回单不存在');
    loading.unmount();

    saveSettings.mockRejectedValueOnce(new Error('报销批次不存在'));
    mockedApi.saveSignature.mockRejectedValueOnce(new Error('凭证不存在'));
    mockedApi.backup.mockRejectedValueOnce(new Error('已导出的报销单不可修改'));
    render(<SettingsPage ledger="company" />);
    await screen.findByLabelText('公账付款单位');

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('付款批次不存在'));

    fireEvent.change(screen.getByLabelText('上传签名'), { target: { files: [new File(['x'], 'sign.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回单不存在'));

    fireEvent.click(screen.getByRole('button', { name: '备份全部数据' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已导出的付款单不可修改'));
    expect(screen.getByRole('alert')).not.toHaveTextContent(/凭证|报销/);
  });

  it('keeps the words of the server for the store page', async () => {
    mockedApi.settings.mockRejectedValueOnce(new Error('凭证不存在'));
    render(<SettingsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('凭证不存在');
  });

  it('saves the store department without inventing a company payment unit', async () => {
    mockedApi.settings.mockResolvedValue({ ...settings });
    render(<SettingsPage />);

    fireEvent.change(await screen.findByLabelText('部门'), { target: { value: '新部门' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = saveSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved.department).toBe('新部门');
    expect(saved).not.toHaveProperty('companyDepartment');
  });

  it('starts an empty payment unit as an empty box, not the store department', async () => {
    mockedApi.settings.mockResolvedValue({ ...settings, department: '店内的部门' });
    render(<SettingsPage ledger="company" />);

    expect(await screen.findByLabelText('公账付款单位')).toHaveValue('');
  });

  it('lists the company fixed rules and creates one with company categories, in company words', async () => {
    render(<SettingsPage ledger="company" />);

    expect(await screen.findByRole('list', { name: '固定规则' })).toHaveTextContent('包含「新沣」（商户或图中文字） → 肉款');
    fireEvent.click(screen.getByRole('button', { name: '新建固定规则' }));
    const category = screen.getByLabelText('归到分类') as HTMLSelectElement;
    expect(Array.from(category.options).map((option) => option.value)).toEqual(['肉款', '品牌管理费', '店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出']);
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: '品牌管理' } });
    fireEvent.change(category, { target: { value: '品牌管理费' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    await waitFor(() => expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ kind: 'keyword', key: '品牌管理', category: '品牌管理费', source: 'manual', strong: false })));
    expect(await screen.findByText('固定规则已保存，之后识别的回单马上按它归类；已在待处理里的，点「套用到待处理回单」。')).toBeInTheDocument();
  });

  it('reapplies only the company rules and reports it in company words', async () => {
    render(<SettingsPage ledger="company" />);

    fireEvent.click(await screen.findByRole('button', { name: '套用到待处理回单' }));

    await waitFor(() => expect(reapplyRules).toHaveBeenCalledWith('company'));
    expect(await screen.findByText('已重新套用规则，2 张待处理回单有变化')).toBeInTheDocument();
  });

  it('reapplies the store rules from the store page', async () => {
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '套用到待处理凭证' }));

    await waitFor(() => expect(reapplyRules).toHaveBeenCalledWith('store'));
  });

  it('deletes a company rule', async () => {
    render(<SettingsPage ledger="company" />);

    fireEvent.click(await screen.findByRole('button', { name: '删除固定规则 新沣' }));

    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith('fixed-meat'));
    await waitFor(() => expect(screen.queryByRole('list', { name: '固定规则' })).not.toBeInTheDocument());
  });
});
