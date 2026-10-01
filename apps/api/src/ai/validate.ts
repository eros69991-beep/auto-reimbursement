import {
  CATEGORIES,
  COMPANY_CATEGORIES,
  parseFen,
  parsePeriod,
  type Analysis,
} from '@auto-reimbursement/contracts';
import { z } from 'zod';

import {
  cleanPayee,
  companyCategoryFromText,
  looksLikeAccountNumber,
  scrubAccountNumbers,
} from '../company.js';
import { AiError } from './types.js';

function isMoney(value: string): boolean {
  try {
    parseFen(value);
    return true;
  } catch {
    return false;
  }
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const confidenceSchema = z
  .object({
    amount: z.number().finite().min(0).max(1),
    category: z.number().finite().min(0).max(1),
  })
  .strict();

const analysisSchema = z
  .object({
    amount: z.string().refine(isMoney).nullable(),
    category: z.enum(CATEGORIES).nullable(),
    merchant: z.string().max(200).nullable(),
    date: z.string().refine(isRealIsoDate).nullable(),
    confidence: confidenceSchema,
    ambiguous: z.boolean(),
    keywords: z.array(z.string().max(100)).max(20),
    evidence: z.string().max(2000),
    // 以下两项是后加的，旧结果没有（可以不出现）；进来之前 usableHints 已经把不能用的值去掉
    incomplete: z.boolean().optional(),
    orderNo: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((analysis, context) => {
    if (analysis.ambiguous && analysis.amount !== null) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Ambiguous payment amounts must remain null',
      });
    }
  });

/**
 * incomplete 和 orderNo 只是辅助判断（要不要提示合并、要不要交给人确认），不是识别本身：
 * 模型给了不能用的值（类型不对、空的、太长，或者对不适用的项给了 null）就当没给，
 * 订单号全是数字时模型可能给成数字，转成文字收下。不能因为这两项让整张凭证识别失败。
 */
function usableHints(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const { incomplete, orderNo, ...rest } = input as Record<string, unknown>;
  const hints: { incomplete?: boolean; orderNo?: string } = {};
  if (typeof incomplete === 'boolean') {
    hints.incomplete = incomplete;
  }
  const text =
    typeof orderNo === 'number' && Number.isSafeInteger(orderNo) && orderNo > 0
      ? String(orderNo)
      : orderNo;
  if (typeof text === 'string' && text.trim() !== '' && text.trim().length <= 100) {
    hints.orderNo = text.trim();
  }
  return { ...rest, ...hints };
}

export function validateAnalysis(input: unknown): Analysis {
  const result = analysisSchema.safeParse(usableHints(input));
  if (!result.success) {
    throw new AiError('INVALID_RESPONSE', true);
  }
  return result.data;
}

// ---- 公账区：银行回单、收费通知单 ----

const periodSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);

const companyAnalysisSchema = z
  .object({
    amount: z.string().refine(isMoney).nullable(),
    category: z.enum(COMPANY_CATEGORIES).nullable(),
    merchant: z.string().max(200).nullable(),
    date: z.string().refine(isRealIsoDate).nullable(),
    confidence: confidenceSchema,
    ambiguous: z.boolean(),
    keywords: z.array(z.string().max(100)).max(20),
    evidence: z.string().max(2000),
    incomplete: z.boolean().optional(),
    orderNo: z.string().max(100).optional(),
    period: periodSchema.optional(),
    payee: z
      .object({
        name: z.string().max(100).optional(),
        bank: z.string().max(100).optional(),
        account: z.string().max(34).optional(),
      })
      .strict()
      .optional(),
    lines: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            amount: z.string().refine(isMoney),
            period: periodSchema.optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((analysis, context) => {
    if (analysis.ambiguous && analysis.amount !== null) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Ambiguous payment amounts must remain null',
      });
    }
  });

/** 千分位写法：第一组 1–3 位、不以 0 开头，每组 3 位，组与组之间用同一种逗号或空格，例如「12,909.49」「1 234 567」。 */
const GROUPED = /^[1-9]\d{0,2}([,\s])\d{3}(?:\1\d{3})*(?:\.\d+)?$/;

/**
 * 金额：去掉货币符号、「元」和千分位逗号，数字类型转成两位小数的字符串；空字符串当没有。
 * 逗号和空格只认千分位（每组 3 位）：「114,66」「12 34」这种把逗号当小数点的写法，
 * 如果也直接去掉就变成 11466 元，差了 100 倍，所以原样留着，让后面的校验当作认不出。
 */
function normalizeMoney(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value.toFixed(2) : value;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const bare = value
    .normalize('NFKC')
    .replace(/人民币|RMB|CNY|[¥￥$元]/gi, '')
    .trim();
  const text = (GROUPED.test(bare) ? bare.replace(/[,\s]/g, '') : bare).replace(/(\.\d{2})0+$/, '$1');
  return text === '' ? null : text;
}

/** 日期：「2026年9月3日」「2026/09/03」这类写法转成 YYYY-MM-DD；认不出的原样交给后面的校验。 */
function normalizeDate(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const match = /^(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?$/.exec(value.normalize('NFKC').replace(/\s+/g, ''));
  if (match === null) {
    return value === '' ? null : value;
  }
  return `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
}

function usableLines(input: unknown): Array<{ label: string; amount: string; period?: string }> | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const lines: Array<{ label: string; amount: string; period?: string }> = [];
  for (const item of input.slice(0, 20)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === 'string' ? scrubAccountNumbers(raw.label.replace(/\s+/g, ' ').trim()) : '';
    const amount = normalizeMoney(raw.amount);
    // 金额认不出、是 0 或负数的项丢掉：合计对不上时由决策标出来让人核对，不替人悄悄补
    if (label === '' || [...label].length > 100 || typeof amount !== 'string' || !isMoney(amount) || parseFen(amount) <= 0) {
      continue;
    }
    const period = parsePeriod(raw.period);
    lines.push({ label, amount, ...(period === null ? {} : { period }) });
  }
  return lines.length === 0 ? undefined : lines;
}

/**
 * 公账区的结果比店内宽松一档：模型常把金额写成「12,909.49」「¥6,785.00」，分类写成别的叫法，
 * 月份写成「2026年7月」，这些先整理成规范的值；不认识的分类、月份当作没有，不让整张凭证识别失败。
 * 账号只留在 payee.account 里：商户名、依据、关键词里出现账号一律抹掉（关键词会被学成规则，不能是账号）。
 */
function usableCompanyFields(input: unknown): unknown {
  const base = usableHints(input);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return base;
  }
  const { amount, category, merchant, date, keywords, evidence, lines, period, payee, ...rest } = base as Record<string, unknown>;
  const cleanedLines = usableLines(lines);
  const cleanedPayee = cleanPayee(payee);
  const parsedPeriod = parsePeriod(period);
  return {
    ...rest,
    amount: normalizeMoney(amount),
    category: companyCategoryFromText(category),
    merchant: typeof merchant === 'string' ? scrubAccountNumbers(merchant) : merchant,
    date: normalizeDate(date),
    keywords: Array.isArray(keywords)
      ? keywords.filter((keyword) => typeof keyword !== 'string' || !looksLikeAccountNumber(keyword))
      : keywords,
    evidence: typeof evidence === 'string' ? scrubAccountNumbers(evidence) : evidence,
    ...(cleanedLines === undefined ? {} : { lines: cleanedLines }),
    ...(parsedPeriod === null ? {} : { period: parsedPeriod }),
    ...(cleanedPayee === undefined ? {} : { payee: cleanedPayee }),
  };
}

export function validateCompanyAnalysis(input: unknown): Analysis {
  const result = companyAnalysisSchema.safeParse(usableCompanyFields(input));
  if (!result.success) {
    throw new AiError('INVALID_RESPONSE', true);
  }
  return result.data;
}
