import type { Receipt, Settings, Totals } from '@auto-reimbursement/contracts';

export function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 'a',
    original: {
      id: 'image-a',
      path: '2026-09/originals/image-a.png',
      mime: 'image/png',
      sha256: 'a'.repeat(64),
      perceptualHash: '0123456789abcdef',
      bytes: 100,
      width: 40,
      height: 30,
      deletedAt: null,
    },
    refundImages: [],
    month: '2026-09',
    uploadedAt: '2026-09-03T00:00:00.000Z',
    uploadOrder: 1,
    analysis: {
      amount: '36.33',
      category: '耗材',
      merchant: '示例商户',
      date: '2026-09-02',
      confidence: { amount: 0.4, category: 0.4 },
      ambiguous: false,
      keywords: ['示例'],
      evidence: '付款凭证',
    },
    recognizedFen: 3633,
    paidFen: 3633,
    refundFen: 0,
    category: '耗材',
    merchant: '示例商户',
    date: '2026-09-02',
    status: 'ready',
    pendingReasons: [],
    duplicateIds: [],
    duplicateOverride: false,
    attempts: 0,
    nextAttemptAt: null,
    batchId: null,
    archivedAt: null,
    statusBeforeArchive: null,
    deletedAt: null,
    ...overrides,
  };
}

export const settings: Settings = {
  id: 'default',
  department: '采购部',
  dateMode: 'custom',
  customDate: '2026-09-10',
  signerMode: 'text',
  signerName: '张三',
  signature: null,
  amountThreshold: 0.95,
  categoryThreshold: 0.9,
};

export const totals: Totals = {
  count: 1,
  totalFen: 3633,
  byCategory: {
    食材: 0,
    百慕达食材: 0,
    日常用品: 0,
    耗材: 3633,
    能耗费: 0,
    人工费用: 0,
    肉类: 0,
    租金及管理费: 0,
    酒水: 0,
    员工餐: 0,
  },
};
