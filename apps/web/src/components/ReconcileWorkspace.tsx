import { useEffect, useMemo, useRef, useState } from 'react';

import { formGroupLabel, formatFen, receiptCaption, type Batch, type FormGroup } from '@auto-reimbursement/contracts';

import { useAuthedUrl } from './AuthedImage';
import { PdfPreview } from './PdfPreview';

interface ChecklistReceipt {
  receiptId: string;
  netFen: number;
  paidFen: number;
  refundFen: number;
  /** 在本分类（本部分）里排第几，从 1 起；顺序与报销单摘要里写的金额一致 */
  position: number;
}

interface ChecklistGroup {
  key: string;
  /** 报销单上写的分类名；被拆到多张上的分类，第 2 部分起带「（续）」 */
  label: string;
  group: Pick<FormGroup, 'category' | 'part' | 'totalFen'>;
  receipts: ChecklistReceipt[];
}

interface ChecklistSheet {
  id: string;
  /** 第几张报销单，从 1 起 */
  number: number;
  groups: ChecklistGroup[];
}

interface AttachmentItem extends ChecklistReceipt {
  sheetNumber: number;
  group: ChecklistGroup;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/**
 * 同屏对账工作区。
 * 左边：「对账清单」——按报销单、分类列出每张凭证的实报金额（顺序同报销单摘要，大字可点），
 * 下面是报销单原样的 PDF 预览；右边：当前凭证图。点一个金额，右边切到那张凭证，清单同步高亮。
 * 窄屏（手机）上下分区：上半区默认是清单，按钮可切成报销单原样，下半区是凭证图，各自在区内滚动，
 * 这样看凭证图时清单不会滚走；宽屏左右双栏，左边清单在上、报销单在下。
 * 关联基于 receiptId（不依赖数组下标）。
 */
export function ReconcileWorkspace({ batch, previewUrl }: { batch: Batch; previewUrl: string }): React.JSX.Element {
  const sheets = useMemo<ChecklistSheet[]>(() => {
    const itemById = new Map(batch.items.map((item) => [item.receiptId, item]));
    return batch.sheets.map((sheet, sheetIndex) => ({
      id: sheet.id,
      number: sheetIndex + 1,
      // 顺序就用报销单上的分组顺序和组内顺序（与摘要里的金额、PDF 附件页一致），不再另排
      groups: sheet.groups.map((group, groupIndex) => ({
        key: `${sheet.id}:${groupIndex}`,
        label: formGroupLabel(group),
        group,
        receipts: group.receiptIds
          .flatMap((receiptId) => {
            const item = itemById.get(receiptId);
            return item === undefined ? [] : [item];
          })
          .map((item, index) => ({
            receiptId: item.receiptId,
            netFen: item.netFen,
            paidFen: item.paidFen,
            refundFen: item.refundFen,
            position: index + 1,
          })),
      })),
    }));
  }, [batch]);

  const attachments = useMemo<AttachmentItem[]>(
    () => sheets.flatMap((sheet) => sheet.groups.flatMap((group) =>
      group.receipts.map((receipt) => ({ ...receipt, sheetNumber: sheet.number, group })))),
    [sheets],
  );

  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [failedReceiptId, setFailedReceiptId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  const pdfRef = useRef<HTMLElement>(null);

  const current = attachments.find((item) => item.receiptId === selectedReceiptId) ?? attachments[0] ?? null;
  const currentIndex = current === null ? -1 : attachments.indexOf(current);
  const imageFailed = current !== null && failedReceiptId === current.receiptId;
  // 传相对路径：fetchBlobUrl 内部会拼 API 地址（传完整 URL 曾被拼两次导致 404）
  const { url: imageUrl, failed: fetchFailed } = useAuthedUrl(
    current === null || imageFailed
      ? null
      : `/api/receipts/${encodeURIComponent(current.receiptId)}/original-image?r=${retryCount}`,
  );

  // 切换凭证时，报销单原样跟随滚动到该凭证所属的那张报销单（多页报销单里夹着备注续页、凭证页，不能按页码推算）；
  // 手机上从清单切到「报销单原样」时也定位一次。
  useEffect(() => {
    if (current === null) return;
    const canvas = pdfRef.current?.querySelector(`canvas[data-sheet-index="${current.sheetNumber - 1}"]`);
    (canvas as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, showForm]);

  // 用上一张 / 下一张切换时，清单里对应的金额也滚进可见范围（清单自己在半区内滚动）。
  useEffect(() => {
    if (current === null) return;
    const chips = listRef.current?.querySelectorAll<HTMLElement>('[data-receipt-id]') ?? [];
    for (const chip of chips) {
      if (chip.dataset.receiptId === current.receiptId) {
        chip.scrollIntoView?.({ block: 'nearest' });
        break;
      }
    }
  }, [current]);

  function select(receiptId: string): void {
    setSelectedReceiptId(receiptId);
    setFailedReceiptId(null);
  }

  const caption = current === null
    ? ''
    : receiptCaption({
      sheetNumber: current.sheetNumber,
      group: current.group.group,
      position: current.position,
      count: current.group.receipts.length,
      netFen: current.netFen,
    });

  return (
    <div className="reconcile" data-view={showForm ? 'form' : 'list'}>
      <div className="reconcile-form">
        {current !== null && (
          <button
            type="button"
            className="reconcile-toggle"
            aria-pressed={showForm}
            onClick={() => setShowForm((value) => !value)}
          >
            {showForm ? '返回对账清单' : '查看报销单原样'}
          </button>
        )}
        {current !== null && (
          <section className="reconcile-list" aria-label="对账清单" ref={listRef}>
            {sheets.map((sheet) => (
              <div key={sheet.id} className="reconcile-sheet">
                <h3 className="reconcile-sheet-title">第 {sheet.number} 张报销单</h3>
                {sheet.groups.map((group) => (
                  <div key={group.key} className="reconcile-group">
                    <p className="reconcile-group-head">
                      <strong>{group.label}</strong>
                      <span>{group.receipts.length} 张 · 合计 {formatFen(group.group.totalFen)}</span>
                    </p>
                    <ul className="reconcile-amounts" aria-label={`${group.label}的凭证金额`}>
                      {group.receipts.map((receipt) => (
                        <li key={receipt.receiptId}>
                          <button
                            type="button"
                            className="reconcile-amount"
                            data-receipt-id={receipt.receiptId}
                            aria-current={receipt.receiptId === current.receiptId}
                            aria-label={`${formatFen(receipt.netFen)}（${group.label} 第 ${receipt.position}/${group.receipts.length} 张）`}
                            onClick={() => select(receipt.receiptId)}
                          >
                            {formatFen(receipt.netFen)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
        <section className="reconcile-pdf" aria-label="报销单原样" ref={pdfRef}>
          <PdfPreview url={previewUrl} />
        </section>
      </div>
      <section className="reconcile-side" aria-label="凭证附件">
        {current === null ? (
          <p>本批次没有关联凭证。</p>
        ) : (
          <div className="attachment-viewer">
            <p className="attachment-title">{caption}</p>
            {current.refundFen > 0 && (
              <p className="attachment-note">
                原实付 {formatFen(current.paidFen)} / 退款 {formatFen(current.refundFen)} / 实报 {formatFen(current.netFen)}
              </p>
            )}
            <div className="attachment-toolbar">
              <button
                type="button"
                disabled={currentIndex <= 0}
                onClick={() => select(attachments[currentIndex - 1]!.receiptId)}
              >
                上一张
              </button>
              <span
                className="attachment-position"
                aria-label={`全部凭证中的第 ${currentIndex + 1} 张，共 ${attachments.length} 张`}
              >
                {currentIndex + 1} / {attachments.length}
              </span>
              <button
                type="button"
                disabled={currentIndex < 0 || currentIndex >= attachments.length - 1}
                onClick={() => select(attachments[currentIndex + 1]!.receiptId)}
              >
                下一张
              </button>
              <button
                type="button"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value * ZOOM_STEP))}
              >
                放大
              </button>
              <button
                type="button"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value / ZOOM_STEP))}
              >
                缩小
              </button>
              <button type="button" disabled={zoom === 1} onClick={() => setZoom(1)}>
                恢复适宽
              </button>
            </div>
            <div className="attachment-image-scroll">
              {imageFailed || fetchFailed ? (
                <p role="alert">
                  凭证图片加载失败。{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setFailedReceiptId(null);
                      setRetryCount((value) => value + 1);
                    }}
                  >
                    重试
                  </button>
                </p>
              ) : imageUrl === null ? (
                <p aria-hidden="true">图片加载中…</p>
              ) : (
                <img
                  key={`${current.receiptId}:${retryCount}`}
                  src={imageUrl}
                  alt={`凭证 ${currentIndex + 1}：${current.group.label} ${formatFen(current.netFen)}`}
                  style={{ width: `${zoom * 100}%` }}
                  onError={() => setFailedReceiptId(current.receiptId)}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
