import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Rule } from '@auto-reimbursement/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RulesEditor } from './RulesEditor';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'merchant:新沣',
    kind: 'merchant',
    key: '新沣',
    originalCategory: '其他公账支出',
    category: '肉款',
    confirmations: 4,
    strong: true,
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('rules editor in the company ledger', () => {
  afterEach(() => cleanup());

  it('offers the company categories and starts the new rule on the first of them', () => {
    render(<RulesEditor ledger="company" rules={[]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '新建固定规则' }));

    const category = screen.getByLabelText('归到分类') as HTMLSelectElement;
    expect(category.value).toBe('肉款');
    expect(Array.from(category.options).map((option) => option.value)).toEqual(['肉款', '品牌管理费', '店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出']);
    expect(screen.getByLabelText('包含文字')).toHaveAttribute('placeholder', '例如：新沣');
  });

  it('keeps the store categories and example on the store editor', () => {
    render(<RulesEditor rules={[]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '新建固定规则' }));

    const category = screen.getByLabelText('归到分类') as HTMLSelectElement;
    expect(category.value).toBe('食材');
    expect(Array.from(category.options).map((option) => option.value)).not.toContain('肉款');
    expect(screen.getByLabelText('包含文字')).toHaveAttribute('placeholder', '例如：武汉仓');
  });

  it('uses 回单 and 付款 in its texts, and 凭证 and 报销 only on the store editor', () => {
    const company = render(<RulesEditor ledger="company" rules={[rule()]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);

    expect(screen.getByRole('button', { name: '套用到待处理回单' })).toBeInTheDocument();
    expect(screen.getByText(/回单会进待处理，并提示规则的分类/)).toBeInTheDocument();
    expect(screen.getByText('用已有识别结果重新套一遍规则，不会重新调用 AI，也不会改动你手动改过的回单。')).toBeInTheDocument();
    expect(company.container).not.toHaveTextContent('凭证');
    company.unmount();

    const store = render(<RulesEditor rules={[rule({ category: '耗材' })]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);
    expect(screen.getByRole('button', { name: '套用到待处理凭证' })).toBeInTheDocument();
    expect(store.container).toHaveTextContent('凭证会进待处理');
  });

  it('tells the user a one-character keyword is too short, in company words', () => {
    render(<RulesEditor ledger="company" rules={[]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '新建固定规则' }));
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: '沣' } });

    expect(screen.getByText('至少 2 个字，避免把无关的回单也归进来。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存规则' })).toBeDisabled();
  });

  it('saves a fixed rule and explains it in company words', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RulesEditor ledger="company" rules={[]} onSave={onSave} onDelete={vi.fn()} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '新建固定规则' }));
    fireEvent.change(screen.getByLabelText('包含文字'), { target: { value: ' 新沣 ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ key: '新沣', category: '肉款', source: 'manual', strong: false })));
    expect(await screen.findByRole('status')).toHaveTextContent('固定规则已保存，之后识别的回单马上按它归类；已在待处理里的，点「套用到待处理回单」。');
  });

  it('reports a reapply in company words, with and without changes', async () => {
    const onReapply = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    render(<RulesEditor ledger="company" rules={[]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={onReapply} />);

    fireEvent.click(screen.getByRole('button', { name: '套用到待处理回单' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已重新套用规则，3 张待处理回单有变化');

    fireEvent.click(screen.getByRole('button', { name: '套用到待处理回单' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('待处理回单里没有需要按规则调整的'));
  });
});
