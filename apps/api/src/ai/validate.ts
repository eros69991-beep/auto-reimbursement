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

export function validateAnalysis(input: unknown): Analysis {
  const result = analysisSchema.safeParse(input);
  if (!result.success) {
    throw new AiError('INVALID_RESPONSE', true);
  }
  return result.data;
}
