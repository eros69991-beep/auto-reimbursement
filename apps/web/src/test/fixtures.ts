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

/**
 * 公账区的凭证：一张回单，肉款 12,909.49 元付给示例公司。账号用的是假的示例号码，真实账号不能出现在测试里。
 * 需要别的分类、月份或多项明细时用 overrides 改。
 */
export function companyReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return receipt({
    ledger: 'company',
    analysis: {
      amount: '12909.49',
      category: '肉款',
      merchant: '示例食品销售有限公司',
      date: '2026-09-02',
      confidence: { amount: 0.99, category: 0.99 },
      ambiguous: false,
      keywords: ['示例食品'],
      evidence: '电子回单',
    },
    recognizedFen: 1_290_949,
    paidFen: 1_290_949,
    category: '肉款',
    merchant: '示例食品销售有限公司',
    payee: { name: '示例食品销售有限公司', bank: '示例银行上海分行', account: '1234567890123456789' },
    ...overrides,
  });
}

/** 公账区的收费通知单：拆成租金、物业费（2026-09）和水费、电费、空调能源费（2026-07）五项，合计 39,561.63 元。 */
export function companyNotice(overrides: Partial<Receipt> = {}): Receipt {
  return companyReceipt({
    id: 'notice',
    analysis: {
      amount: '39561.63',
      category: '店面租金',
      merchant: '示例商管公司',
      date: '2026-09-01',
      confidence: { amount: 0.97, category: 0.9 },
      ambiguous: false,
      keywords: ['收费通知单'],
      evidence: '收费通知单',
    },
    recognizedFen: 3_956_163,
    paidFen: 3_956_163,
    category: '店面租金',
    merchant: '示例商管公司',
    date: '2026-09-01',
    lines: [
      { category: '店面租金', fen: 2_281_410, period: '2026-09' },
      { category: '物业费', fen: 506_980, period: '2026-09' },
      { category: '水费', fen: 4_886, period: '2026-07' },
      { category: '电费', fen: 1_146_687, period: '2026-07' },
      { category: '空调能源费', fen: 16_200, period: '2026-07' },
    ],
    payee: { name: '示例商管公司', bank: '示例银行武汉分行', account: '9876543210987654321' },
    ...overrides,
  });
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

/** 公账区付款池的汇总：一张肉款回单加一张收费通知单（五项），合计 52,471.12 元。 */
export const companyTotals: Totals = {
  count: 2,
  totalFen: 5_247_112,
  byCategory: {
    肉款: 1_290_949,
    品牌管理费: 0,
    店面租金: 2_281_410,
    物业费: 506_980,
    水费: 4_886,
    电费: 1_146_687,
    空调能源费: 16_200,
    其他公账支出: 0,
  },
};
