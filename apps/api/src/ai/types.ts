import type { Analysis, ImageRef } from '@auto-reimbursement/contracts';

export type AiErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'INVALID_RESPONSE';

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export type AiImage = {
  bytes: Buffer;
  mime: ImageRef['mime'];
};

export interface ReceiptAnalyzer {
  analyzeReceipt(image: AiImage): Promise<Analysis>;
}
