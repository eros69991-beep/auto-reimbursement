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

/**
 * 公账付款区的分类：公司账户付出的款（肉款、品牌管理费、租金、物业费、水电空调）。
 * 和上面店内报销的分类互不相干，两个区各用各的；「其他公账支出」是兜底，装修款、广告费这类不在前五类里的也能记下来。
 */
export const COMPANY_CATEGORIES = [
  '肉款',
  '品牌管理费',
  '店面租金',
  '物业费',
  '水电空调',
  '其他公账支出',
] as const;

export type StoreCategory = (typeof CATEGORIES)[number];
export type CompanyCategory = (typeof COMPANY_CATEGORIES)[number];
export type Category = StoreCategory | CompanyCategory;

/** 两个区的全部分类。规则、移动分类这类不分区的地方用它校验；要按区校验用 categoriesFor。 */
export const ALL_CATEGORIES: readonly Category[] = [...CATEGORIES, ...COMPANY_CATEGORIES];

/**
 * 区域：店内报销（store）和公账付款（company）。两个区的凭证、报销池、待处理、历史、归档、规则互相隔离。
 * 数据里的 ledger 字段缺省就是店内——老数据没有这个字段，当店内处理，不需要迁移。
 */
export type Ledger = 'store' | 'company';
export const LEDGERS: readonly Ledger[] = ['store', 'company'];

export function isLedger(value: unknown): value is Ledger {
  return value === 'store' || value === 'company';
}

/** 一行数据属于哪个区：没有 ledger 字段（老数据）或值不认识都按店内。 */
export function ledgerOf(row: { ledger?: Ledger } | null | undefined): Ledger {
  return row?.ledger === 'company' ? 'company' : 'store';
}

/** 这个区能用的分类。 */
export function categoriesFor(ledger: Ledger): readonly Category[] {
  return ledger === 'company' ? COMPANY_CATEGORIES : CATEGORIES;
}

/** 一个分类属于哪个区。规则没有单独的区字段，靠它的分类判断。 */
export function categoryLedger(category: Category): Ledger {
  return (COMPANY_CATEGORIES as readonly string[]).includes(category) ? 'company' : 'store';
}

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
  | 'rule_conflict'
  | 'incomplete_screenshot';

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
  /** AI 判断这张图只是一张订单的一部分（页面被截断、看不到合计或实付金额）。旧数据没有此字段。 */
  incomplete?: boolean;
  /** 图中的订单号，用来判断两张截图是不是同一单。旧数据没有此字段。 */
  orderNo?: string | null;
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
  /**
   * 这张图是几张截图左右拼成的（合并凭证）时才有：每张截图在拼图里的位置（像素，从左起，按拼接顺序），
   * 中间的分隔线不算在任何一张里。对账时据此一张一张看。旧数据和单张图没有此字段。
   */
  panels?: Array<{ left: number; width: number }>;
  deletedAt: string | null;
}

export interface Receipt {
  /** Absent in older data means included once ready. */
  poolExcluded?: boolean;
  /** 属于哪个区（店内报销 / 公账付款）。缺省（老数据）就是店内；创建后不再变。 */
  ledger?: Ledger;
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
  /** 规则对本张分类的影响，供界面说明；旧数据没有此字段。 */
  ruleMatch?: RuleMatch | null;
  /** 由几张截图合并而来的凭证：来源凭证的 id，按拼接时从左到右的顺序。旧数据没有此字段。 */
  mergedFrom?: string[];
  /**
   * 已被合并进另一张凭证的来源截图：合并后那张凭证的 id。这类凭证被隐藏（同时带 deletedAt），拆开时恢复。
   * 旧数据没有此字段。
   */
  mergedInto?: string;
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
  /**
   * 规则来源。'manual'：设置页手动添加的固定规则——保存即生效，按「包含」匹配，命中就直接决定分类。
   * 缺省或 'learned'：确认分类时自动学到的规则（旧数据没有此字段）。
   */
  source?: 'manual' | 'learned';
}

export interface RuleMatch {
  /** applied：固定规则直接决定了分类；suggested：学习到的强规则与 AI 判断不一致，只作为可一键采用的建议。 */
  mode: 'applied' | 'suggested';
  ruleId: string;
  key: string;
  category: Category;
}

/** 固定规则的文字至少 2 个字，避免「肉」这类单字把大量凭证误归类。 */
export const MIN_MANUAL_RULE_KEY_LENGTH = 2;

export function isManualRule(rule: Pick<Rule, 'source'>): boolean {
  return rule.source === 'manual';
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
  /** Absent in older batches. Kept for the reconcile view; the form no longer prints it (the summary lists amounts). */
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
  /**
   * 只在一个分类的凭证多到一张报销单放不下、被拆到多张上时才有：这是第几部分（从 1 开始）。
   * 这时 totalFen 是这一部分的小计；第 2 部分起报销单上写「分类（续）」。
   */
  part?: number;
}

/** 报销单上写的分类名：被拆到多张上的分类，第 2 部分起带「（续）」。 */
export function formGroupLabel(group: Pick<FormGroup, 'category' | 'part'>): string {
  return group.part !== undefined && group.part > 1 ? `${group.category}（续）` : group.category;
}

/**
 * 对账时对一张凭证的一句话说明：它在第几张报销单、在分类里排第几、本张金额、这个分类的合计。
 * PDF 附件页页眉和网页对账区共用这一个写法，两边读起来一致。
 * 口径与报销单上看得到的一样：被拆到多张上的分类，每一部分单独数「第 i/n 张」、单独合计，第 2 部分起写「（续）」。
 */
export function receiptCaption(input: {
  /** 第几张报销单，从 1 起 */
  sheetNumber: number;
  group: Pick<FormGroup, 'category' | 'part' | 'totalFen'>;
  /** 这张凭证在本分类（本部分）里排第几，从 1 起，顺序与报销单摘要里的金额一致 */
  position: number;
  /** 本分类（本部分）一共几张凭证 */
  count: number;
  /** 本张的实报金额（已扣退款） */
  netFen: number;
}): string {
  const label = formGroupLabel(input.group);
  return [
    `第 ${input.sheetNumber} 张报销单`,
    `${label} 第 ${input.position}/${input.count} 张`,
    `本张 ${formatFen(input.netFen)}`,
    `${label}合计 ${formatFen(input.group.totalFen)}`,
  ].join(' · ');
}

export interface FormSheet {
  id: string;
  groups: FormGroup[];
  noteId: string | null;
}

export interface Batch {
  /** Retains the original snapshot/PDF for audit; never an active reimbursement. */
  cancelledAt?: string | null;
  /** 属于哪个区。缺省（老数据、店内批次）就是店内；一个批次里的凭证都在同一个区。 */
  ledger?: Ledger;
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
  /**
   * pdf 是导出的完整报销 PDF（含全部凭证页）；pdf-form 是同一次导出时顺手存的「只有报销单页」小文件，
   * 只给对账页预览用，不用来下载、归档或备份。
   */
  kind: 'original' | 'refund' | 'signature' | 'pdf' | 'pdf-form';
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
  /** 本区的分类各自的合计（只有本区的分类，另一个区的分类不出现） */
  byCategory: Partial<Record<Category, number>>;
}

export interface UploadResult {
  accepted: Receipt[];
  rejected: Array<{
    index: number;
    code: string;
    duplicateId?: string;
    /** 完全一样的图已经在另一个区里时，说明它在哪个区（同区的重复不带这一项） */
    duplicateLedger?: Ledger;
  }>;
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

// ---- 合并截图：同一张订单被截成几张图，在服务器左右拼成一张再识别 ----

/** 一次合并 2–3 张截图：左右并排，再多每张就缩得看不清了。 */
export const MERGE_MIN = 2;
export const MERGE_MAX = 3;

/**
 * 这张凭证现在能不能被合并：还没进报销单、没删除、没归档、没有退款记录，原图还在，
 * 且自己不是合并出来的（合并过的要先拆开）。识别中的凭证要等识别完才能合并，所以这里也返回 false。
 */
export function canMergeReceipt(receipt: Receipt): boolean {
  return (
    (receipt.status === 'pending' || receipt.status === 'ready') &&
    receipt.deletedAt === null &&
    receipt.archivedAt === null &&
    receipt.batchId === null &&
    receipt.refundFen === 0 &&
    receipt.refundImages.length === 0 &&
    receipt.mergedFrom === undefined &&
    receipt.mergedInto === undefined &&
    receipt.original.deletedAt === null
  );
}

export interface MergeSuggestion {
  /** 建议合并的凭证，按上传顺序从左到右 */
  receiptIds: string[];
  /** 判断依据：订单号相同 / 商户相同 / 日期相同 */
  basis: Array<'orderNo' | 'merchant' | 'date'>;
}

/** 视为同一次上传：两张的上传时间相差不超过 10 分钟 */
const MERGE_SAME_UPLOAD_MS = 10 * 60_000;
/** 上传顺序里相隔不超过几张（分批并发上传时，同一单的两张不一定紧挨着） */
const MERGE_NEAR_POSITIONS = 3;

function mergeText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

/** 缺金额、被 AI 标为不完整、或金额有多个候选：看起来只是一张订单的一部分 */
function looksIncomplete(receipt: Receipt): boolean {
  const analysis = receipt.analysis;
  return analysis !== null && (analysis.incomplete === true || analysis.ambiguous || analysis.amount === null);
}

function mergeBasis(left: Receipt, right: Receipt): MergeSuggestion['basis'] | null {
  const orderLeft = mergeText(left.analysis?.orderNo);
  const orderRight = mergeText(right.analysis?.orderNo);
  if (orderLeft !== '' && orderRight !== '') {
    // 订单号都看清了：相同一定是同一单，不同一定不是，不再看别的
    return orderLeft === orderRight ? ['orderNo'] : null;
  }
  const merchantLeft = mergeText(left.merchant);
  const merchantRight = mergeText(right.merchant);
  const dateLeft = left.date;
  const dateRight = right.date;
  if (merchantLeft !== '' && merchantRight !== '' && merchantLeft !== merchantRight) return null;
  if (dateLeft !== null && dateRight !== null && dateLeft !== dateRight) return null;
  const basis: MergeSuggestion['basis'] = [];
  if (merchantLeft !== '' && merchantLeft === merchantRight) basis.push('merchant');
  if (dateLeft !== null && dateLeft === dateRight) basis.push('date');
  if (basis.length === 0) return null;
  // 商户 / 日期相同的凭证很多，只在其中一张看起来不完整时才提示，免得把正常的两张当成一单
  return looksIncomplete(left) || looksIncomplete(right) ? basis : null;
}

/**
 * 找出疑似同一单的截图对：上传时间相近、上传顺序相邻、商户或日期相同（订单号相同最可靠），
 * 且其中一张缺金额或被标为不完整。每张最多出现在一个建议里；传入待处理和报销池的凭证一起算。
 */
export function suggestMerges(receipts: Receipt[]): MergeSuggestion[] {
  const candidates = [...new Map(receipts.map((receipt) => [receipt.id, receipt])).values()]
    .filter((receipt) => canMergeReceipt(receipt) && receipt.analysis !== null)
    .sort((left, right) => left.uploadOrder - right.uploadOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const used = new Set<string>();
  const suggestions: MergeSuggestion[] = [];
  for (const [index, receipt] of candidates.entries()) {
    if (used.has(receipt.id)) continue;
    let best: { offset: number; basis: MergeSuggestion['basis'] } | null = null;
    for (let offset = -MERGE_NEAR_POSITIONS; offset <= MERGE_NEAR_POSITIONS; offset += 1) {
      const partner = offset === 0 ? undefined : candidates[index + offset];
      if (partner === undefined || used.has(partner.id)) continue;
      const gap = Math.abs(Date.parse(receipt.uploadedAt) - Date.parse(partner.uploadedAt));
      if (!(gap <= MERGE_SAME_UPLOAD_MS)) continue;
      const basis = mergeBasis(receipt, partner);
      if (basis === null) continue;
      const better = best === null
        || (basis.includes('orderNo') && !best.basis.includes('orderNo'))
        || (basis.includes('orderNo') === best.basis.includes('orderNo')
          && (Math.abs(offset) < Math.abs(best.offset) || (Math.abs(offset) === Math.abs(best.offset) && offset > 0)));
      if (better) best = { offset, basis };
    }
    if (best === null) continue;
    const partner = candidates[index + best.offset]!;
    used.add(receipt.id);
    used.add(partner.id);
    suggestions.push({
      receiptIds: best.offset > 0 ? [receipt.id, partner.id] : [partner.id, receipt.id],
      basis: best.basis,
    });
  }
  return suggestions;
}
