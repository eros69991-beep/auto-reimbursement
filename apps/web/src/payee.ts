import type { Payee } from '@auto-reimbursement/contracts';

/** 收款方里填了的几项，带上界面上的叫法，按「户名、开户银行、银行账号」的顺序；一项都没有返回空数组。 */
export function payeeRows(payee: Payee | undefined): Array<readonly [label: string, value: string]> {
  if (payee === undefined) return [];
  const candidates: Array<[string, string | undefined]> = [
    ['收款户名', payee.name],
    ['开户银行', payee.bank],
    ['银行账号', payee.account],
  ];
  return candidates.flatMap(([label, value]) => (value === undefined || value === '' ? [] : [[label, value] as const]));
}
