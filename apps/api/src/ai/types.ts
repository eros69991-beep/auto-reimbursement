import type { Analysis, ImageRef, Ledger } from '@auto-reimbursement/contracts';

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

export type AnalyzeOptions = {
  /** 凭证所在的区：公账（company）用公账的提示词和校验；不给就是店内 */
  ledger?: Ledger;
};

export interface ReceiptAnalyzer {
  analyzeReceipt(image: AiImage, options?: AnalyzeOptions): Promise<Analysis>;
}
