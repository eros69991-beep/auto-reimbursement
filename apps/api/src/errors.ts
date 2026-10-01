// 集中错误表（P-20）：业务错误码 → HTTP 状态 + 面向用户的中文文案。
// 所有路由统一经 toHttpError() 映射；新增错误码只需在 ERROR_TABLE 加一行。

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ErrorSpec {
  status: number;
  message: string;
  /** 对外返回的 code；缺省与抛出的错误码相同 */
  code?: string;
}

const ERROR_TABLE: Record<string, ErrorSpec> = {
  // 404
  BATCH_NOT_FOUND: { status: 404, message: '报销批次不存在' },
  NOT_FOUND: { status: 404, code: 'RECEIPT_NOT_FOUND', message: '凭证不存在' },
  NOTE_NOT_FOUND: { status: 404, message: '备注不存在' },
  PDF_NOT_FOUND: { status: 404, message: '导出文件不存在' },
  BACKUP_NOT_FOUND: { status: 404, message: '备份不存在' },
  // 409
  BATCH_CANCELLED: { status: 409, message: '报销单已撤销，请从本次报销池重新生成' },
  ORIGINAL_CLEANED: { status: 409, message: '原始图片已永久清理，无法恢复' },
  BATCH_RECEIPT_CONFLICT: { status: 409, message: '凭证关联已改变，未执行撤销' },
  NOT_ELIGIBLE: { status: 409, message: '凭证当前状态不可生成' },
  BATCH_FINALIZED: { status: 409, message: '已导出的报销单不可修改' },
  LAYOUT_OUTDATED: { status: 409, message: '这张报销单是按旧版式生成的，放不下新版式。请到「历史」页撤销本单，再从报销池重新生成。' },
  CATEGORY_SPLIT: { status: 409, message: '这个分类的凭证较多，已分到多张报销单上，不能单独移动。' },
  IMMUTABLE_RECEIPT: { status: 409, message: '凭证当前状态不可确认' },
  INCOMPLETE_RECEIPT: { status: 409, message: '凭证当前状态不可确认' },
  UNRESOLVED_DUPLICATE: { status: 409, message: '凭证当前状态不可确认' },
  REFUND_EXCEEDS_PAID: { status: 409, message: '退款金额不能大于实付金额，请先调整退款' },
  MONTH_HAS_UNFINISHED_WORK: { status: 409, message: '本月仍有未完成工作' },
  CLEANUP_NOT_ALLOWED: { status: 409, message: '仅可清理已归档且已导出的凭证' },
  MERGE_NOT_READY: { status: 409, message: '有凭证还在识别中，请等识别完成后再合并' },
  MERGE_NOT_ALLOWED: { status: 409, message: '所选凭证现在不能合并：已生成报销单、已删除、已合并过、带退款记录或原图已清理的不能再合并' },
  MERGE_IMAGE_MISSING: { status: 409, message: '有一张截图文件找不到，无法合并' },
  NOT_MERGED: { status: 409, message: '这张凭证不是合并来的，没有可以拆开的截图' },
  SPLIT_SOURCES_MISSING: { status: 409, message: '合并前的截图记录不完整，无法拆开' },
  SPLIT_HAS_REFUND: { status: 409, message: '这张合并凭证已登记过退款，不能拆开' },
  MERGED_RECEIPT: { status: 409, message: '这张截图已合并进另一张凭证，请在那张凭证上点「拆开」' },
  MIXED_LEDGER: { status: 409, message: '店内报销和公账付款的凭证不能放在同一张单上' },
  MERGE_MIXED_LEDGER: { status: 409, message: '店内报销和公账付款的凭证不能合并' },
  LEDGER_DUPLICATE: { status: 409, message: '同一张图已经在另一个区里了，这张不能再放回来。要用这一张的话，请先把另一个区里的那张删掉' },
  REFUND_NOT_SUPPORTED: { status: 409, message: '公账付款没有退款；金额有变化请直接修改金额' },
  // 400 专项文案
  FORM_TEXT_OVERFLOW: { status: 400, message: '报销单内容超出版式容量，请减少单批凭证数量或缩短填写内容' },
  FORM_AMOUNT_OVERFLOW: { status: 400, message: '报销单内容超出版式容量，请减少单批凭证数量或缩短填写内容' },
  INVALID_CLEANUP_CONFIRMATION: { status: 400, message: '确认文字不正确' },
  RULE_KEY_TOO_SHORT: { status: 400, message: '固定规则的文字至少要 2 个字' },
  INVALID_MERGE: { status: 400, message: '一次合并 2 到 3 张不同的凭证' },
  // 400 通用参数错误（不带 INVALID_ 前缀的少数历史错误码）
  LAYOUT_OVERFLOW: { status: 400, message: '请求参数无效' },
  CATEGORY_TOO_LARGE: { status: 400, message: '这张报销单放不下这个分类（每张最多 5 行，合计不能超过 9999999.99 元）' },
  NOTE_OVERFLOW: { status: 400, message: '请求参数无效' },
  // 413
  IMAGE_TOO_LARGE: { status: 413, message: '上传图片数量或大小超出限制' },
};

/**
 * 把路由内抛出的业务错误统一映射为 HttpError。
 * overrides 用于同一错误码在不同路由上下文需要不同文案的场景。
 * 未命中表且非 INVALID_* 的错误原样返回（最终成为 500 并记录日志）。
 */
export function toHttpError(error: unknown, overrides: Record<string, ErrorSpec> = {}): Error {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) {
    return new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误');
  }
  const spec = overrides[error.message] ?? ERROR_TABLE[error.message] ?? prefixSpec(error.message);
  if (spec !== undefined) {
    return new HttpError(spec.status, spec.code ?? baseCode(error.message), spec.message);
  }
  // 约定：INVALID_* 一律是客户端参数错误
  if (error.message.startsWith('INVALID_')) {
    return new HttpError(400, error.message, '请求参数无效');
  }
  return error;
}

function baseCode(message: string): string {
  const colon = message.indexOf(':');
  return colon === -1 ? message : message.slice(0, colon);
}

function prefixSpec(message: string): ErrorSpec | undefined {
  if (message.startsWith('MISSING_ATTACHMENT')) {
    const receiptId = message.slice('MISSING_ATTACHMENT:'.length);
    return {
      status: 409,
      code: 'MISSING_ATTACHMENT',
      message: receiptId === '' ? '缺少报销凭证图片' : `缺少报销凭证图片：${receiptId}`,
    };
  }
  if (message.startsWith('CLEANUP_FAILED:')) {
    const [, count, receiptId] = message.split(':');
    return {
      status: 409,
      code: 'CLEANUP_FAILED',
      message: `已清理 ${Number(count) || 0} 张，清理凭证失败：${receiptId ?? '未知'}`,
    };
  }
  return undefined;
}
