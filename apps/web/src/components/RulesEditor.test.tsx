import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Rule } from '@auto-reimbursement/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RulesEditor } from './RulesEditor';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'merchant:武汉仓',
    kind: 'merchant',
    key: '武汉仓',
    originalCategory: '食材',
    category: '百慕达食材',
    confirmations: 4,
    strong: true,
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('rules editor', () => {
  afterEach(() => cleanup());

  it('lists fixed rules and learned rules separately', () => {
    render(
      <RulesEditor
        rules={[rule(), rule({ id: 'fixed-1', key: '肉铺', kind: 'keyword', category: '肉类', source: 'manual', confirmations: 0, strong: false })]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onReapply={vi.fn()}
      />,
    );

    expect(screen.getByRole('list', { name: '固定规则' })).toHaveTextContent('包含「肉铺」（商户或图中文字） → 肉类');
    const learned = screen.getByRole('list', { name: '学习到的规则' });
    expect(learned).toHaveTextContent('商户：武汉仓 → 百慕达食材');
    expect(learned).toHaveTextContent('确认 4 次，强规则，AI 原判食材');
    expect(learned).not.toHaveTextContent('肉铺');
  });

  it('promotes a learned rule to a fixed rule under the same id', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RulesEditor rules={[rule()]} onSave={onSave} onDelete={vi.fn()} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '把 武汉仓 设为固定规则' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: 'merchant:武汉仓', key: '武汉仓', category: '百慕达食材', source: 'manual', strong: false,
    })));
    expect(await screen.findByRole('status')).toHaveTextContent('已把「武汉仓」设为固定规则');
  });

  it('cannot promote a one-character learned keyword', () => {
    render(<RulesEditor rules={[rule({ id: 'keyword:仓', kind: 'keyword', key: '仓' })]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn()} />);
    expect(screen.getByRole('button', { name: '把 仓 设为固定规则' })).toBeDisabled();
  });

  it('edits and deletes a fixed rule', async () => {
    const fixed = rule({ id: 'fixed-1', kind: 'keyword', source: 'manual', confirmations: 0, strong: false });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<RulesEditor rules={[fixed]} onSave={onSave} onDelete={onDelete} onReapply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑固定规则 武汉仓' }));
    fireEvent.change(screen.getByLabelText('匹配范围'), { target: { value: 'merchant' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixed-1', kind: 'merchant', source: 'manual' })));

    fireEvent.click(screen.getByRole('button', { name: '删除固定规则 武汉仓' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('fixed-1'));
  });

  it('reports when reapplying changed nothing', async () => {
    render(<RulesEditor rules={[]} onSave={vi.fn()} onDelete={vi.fn()} onReapply={vi.fn().mockResolvedValue(0)} />);
    fireEvent.click(screen.getByRole('button', { name: '套用到待处理凭证' }));
    expect(await screen.findByRole('status')).toHaveTextContent('待处理凭证里没有需要按规则调整的');
  });
});
