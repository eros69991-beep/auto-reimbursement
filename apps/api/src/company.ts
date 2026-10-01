import {
  COMPANY_CATEGORIES,
  parseFen,
  parsePeriod,
  type Analysis,
  type CompanyCategory,
  type Payee,
  type ReceiptLine,
} from '@auto-reimbursement/contracts';

/**
 * 公账区识别用到的纯函数：把收费通知单上的收费项目映射成分类、按（分类、月份）合并成明细，
 * 清理收款方信息，抹掉不该出现在依据和关键词里的账号。
 * 不依赖数据库和 AI，方便单独测。
 */

/** 认不出的收费项目落到这一类，并且要人看一眼。 */
export const FALLBACK_COMPANY_CATEGORY: CompanyCategory = '其他公账支出';

/**
 * 收费项目名称 → 分类，按顺序匹配，先命中的算。
 * 「品牌」要排在「管理费」前面，免得「品牌管理费」被当成物业费；「空调」排在「电费」前面，「空调电费」算空调能源费。
 * 水电合写的（「水电费」「水电空调」）水费和电费分不开，不猜，交给人拆（见 COMBINED_UTILITY）。
 */
const LABEL_RULES: ReadonlyArray<readonly [RegExp, CompanyCategory]> = [
  [/品牌|加盟|特许/, '品牌管理费'],
  [/租金|房租/, '店面租金'],
  [/物业|物管|管理费/, '物业费'],
  [/空调|能源|能耗/, '空调能源费'],
  [/电费|电力|用电/, '电费'],
  [/水费|用水|自来水/, '水费'],
];

const COMBINED_UTILITY = /水电/;

function normalizeLabel(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '');
}

/** 收费项目名称对应的公账分类；认不出（包括水电合写的）返回 null，调用方落到「其他公账支出」并提示人看一眼。 */
export function categoryForLabel(label: string): CompanyCategory | null {
  const text = normalizeLabel(label);
  if (COMBINED_UTILITY.test(text)) return null;
  for (const [pattern, category] of LABEL_RULES) {
    if (pattern.test(text)) return category;
  }
  return null;
}

/**
 * AI 给的 category 字段：正好是八类之一就用；写成「租金」「品牌费」这类简称的，按同一套关键词认；
 * 别的（包括店内的分类名）一律当作没认出来（null），不让整张凭证识别失败。
 */
export function companyCategoryFromText(value: unknown): CompanyCategory | null {
  if (typeof value !== 'string') return null;
  const text = normalizeLabel(value);
  const exact = COMPANY_CATEGORIES.find((category) => category === text);
  return exact ?? categoryForLabel(text);
}

export interface LineSplit {
  /** 按（分类、月份）合并后的各项，顺序是第一次出现的顺序；每项大于 0 */
  lines: ReceiptLine[];
  /** 各项金额之和（分） */
  sumFen: number;
  /** 有收费项目认不出是什么费用（落到了「其他公账支出」），要人看一眼 */
  hasFallback: boolean;
}

/**
 * 把 AI 读到的收费项目映射成分类，同分类同月份的合并（同一个月两块电表的电费合成一项电费）。
 * - 一项也没有：返回 null。
 * - 只有一项、而且认不出是什么费用：返回 null（多半是回单上多写了一行，照 AI 给的单个分类处理，明细只作为识别依据）。
 * - 其余返回明细：至少 2 项时是一张多项凭证（通知单），只有 1 项时调用方当单分类凭证用它的分类和月份。
 */
export function splitIntoLines(analysis: Analysis): LineSplit | null {
  const items = analysis.lines;
  if (items === undefined || items.length === 0) return null;
  const merged = new Map<string, ReceiptLine>();
  let hasFallback = false;
  for (const item of items) {
    let fen: number;
    try {
      fen = parseFen(item.amount);
    } catch {
      continue;
    }
    if (fen <= 0) continue;
    const mapped = categoryForLabel(item.label);
    if (mapped === null) hasFallback = true;
    const category = mapped ?? FALLBACK_COMPANY_CATEGORY;
    const key = `${category}|${item.period ?? ''}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { category, fen, ...(item.period === undefined ? {} : { period: item.period }) });
      continue;
    }
    const total = existing.fen + fen;
    if (!Number.isSafeInteger(total) || total > 999_999_999_999) return null;
    existing.fen = total;
  }
  const lines = [...merged.values()];
  if (lines.length === 0) return null;
  if (lines.length === 1 && hasFallback) return null;
  return { lines, sumFen: lines.reduce((sum, line) => sum + line.fen, 0), hasFallback };
}

// ---- 收款方 ----

const ACCOUNT_PATTERN = /^[0-9A-Za-z]{6,34}$/;

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' || [...text].length > maxLength ? undefined : text;
}

/**
 * 收款方信息清理：只留看得懂的部分，别的丢掉。户名、开户行去掉多余空白、最长 100 字；
 * 账号去掉空格和横线，只认 6–34 位字母数字（银行账号、卡号）。三项都没有返回 undefined。
 */
export function cleanPayee(input: unknown): Payee | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const name = cleanText(raw.name, 100);
  const bank = cleanText(raw.bank, 100);
  const account =
    typeof raw.account === 'string' || typeof raw.account === 'number'
      ? String(raw.account).replace(/[\s-]/g, '')
      : '';
  const payee: Payee = {
    ...(name === undefined ? {} : { name }),
    ...(bank === undefined ? {} : { bank }),
    ...(ACCOUNT_PATTERN.test(account) ? { account } : {}),
  };
  return Object.keys(payee).length === 0 ? undefined : payee;
}

// 账号：12 位以上连续数字，或者每 4 位一组、至少 4 组。账号只放在收款方（payee.account）里；
// 依据、关键词、商户名这些到处会显示、还会被学成规则的文字里出现账号，一律抹掉。
const ACCOUNT_LIKE = /\d{12,}|(?:\d{4}[ -]){3,}\d{1,4}/g;

export function scrubAccountNumbers(text: string): string {
  return text.replace(ACCOUNT_LIKE, '****');
}

export function looksLikeAccountNumber(text: string): boolean {
  return new RegExp(ACCOUNT_LIKE.source).test(text);
}

/** AI 给的月份：认得出就规范成 YYYY-MM，认不出就当没有（返回 undefined）。 */
export function periodOrUndefined(value: unknown): string | undefined {
  return parsePeriod(value) ?? undefined;
}
