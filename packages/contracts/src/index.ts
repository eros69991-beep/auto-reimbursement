export const CATEGORIES = [
  '食材',
  '百慕达食材',
  '日常用品',
  '耗材',
  '能耗费',
  '人工费用',
  '肉类',
  '租金及管理费',
  '酒水',
  '员工餐',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Status =
  | 'recognizing'
  | 'pending'
  | 'ready'
  | 'generated'
  | 'archived';

export const STATUS_LABELS: Record<Status, string> = {
  recognizing: '识别中',
  pending: '待处理',
  ready: '可报销',
  generated: '已生成报销单',
  archived: '已归档',
};

export type Reason =
  | 'amount_uncertain'
  | 'category_uncertain'
  | 'api_failed'
  | 'suspected_duplicate'
  | 'ambiguous_amount'
  | 'unreadable'
  | 'rule_conflict';

export interface Confidence {
  amount: number;
  category: number;
}

export interface Analysis {
  amount: string | null;
  category: Category | null;
  merchant: string | null;
  date: string | null;
  confidence: Confidence;
  ambiguous: boolean;
  keywords: string[];
  evidence: string;
}

export interface ImageRef {
  id: string;
  path: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  /** 用户上传原始字节的 SHA-256：查重指纹，去 EXIF 重编码前计算，保证同一文件重复上传结果稳定。 */
  sha256: string;
  /**
   * 实际落盘字节的 SHA-256（去 EXIF 重编码后），文件索引用它做完整性校验。
   * 旧数据没有此字段，表示落盘字节就是上传原始字节（与 sha256 相同）。
   */
  fileSha256?: string;
  perceptualHash: string;
  bytes: number;
  width: number;
  height: number;
  deletedAt: string | null;
}

export interface Receipt {
  /** Absent in older data means included once ready. */
  poolExcluded?: boolean;
  id: string;
  original: ImageRef;
  refundImages: ImageRef[];
  month: string;
  uploadedAt: string;
  uploadOrder: number;
  analysis: Analysis | null;
  recognizedFen: number | null;
  paidFen: number | null;
  refundFen: number;
  category: Category | null;
  merchant: string | null;
  date: string | null;
  status: Status;
  pendingReasons: Reason[];
  duplicateIds: string[];
  duplicateOverride: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  batchId: string | null;
  archivedAt: string | null;
  statusBeforeArchive: Status | null;
  deletedAt: string | null;
}

export interface Rule {
  id: string;
  kind: 'merchant' | 'keyword';
  key: string;
  originalCategory: Category | null;
  category: Category;
  confirmations: number;
  strong: boolean;
  updatedAt: string;
}

export interface Note {
  id: string;
  name: string;
  content: string;
}

export interface Settings {
  id: 'default';
  department: string;
  dateMode: 'today' | 'blank' | 'custom';
  customDate: string | null;
  signerMode: 'text' | 'image';
  signerName: string;
  signature: ImageRef | null;
  amountThreshold: number;
  categoryThreshold: number;
}

export interface FormOptions {
  department: string;
  date: string | null;
  signerMode: 'text' | 'image';
  signerName: string;
  signature: ImageRef | null;
}

export interface Snapshot {
  receiptId: string;
  uploadOrder: number;
  category: Category;
  /** Absent in older batches; the form falls back to the category as summary text. */
  merchant?: string | null;
  paidFen: number;
  refundFen: number;
  netFen: number;
  original: ImageRef;
  refundImages: ImageRef[];
}

export interface FormGroup {
  category: Category;
  receiptIds: string[];
  amountsFen: number[];
  totalFen: number;
}

export interface FormSheet {
  id: string;
  groups: FormGroup[];
  noteId: string | null;
}

export interface Batch {
  /** Retains the original snapshot/PDF for audit; never an active reimbursement. */
  cancelledAt?: string | null;
  id: string;
  month: string;
  createdAt: string;
  totalFen: number;
  items: Snapshot[];
  sheets: FormSheet[];
  options: FormOptions;
  notes: Note[];
  pdfPath: string | null;
  archivedAt: string | null;
}

export interface FileIndexEntry {
  id: string;
  ownerId: string;
  kind: 'original' | 'refund' | 'signature' | 'pdf';
  path: string;
  sha256: string;
  deletedAt: string | null;
}

export interface Tables {
  receipts: Receipt;
  rules: Rule;
  settings: Settings;
  notes: Note;
  batches: Batch;
  files: FileIndexEntry;
}

export type Table = keyof Tables;

export interface Totals {
  count: number;
  totalFen: number;
  byCategory: Record<Category, number>;
}

export interface UploadResult {
  accepted: Receipt[];
  rejected: Array<{ index: number; code: string; duplicateId?: string }>;
}

export interface Progress {
  recognizing: number;
  ready: number;
  pending: number;
  total: number;
}

export interface ApiStatus {
  configured: boolean;
  provider: string | null;
}

export interface Preview {
  batch: Batch;
  pdfUrl: string;
}

export interface HistoryMonth {
  month: string;
  batches: Batch[];
}

export interface MaintenanceResult {
  affected: number;
}

export interface BackupResult {
  downloadUrl: string;
  includesImages: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export function parseFen(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error('INVALID_AMOUNT');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount > 999999999999n) {
    throw new Error('AMOUNT_OVERFLOW');
  }
  return Number(amount);
}

export function formatFen(value: number): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 999999999999
  ) {
    throw new Error('INVALID_AMOUNT');
  }
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

export function netFen(
  receipt: Pick<Receipt, 'paidFen' | 'refundFen'>,
): number {
  if (
    receipt.paidFen === null ||
    !Number.isSafeInteger(receipt.paidFen) ||
    receipt.paidFen < 0 ||
    receipt.paidFen > 999999999999 ||
    !Number.isSafeInteger(receipt.refundFen) ||
    receipt.refundFen < 0 ||
    receipt.refundFen > receipt.paidFen
  ) {
    throw new Error('INVALID_REFUND');
  }
  return receipt.paidFen - receipt.refundFen;
}

/**
 * 不抛异常的净额计算：数据异常（如退款大于实付的存量脏数据）时返回 null，
 * 调用方据此降级展示，不能让单条脏数据拖垮整个页面或接口。
 */
export function netFenOrNull(
  receipt: Pick<Receipt, 'paidFen' | 'refundFen'>,
): number | null {
  try {
    return netFen(receipt);
  } catch {
    return null;
  }
}
