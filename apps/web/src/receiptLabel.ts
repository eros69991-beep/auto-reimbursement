import { formatFen, formGroupLabel, netFenOrNull, type Receipt } from '@auto-reimbursement/contracts';

type Amounts = Pick<Receipt, 'paidFen' | 'refundFen'>;

/**
 * 凭证上显示的金额：实际花的钱。
 * 旧数据里登记过退款的，这里已经是扣掉退款后的数，所以界面上不再单独列「原金额 / 已退款 / 净额」。
 */
export function receiptAmountText(receipt: Amounts): string {
  if (receipt.paidFen === null) return '金额待确认';
  const net = netFenOrNull(receipt);
  return net === null ? '金额异常，请重新填写' : formatFen(net);
}

/**
 * 「分类 · 金额」：卡片标题、勾选框的读屏名称、恢复提示共用这一个写法。
 * 不再用商户名或内部编号——商户名常被识别错，编号用户看不懂；用户认得的是「这笔花在哪类、多少钱」。
 * 公账区：带费用月份的写成「电费（2026年7月） · 114.66」；一张拆成多项的收费通知单写成「含 5 项 · 395.61」，
 * 它没有单一的分类。店内的凭证没有这两样，写法不变。
 */
export function receiptLabel(receipt: Pick<Receipt, 'category'> & Partial<Pick<Receipt, 'lines' | 'period'>> & Amounts): string {
  const name = receipt.lines !== undefined
    ? `含 ${receipt.lines.length} 项`
    : receipt.category === null
      ? '分类待确认'
      : receipt.period === undefined
        ? receipt.category
        : formGroupLabel({ category: receipt.category, period: receipt.period });
  return `${name} · ${receiptAmountText(receipt)}`;
}
