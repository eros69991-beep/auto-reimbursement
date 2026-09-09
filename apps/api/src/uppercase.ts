import { formatFen } from '@auto-reimbursement/contracts';

const digits = '零壹贰叁肆伍陆柒捌玖';
const units = ['', '拾', '佰', '仟'];

function section(n: number): string {
  let out = '';
  let gap = false;
  for (let p = 3; p >= 0; p -= 1) {
    const d = Math.floor(n / 10 ** p) % 10;
    if (d) {
      if (gap && out) out += '零';
      out += digits[d] + units[p];
      gap = false;
    } else if (out) {
      gap = true;
    }
  }
  return out;
}

export function chineseUppercase(fen: number): string {
  // Delegating validation first keeps this formatter's accepted range identical
  // to formatFen and ensures no unsafe arithmetic occurs before validation.
  formatFen(fen);

  const yuan = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10;
  const fenDigit = fen % 10;
  const groupValues = [yuan % 10000, Math.floor(yuan / 10000) % 10000, Math.floor(yuan / 100000000) % 10000];
  const groupUnits = ['', '万', '亿'];

  let integer = '';
  let zeroGroup = false;
  for (let i = 2; i >= 0; i -= 1) {
    const value = groupValues[i];
    if (!value) {
      if (integer) zeroGroup = true;
      continue;
    }
    if (integer && (zeroGroup || value < 1000)) integer += '零';
    integer += section(value) + groupUnits[i];
    zeroGroup = false;
  }
  if (!integer) integer = '零';

  let result = integer + '元';
  if (!jiao && !fenDigit) return result + '整';
  if (jiao) result += digits[jiao] + '角';
  if (fenDigit) {
    if (!jiao && yuan > 0) result += '零';
    result += digits[fenDigit] + '分';
  }
  return result;
}
