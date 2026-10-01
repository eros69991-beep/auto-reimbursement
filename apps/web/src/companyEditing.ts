import { formatFen, parseFen, parsePeriod, type Category, type Payee, type ReceiptLine } from '@auto-reimbursement/contracts';

/**
 * 公账凭证编辑框里的检查和换算：输入框里是用户敲的原样文字，点「确认可付款」时才在这里检查、换成后台要的格式。
 * 规则和后端一致（后端对人工提交的内容是严格校验的）：这里先拦住，用户当场就看到哪一项不对，
 * 不用等后台退回一句笼统的错误。
 */

/** 一张凭证最多拆成几项（和后端一致）。 */
export const MAX_LINES = 20;

const ACCOUNT_PATTERN = /^[0-9A-Za-z]{6,34}$/;

/** 拆成多项时的一行。 */
export interface LineDraft {
  id: number;
  category: Category | '';
  /** 输入框里的原样文字：空、2026-07，不支持月份输入框的浏览器里可能是 2026年7月 之类的写法 */
  period: string;
  amount: string;
}

/**
 * 开头可以有 ¥，数字部分：要么每 3 位一组（第一组 1–3 位、不以 0 开头，各组之间用同一种隔开：逗号或空格），
 * 要么不分组；小数最多两位。第 1 组是整个数字部分，第 2 组是隔开的符号，第 3 组是小数。
 */
const AMOUNT_TEXT = /^¥?\s*([1-9]\d{0,2}([,\s])\d{3}(?:\2\d{3})*|\d+)(\.\d{1,2})?$/;

/**
 * 金额填得不对时跟在提示后面的规则。习惯用逗号当小数点的人敲「114,66」会被拒，
 * 只看到「不对」会摸不着头脑，所以把小数点用「.」说在明处。
 */
export const AMOUNT_RULE = '要大于 0、最多两位小数，小数点用「.」（逗号只用来每三位隔开，如 12,909.49）';

/**
 * 金额输入：银行回单上的金额带千分位（12,909.49），复制过来也认；全角数字、开头的 ¥、空格一并容忍。
 * 逗号和空格只认千分位（每组 3 位，同一个数里用同一种隔开）。「114,66」这种把逗号当小数点的写法，如果也直接去掉逗号，
 * 就成了 11466 元，差了 100 倍，所以不认，让用户自己改成 114.66。
 * 必须是大于 0 的金额（元，最多两位小数），超出可记录的最大金额也不行；不合格返回 null。
 */
export function parseAmountInput(text: string): number | null {
  const match = AMOUNT_TEXT.exec(text.normalize('NFKC').trim());
  if (match === null) return null;
  try {
    const fen = parseFen(`${match[1]!.replace(/[,\s]/g, '')}${match[3] ?? ''}`);
    return fen > 0 ? fen : null;
  } catch {
    return null;
  }
}

/** 费用月份输入：空表示没有；认得出的写法（2026-07、2026年7月、2026/7……）都规范成 YYYY-MM；认不出返回 'invalid'。 */
export function parsePeriodInput(text: string): string | null | 'invalid' {
  if (text.trim() === '') return null;
  return parsePeriod(text) ?? 'invalid';
}

/** 各行金额之和（填错的行按 0 算），编辑框里「合计」那一行用。 */
export function sumLinesFen(rows: readonly LineDraft[]): number {
  return rows.reduce((sum, row) => sum + (parseAmountInput(row.amount) ?? 0), 0);
}

/** 编辑框里显示的金额。超出可记录的最大金额时 formatFen 会抛错，页面不能因此白屏，改成提示。 */
export function showFen(fen: number): string {
  try {
    return formatFen(fen);
  } catch {
    return '金额过大';
  }
}

/**
 * 「合回一项」时单项的金额 = 各项金额之和。空着的行不算；填了但认不出的行不能悄悄当成 0
 * （合回去的金额就少了一截），要让用户先改对；合计超出可记录的最大金额也不行。
 */
export function mergedAmount(rows: readonly LineDraft[]): { fen: number } | { error: string } {
  let total = 0;
  for (const [index, row] of rows.entries()) {
    if (row.amount.trim() === '') continue;
    const fen = parseAmountInput(row.amount);
    if (fen === null) return { error: `第 ${index + 1} 项的金额不对，请先改好再合回一项` };
    total += fen;
  }
  try {
    formatFen(total);
  } catch {
    return { error: '合计金额过大，请检查' };
  }
  return { fen: total };
}

/** 凭证上已有的各项变成编辑框里的行（id 从 0 起）。 */
export function draftsFromLines(lines: readonly ReceiptLine[] | undefined): LineDraft[] {
  return (lines ?? []).map((line, index) => ({
    id: index,
    category: line.category,
    period: line.period ?? '',
    amount: formatFen(line.fen),
  }));
}

/**
 * 拆成多项时的检查和换算：至少 2 项、最多 20 项；每项选了分类、金额大于 0、月份写得对；
 * 同一分类同一月份只能有一项；合计不能超过可记录的最大金额。
 * 成功给后台要的 lines（月份没写的不带 period），失败给一句告诉用户哪一项不对的话。
 */
export function buildLines(rows: readonly LineDraft[]): { lines: ReceiptLine[] } | { error: string } {
  if (rows.length < 2) return { error: '至少要有 2 项；只有一项的话请点「合回一项」' };
  if (rows.length > MAX_LINES) return { error: `最多拆成 ${MAX_LINES} 项` };
  const lines: ReceiptLine[] = [];
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    if (row.category === '') return { error: `第 ${number} 项请选择分类` };
    const fen = parseAmountInput(row.amount);
    if (fen === null) return { error: `第 ${number} 项的金额不对：${AMOUNT_RULE}` };
    const period = parsePeriodInput(row.period);
    if (period === 'invalid') return { error: `第 ${number} 项的费用月份请写成 2026-07 这样` };
    const key = `${row.category}|${period ?? ''}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) return { error: `第 ${earlier} 项和第 ${number} 项的分类、月份都一样，请合并成一项` };
    seen.set(key, number);
    lines.push({ category: row.category, fen, ...(period === null ? {} : { period }) });
  }
  try {
    formatFen(lines.reduce((sum, line) => sum + line.fen, 0));
  } catch {
    return { error: '合计金额过大，请检查' };
  }
  return { lines };
}

/**
 * 收款方：三项都空就是「去掉收款方」(null)；户名、开户银行去掉两头空白；
 * 账号去掉空格和横线（全角数字先换成半角），之后必须是 6–34 位字母数字，否则不让保存。
 */
export function readPayee(input: { name: string; bank: string; account: string }): { payee: Payee | null } | { error: string } {
  const account = input.account.normalize('NFKC').replace(/[\s-]/g, '');
  if (account !== '' && !ACCOUNT_PATTERN.test(account)) {
    return { error: '银行账号应为 6–34 位数字或字母（空格和横线会自动去掉）' };
  }
  const name = input.name.trim();
  const bank = input.bank.trim();
  const payee: Payee = {
    ...(name === '' ? {} : { name }),
    ...(bank === '' ? {} : { bank }),
    ...(account === '' ? {} : { account }),
  };
  return { payee: Object.keys(payee).length === 0 ? null : payee };
}
