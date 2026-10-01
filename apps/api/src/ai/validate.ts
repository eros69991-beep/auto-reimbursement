import {
  CATEGORIES,
  parseFen,
  type Analysis,
} from '@auto-reimbursement/contracts';
import { z } from 'zod';

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
