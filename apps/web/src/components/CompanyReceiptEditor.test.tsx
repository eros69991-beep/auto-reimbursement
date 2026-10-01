import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Receipt } from '@auto-reimbursement/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { companyNotice, companyReceipt, receipt } from '../test/fixtures';

const { confirmReceipt, deleteReceipt } = vi.hoisted(() => ({ confirmReceipt: vi.fn(), deleteReceipt: vi.fn() }));
vi.mock('../api', () => ({
  api: { confirmReceipt, deleteReceipt },
}));

import { ReceiptEditor } from './ReceiptEditor';

const PAYEE = { name: '示例食品销售有限公司', bank: '示例银行上海分行', account: '1234567890123456789' };

function confirmButton(): HTMLElement {
  return screen.getByRole('button', { name: '确认可付款' });
}

describe('which editor a receipt gets', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('gives a company receipt the payment form: amount, month, payee — and the company wording', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    expect(screen.getByRole('region', { name: '编辑回单' })).toBeInTheDocument();
    expect(screen.getByLabelText('付款金额')).toBeInTheDocument();
    expect(screen.getByLabelText('费用月份')).toBeInTheDocument();
    expect(screen.getByLabelText('收款户名')).toBeInTheDocument();
    expect(screen.getByLabelText('开户银行')).toBeInTheDocument();
    expect(screen.getByLabelText('银行账号')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认可付款' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除回单' })).toBeInTheDocument();
    expect(screen.queryByLabelText('最终实付金额')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认可报销' })).not.toBeInTheDocument();
  });

  it('keeps giving a store receipt the store form, without payee or month', () => {
    render(<ReceiptEditor receipt={receipt({ status: 'pending' })} onSaved={vi.fn()} />);

    expect(screen.getByRole('region', { name: '编辑凭证' })).toBeInTheDocument();
    expect(screen.getByLabelText('最终实付金额')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认可报销' })).toBeInTheDocument();
    expect(screen.queryByLabelText('收款户名')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('银行账号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('费用月份')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拆成多项/ })).not.toBeInTheDocument();
  });

  it('offers only company categories to a company receipt', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);
    const options = Array.from(screen.getByLabelText('分类').querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toEqual(['请选择分类', '肉款', '品牌管理费', '店面租金', '物业费', '水费', '电费', '空调能源费', '其他公账支出']);
  });
});

describe('company receipt with one item', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('starts from what the AI read: amount, category, payee', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('付款金额')).toHaveValue('12909.49');
    expect(screen.getByLabelText('分类')).toHaveValue('肉款');
    expect(screen.getByLabelText('费用月份')).toHaveValue('');
    expect(screen.getByLabelText('收款户名')).toHaveValue(PAYEE.name);
    expect(screen.getByLabelText('开户银行')).toHaveValue(PAYEE.bank);
    expect(screen.getByLabelText('银行账号')).toHaveValue(PAYEE.account);
    expect(screen.getByLabelText('银行账号')).toHaveAccessibleDescription('账号有十几位，请对着图逐位核对，一位都不能错');
    expect(screen.getByLabelText('费用月份')).toHaveAccessibleDescription(/这笔钱是哪个月的费用/);
    // 没有月份选择器的浏览器（Mac 上的 Safari）把它显示成普通文本框，要给个写法的例子
    expect(screen.getByLabelText('费用月份')).toHaveAttribute('placeholder', '例如 2026-07');
  });

  it('confirms with amount, category, month, payee and date in one request', async () => {
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...original, status: 'ready' });
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={original} onSaved={onSaved} />);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    expect(confirmReceipt).toHaveBeenCalledWith('a', {
      paidFen: 1_290_949,
      category: '肉款',
      period: null,
      date: '2026-09-02',
      payee: PAYEE,
    });
    expect(confirmReceipt.mock.calls[0]![1]).not.toHaveProperty('lines');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...original, status: 'ready' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends the month the user picked, for a bill that belongs to an earlier month', async () => {
    const water = companyReceipt({ status: 'pending', category: '水费', paidFen: 4886, recognizedFen: 4886 });
    confirmReceipt.mockResolvedValue({ ...water, status: 'ready' });
    render(<ReceiptEditor receipt={water} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('费用月份'), { target: { value: '2026-07' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({ category: '水费', paidFen: 4886, period: '2026-07' })));
  });

  it('shows the month a receipt already has, and clearing it sends "no month"', async () => {
    const electric = companyReceipt({ status: 'pending', category: '电费', period: '2026-07' });
    confirmReceipt.mockResolvedValue({ ...electric, status: 'ready' });
    render(<ReceiptEditor receipt={electric} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('费用月份')).toHaveValue('2026-07');

    fireEvent.change(screen.getByLabelText('费用月份'), { target: { value: '' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({ period: null })));
  });

  it('takes a bank-receipt amount with thousands separators', async () => {
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...original, status: 'ready' });
    render(<ReceiptEditor receipt={original} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('付款金额'), { target: { value: '6,785.00' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '品牌管理费' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({ paidFen: 678_500, category: '品牌管理费' })));
  });

  it('lets the user correct every payee field and cleans the account number', async () => {
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...original, status: 'ready' });
    render(<ReceiptEditor receipt={original} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('收款户名'), { target: { value: '  另一家公司  ' } });
    fireEvent.change(screen.getByLabelText('开户银行'), { target: { value: '另一家银行' } });
    fireEvent.change(screen.getByLabelText('银行账号'), { target: { value: '6217 0000 1234 5678 901' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({
      payee: { name: '另一家公司', bank: '另一家银行', account: '6217000012345678901' },
    })));
  });

  it('removes the payee when all three fields are emptied', async () => {
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...original, status: 'ready' });
    render(<ReceiptEditor receipt={original} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('收款户名'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('开户银行'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('银行账号'), { target: { value: '' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({ payee: null })));
  });

  it('sends "no payee" for a receipt that never had one', async () => {
    const bare = companyReceipt({ status: 'pending', payee: undefined });
    confirmReceipt.mockResolvedValue({ ...bare, status: 'ready' });
    render(<ReceiptEditor receipt={bare} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('银行账号')).toHaveValue('');
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('a', expect.objectContaining({ payee: null })));
  });

  it('does not send a date it was never given', async () => {
    const undated = companyReceipt({ status: 'pending', date: null });
    confirmReceipt.mockResolvedValue({ ...undated, status: 'ready' });
    render(<ReceiptEditor receipt={undated} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    expect(confirmReceipt.mock.calls[0]![1]).not.toHaveProperty('date');
  });

  it('refuses a wrong account number instead of saving it', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('银行账号'), { target: { value: '12345' } });
    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('银行账号应为 6–34 位数字或字母');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('asks for a category and an amount above zero before confirming', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending', paidFen: null, category: null })} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('请选择分类');

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '肉款' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正确的金额');

    fireEvent.change(screen.getByLabelText('付款金额'), { target: { value: '0' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('请输入正确的金额');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  // 习惯用逗号当小数点的人敲「114,66」：不替他猜（去掉逗号会差 100 倍），但要让他知道小数点用「.」
  it('spells out that the decimal point is a dot when an amount with a decimal comma is turned down', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending', paidFen: null })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('付款金额'), { target: { value: '114,66' } });
    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('请输入正确的金额：要大于 0、最多两位小数，小数点用「.」');
    expect(screen.getByLabelText('付款金额')).toHaveValue('114,66');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('tells the user when the server turns the confirmation down, and lets them try again', async () => {
    confirmReceipt.mockRejectedValueOnce(new Error('这张回单有疑似重复，请先处理'));
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValueOnce({ ...original, status: 'ready' });
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={original} onSaved={onSaved} />);

    fireEvent.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('确认可付款失败：这张回单有疑似重复，请先处理');
    expect(onSaved).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a refusal the server worded for the store (凭证, 报销) in company words', async () => {
    confirmReceipt.mockRejectedValueOnce(new Error('凭证当前状态不可确认'));
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('确认可付款失败：回单当前状态不可确认');
    expect(alert).not.toHaveTextContent('凭证');
  });

  it('locks the form while the request is on its way', async () => {
    const original = companyReceipt({ status: 'pending' });
    let finish: (value: Receipt) => void = () => undefined;
    confirmReceipt.mockReturnValue(new Promise<Receipt>((resolve) => { finish = resolve; }));
    render(<ReceiptEditor receipt={original} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByLabelText('付款金额')).toBeDisabled());
    expect(screen.getByLabelText('银行账号')).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除回单' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /拆成多项/ })).toBeDisabled();

    finish({ ...original, status: 'ready' });
    await waitFor(() => expect(screen.getByLabelText('付款金额')).toBeEnabled());
  });

  it('offers the learned rule category as a one-tap alternative on a rule conflict', async () => {
    const conflict = companyReceipt({
      status: 'pending',
      category: '其他公账支出',
      pendingReasons: ['rule_conflict'],
      ruleMatch: { mode: 'suggested', ruleId: 'merchant:示例食品', key: '示例食品', category: '肉款' },
    });
    confirmReceipt.mockResolvedValue({ ...conflict, category: '肉款', status: 'ready' });
    render(<ReceiptEditor receipt={conflict} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('分类')).toHaveValue('其他公账支出');
    fireEvent.click(screen.getByRole('button', { name: '改用规则分类：肉款' }));
    expect(screen.getByLabelText('分类')).toHaveValue('肉款');
    expect(screen.queryByRole('button', { name: '改用规则分类：肉款' })).not.toBeInTheDocument();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmReceipt).toHaveBeenLastCalledWith('a', expect.objectContaining({ category: '肉款' })));
  });

  it('deletes the receipt only after the user says yes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    deleteReceipt.mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: '删除回单' }));
    expect(confirm).toHaveBeenLastCalledWith('确定删除这张回单吗？');
    expect(deleteReceipt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除回单' }));
    await waitFor(() => expect(deleteReceipt).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', deletedAt: expect.any(String) })));
    confirm.mockRestore();
  });

  it('shows why a delete failed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteReceipt.mockRejectedValue(new Error('已进入付款单，不能删除'));
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '删除回单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已进入付款单，不能删除');
    confirm.mockRestore();
  });

  it('shows a delete refusal the server worded for the store in company words', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteReceipt.mockRejectedValue(new Error('凭证已进入报销单，不能删除'));
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '删除回单' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('回单已进入付款单，不能删除');
    expect(alert).not.toHaveTextContent(/凭证|报销/);
    confirm.mockRestore();
  });
});

describe('splitting a notice into several items', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  function rowValues(number: number): { category: string; period: string; amount: string } {
    return {
      category: (screen.getByLabelText(`第 ${number} 项分类`) as HTMLSelectElement).value,
      period: (screen.getByLabelText(`第 ${number} 项费用月份`) as HTMLInputElement).value,
      amount: (screen.getByLabelText(`第 ${number} 项金额`) as HTMLInputElement).value,
    };
  }

  it('shows one row per item the AI found, with the total and the payee', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    expect(screen.queryByLabelText('付款金额')).not.toBeInTheDocument();
    expect(rowValues(1)).toEqual({ category: '店面租金', period: '2026-09', amount: '22814.10' });
    expect(rowValues(2)).toEqual({ category: '物业费', period: '2026-09', amount: '5069.80' });
    expect(rowValues(3)).toEqual({ category: '水费', period: '2026-07', amount: '48.86' });
    expect(rowValues(4)).toEqual({ category: '电费', period: '2026-07', amount: '11466.87' });
    expect(rowValues(5)).toEqual({ category: '空调能源费', period: '2026-07', amount: '162.00' });
    expect(screen.queryByLabelText('第 6 项分类')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('合计：39561.63');
    expect(screen.getByLabelText('银行账号')).toHaveValue('9876543210987654321');
    // AI 读到的合计和各项之和一致：不用提醒
    expect(screen.queryByText(/AI 读到的通知单合计/)).not.toBeInTheDocument();
  });

  it('gives every item month box an example, for browsers that show it as a plain text box', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    for (const number of [1, 2, 3, 4, 5]) {
      expect(screen.getByLabelText(`第 ${number} 项费用月份`)).toHaveAttribute('placeholder', '例如 2026-07');
    }
  });

  it('confirms the items as they are, and sends no amount, category or month of its own', async () => {
    const notice = companyNotice({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...notice, status: 'ready' });
    render(<ReceiptEditor receipt={notice} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    expect(confirmReceipt).toHaveBeenCalledWith('notice', {
      lines: [
        { category: '店面租金', fen: 2_281_410, period: '2026-09' },
        { category: '物业费', fen: 506_980, period: '2026-09' },
        { category: '水费', fen: 4_886, period: '2026-07' },
        { category: '电费', fen: 1_146_687, period: '2026-07' },
        { category: '空调能源费', fen: 16_200, period: '2026-07' },
      ],
      date: '2026-09-01',
      payee: { name: '示例商管公司', bank: '示例银行武汉分行', account: '9876543210987654321' },
    });
    const sent = confirmReceipt.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('paidFen');
    expect(sent).not.toHaveProperty('category');
    expect(sent).not.toHaveProperty('period');
  });

  it('adds up the total as the user edits, and warns when it no longer matches what the AI read', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 4 项金额'), { target: { value: '11,466.88' } });

    expect(screen.getByRole('status')).toHaveTextContent('合计：39561.64');
    expect(screen.getByText('AI 读到的通知单合计是 39561.63，和各项相加不一样，请对着图核对每一项。')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('第 4 项金额'), { target: { value: '11466.87' } });
    expect(screen.getByRole('status')).toHaveTextContent('合计：39561.63');
    expect(screen.queryByText(/AI 读到的通知单合计/)).not.toBeInTheDocument();
  });

  it('counts a half-typed amount as zero in the total until it is a real amount', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 5 项金额'), { target: { value: '1x' } });

    expect(screen.getByRole('status')).toHaveTextContent('合计：39399.63');
  });

  it('says nothing about the AI total when the AI could not read one', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending', recognizedFen: null })} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第 1 项金额'), { target: { value: '1.00' } });
    expect(screen.queryByText(/AI 读到的通知单合计/)).not.toBeInTheDocument();
  });

  it('lets the user fix a category and month, then sends them as typed', async () => {
    const notice = companyNotice({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...notice, status: 'ready' });
    render(<ReceiptEditor receipt={notice} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 5 项分类'), { target: { value: '其他公账支出' } });
    fireEvent.change(screen.getByLabelText('第 5 项费用月份'), { target: { value: '2026-08' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    const lines = (confirmReceipt.mock.calls[0]![1] as { lines: unknown[] }).lines;
    expect(lines).toHaveLength(5);
    expect(lines[4]).toEqual({ category: '其他公账支出', fen: 16_200, period: '2026-08' });
  });

  it('deletes a row and keeps the others in order, never going below two rows', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 项' }));

    expect(screen.queryByLabelText('第 5 项分类')).not.toBeInTheDocument();
    expect(rowValues(3)).toEqual({ category: '电费', period: '2026-07', amount: '11466.87' });
    expect(screen.getByRole('status')).toHaveTextContent('合计：39512.77');

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 项' }));
    fireEvent.click(screen.getByRole('button', { name: '删除第 2 项' }));
    expect(screen.queryByLabelText('第 3 项分类')).not.toBeInTheDocument();
    expect(rowValues(1)).toEqual({ category: '店面租金', period: '2026-09', amount: '22814.10' });
    expect(screen.getByRole('button', { name: '删除第 1 项' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除第 2 项' })).toBeDisabled();
  });

  it('keeps what was typed in a row when another row is deleted', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 4 项金额'), { target: { value: '12000' } });
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 项' }));

    expect(rowValues(3)).toEqual({ category: '电费', period: '2026-07', amount: '12000' });
  });

  it('adds blank rows, up to twenty', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '再加一项' }));
    expect(rowValues(6)).toEqual({ category: '', period: '', amount: '' });

    for (let count = 6; count < 20; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: '再加一项' }));
    }
    expect(screen.getByLabelText('第 20 项分类')).toBeInTheDocument();
    expect(screen.queryByLabelText('第 21 项分类')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再加一项' })).toBeDisabled();
  });

  it('refuses a blank new row, a repeated category and month, and a bad amount, naming the row', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '再加一项' }));
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('第 6 项请选择分类');

    fireEvent.change(screen.getByLabelText('第 6 项分类'), { target: { value: '电费' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('第 6 项的金额不对');

    fireEvent.change(screen.getByLabelText('第 6 项金额'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('第 6 项费用月份'), { target: { value: '2026-07' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('第 4 项和第 6 项的分类、月份都一样，请合并成一项');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('names the row and spells out the rule for an amount it cannot read, instead of only asking for "above 0"', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 4 项金额'), { target: { value: '50,69' } });
    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('第 4 项的金额不对：要大于 0、最多两位小数，小数点用「.」');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('checks the payee after the items', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('银行账号'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('第 2 项金额'), { target: { value: '' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('第 2 项的金额不对');

    fireEvent.change(screen.getByLabelText('第 2 项金额'), { target: { value: '5069.80' } });
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('银行账号应为 6–34 位数字或字母');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('turns a one-item receipt into two rows: the item as the first row and a blank second', () => {
    const rent = companyReceipt({ status: 'pending', category: '店面租金', period: '2026-09', paidFen: 2_281_410, recognizedFen: 2_281_410 });
    render(<ReceiptEditor receipt={rent} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /拆成多项/ }));

    expect(screen.queryByLabelText('付款金额')).not.toBeInTheDocument();
    expect(rowValues(1)).toEqual({ category: '店面租金', period: '2026-09', amount: '22814.10' });
    expect(rowValues(2)).toEqual({ category: '', period: '', amount: '' });
    expect(screen.getByRole('status')).toHaveTextContent('合计：22814.10');
    // 收款方、日期原样留着
    expect(screen.getByLabelText('银行账号')).toHaveValue(PAYEE.account);
  });

  it('sends the split of a one-item receipt as items only', async () => {
    const rent = companyReceipt({ status: 'pending', category: '店面租金', period: '2026-09', paidFen: 2_281_410 });
    confirmReceipt.mockResolvedValue({ ...rent, status: 'ready' });
    render(<ReceiptEditor receipt={rent} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /拆成多项/ }));
    fireEvent.change(screen.getByLabelText('第 1 项金额'), { target: { value: '22814.10' } });
    fireEvent.change(screen.getByLabelText('第 2 项分类'), { target: { value: '物业费' } });
    fireEvent.change(screen.getByLabelText('第 2 项费用月份'), { target: { value: '2026-09' } });
    fireEvent.change(screen.getByLabelText('第 2 项金额'), { target: { value: '5,069.80' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    const sent = confirmReceipt.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent.lines).toEqual([
      { category: '店面租金', fen: 2_281_410, period: '2026-09' },
      { category: '物业费', fen: 506_980, period: '2026-09' },
    ]);
    expect(sent).not.toHaveProperty('paidFen');
    expect(sent).not.toHaveProperty('period');
    expect(sent).not.toHaveProperty('category');
  });

  it('merges the items back into one: first item category and month, total as the amount, and says the items are gone', async () => {
    const notice = companyNotice({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...notice, status: 'ready' });
    render(<ReceiptEditor receipt={notice} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));

    expect(screen.queryByLabelText('第 1 项分类')).not.toBeInTheDocument();
    expect(screen.getByLabelText('付款金额')).toHaveValue('39561.63');
    expect(screen.getByLabelText('分类')).toHaveValue('店面租金');
    expect(screen.getByLabelText('费用月份')).toHaveValue('2026-09');

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledWith('notice', {
      paidFen: 3_956_163,
      category: '店面租金',
      period: '2026-09',
      lines: null,
      date: '2026-09-01',
      payee: { name: '示例商管公司', bank: '示例银行武汉分行', account: '9876543210987654321' },
    }));
  });

  it('can split again after merging, starting from the merged values', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));
    fireEvent.change(screen.getByLabelText('付款金额'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /拆成多项/ }));

    expect(rowValues(1)).toEqual({ category: '店面租金', period: '2026-09', amount: '100' });
    expect(rowValues(2)).toEqual({ category: '', period: '', amount: '' });
    expect(screen.queryByLabelText('第 3 项分类')).not.toBeInTheDocument();
  });

  it('merges to an empty amount when the items add up to nothing yet', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);
    for (let number = 1; number <= 5; number += 1) {
      fireEvent.change(screen.getByLabelText(`第 ${number} 项金额`), { target: { value: '' } });
    }

    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));

    expect(screen.getByLabelText('付款金额')).toHaveValue('');
  });

  it('does not merge back while an item has an amount it cannot read, names the item, and merges once it is fixed', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    // 逗号当小数点：「48,86」不认，免得合回去的金额悄悄少一截或者多 100 倍
    fireEvent.change(screen.getByLabelText('第 3 项金额'), { target: { value: '48,86' } });
    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));

    expect(screen.getByRole('alert')).toHaveTextContent('第 3 项的金额不对，请先改好再合回一项');
    expect(screen.getByLabelText('第 3 项金额')).toHaveValue('48,86');
    expect(screen.queryByLabelText('付款金额')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('第 3 项金额'), { target: { value: '48.86' } });
    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));

    expect(screen.getByLabelText('付款金额')).toHaveValue('39561.63');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows "too large" instead of breaking the page when the items add up beyond what can be recorded, and refuses to merge or confirm it', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('第 1 项金额'), { target: { value: '9999999999.99' } });
    fireEvent.change(screen.getByLabelText('第 2 项金额'), { target: { value: '9999999999.99' } });

    expect(screen.getByRole('status')).toHaveTextContent('合计：金额过大');
    // 先点「合回一项」：提示只可能是它报的，不会是前面哪一步留下的
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '合回一项' }));
    expect(screen.getByRole('alert')).toHaveTextContent('合计金额过大，请检查');
    expect(screen.getByLabelText('第 1 项金额')).toBeInTheDocument();
    expect(screen.queryByLabelText('付款金额')).not.toBeInTheDocument();
    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('合计金额过大，请检查');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });

  it('clears an old error when switching between one item and several', () => {
    render(<ReceiptEditor receipt={companyReceipt({ status: 'pending', paidFen: null })} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /拆成多项/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks every row while the request is on its way', async () => {
    const notice = companyNotice({ status: 'pending' });
    let finish: (value: Receipt) => void = () => undefined;
    confirmReceipt.mockReturnValue(new Promise<Receipt>((resolve) => { finish = resolve; }));
    render(<ReceiptEditor receipt={notice} onSaved={vi.fn()} />);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByLabelText('第 1 项金额')).toBeDisabled());
    expect(screen.getByLabelText('第 5 项分类')).toBeDisabled();
    expect(screen.getByRole('button', { name: '再加一项' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '合回一项' })).toBeDisabled();
    finish({ ...notice, status: 'ready' });
    await waitFor(() => expect(screen.getByLabelText('第 1 项金额')).toBeEnabled());
  });
});

// 真浏览器的月份选择器只选了一半（比如选了月、没选年）时，输入框的值是空的，但 validity.badInput 为真，
// 这不是「没有月份」。jsdom 自己不会这样，测试里手动把 validity 设上。
describe('a month box that was only half filled in', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  function setHalfFilled(input: HTMLElement, halfFilled: boolean): void {
    Object.defineProperty(input, 'validity', { value: { badInput: halfFilled }, configurable: true });
  }

  it('is not sent as "no month" for a single item, and goes through once it is cleared or completed', async () => {
    const original = companyReceipt({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...original, status: 'ready' });
    render(<ReceiptEditor receipt={original} onSaved={vi.fn()} />);
    const month = screen.getByLabelText('费用月份');
    setHalfFilled(month, true);

    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('费用月份没有选完整，请把年和月都选上，或者清空');
    expect(confirmReceipt).not.toHaveBeenCalled();

    setHalfFilled(month, false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the item of a notice whose month box is half filled', async () => {
    const notice = companyNotice({ status: 'pending' });
    confirmReceipt.mockResolvedValue({ ...notice, status: 'ready' });
    render(<ReceiptEditor receipt={notice} onSaved={vi.fn()} />);
    const month = screen.getByLabelText('第 4 项费用月份');
    setHalfFilled(month, true);

    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('第 4 项的费用月份没有选完整，请把年和月都选上，或者清空');
    expect(confirmReceipt).not.toHaveBeenCalled();

    setHalfFilled(month, false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmReceipt).toHaveBeenCalledTimes(1));
  });

  it('is still caught when the half-filled box is one of several rows after another row was deleted', () => {
    render(<ReceiptEditor receipt={companyNotice({ status: 'pending' })} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 项' }));
    // 删掉第 1 项后，原来的第 3 项（水费）成了第 2 项
    setHalfFilled(screen.getByLabelText('第 2 项费用月份'), true);

    fireEvent.click(confirmButton());

    expect(screen.getByRole('alert')).toHaveTextContent('第 2 项的费用月份没有选完整');
    expect(confirmReceipt).not.toHaveBeenCalled();
  });
});
