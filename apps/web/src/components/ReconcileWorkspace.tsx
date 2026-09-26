import { useEffect, useMemo, useRef, useState } from 'react';

import { formatFen, type Batch } from '@auto-reimbursement/contracts';

import { api } from '../api';
import { PdfPreview } from './PdfPreview';

interface ReconcileRow {
  key: string;
  sheetIndex: number;
  category: string;
  totalFen: number;
  receiptIds: string[];
}

interface AttachmentItem {
  receiptId: string;
  rowKey: string;
  category: string;
  merchant: string | null;
  netFen: number;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/**
 * 同屏对账工作区：左侧报销单（可点击报销行 + PDF 预览），右侧凭证附件查看器。
 * 关联基于 receiptId（不依赖数组下标）：点击行定位该行第一张凭证，
 * 手动切换附件时按反查结果高亮所属行。宽屏左右双栏、窄屏上下分区（样式负责）。
 */
export function ReconcileWorkspace({ batch, previewUrl }: { batch: Batch; previewUrl: string }): React.JSX.Element {
  const rows = useMemo<ReconcileRow[]>(() => {
    const uploadOrder = new Map(batch.items.map((item, index) => [item.receiptId, item.uploadOrder ?? index]));
    return batch.sheets.flatMap((sheet, sheetIndex) =>
      sheet.groups.map((group) => ({
        key: `${sheet.id}:${group.category}`,
        sheetIndex,
        category: group.category,
        totalFen: group.totalFen,
        receiptIds: group.receiptIds
          .filter((receiptId) => uploadOrder.has(receiptId))
          .sort((left, right) => (uploadOrder.get(left) ?? 0) - (uploadOrder.get(right) ?? 0)),
      })),
    );
  }, [batch]);

  const attachments = useMemo<AttachmentItem[]>(() => {
    const itemById = new Map(batch.items.map((item) => [item.receiptId, item]));
    return rows.flatMap((row) =>
      row.receiptIds.flatMap((receiptId) => {
        const item = itemById.get(receiptId);
        if (item === undefined) return [];
        return [{
          receiptId,
          rowKey: row.key,
          category: row.category,
          merchant: item.merchant ?? null,
          netFen: item.netFen,
        }];
      }),
    );
  }, [batch, rows]);

  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [failedReceiptId, setFailedReceiptId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const formRef = useRef<HTMLElement>(null);

  const current = attachments.find((item) => item.receiptId === selectedReceiptId) ?? attachments[0] ?? null;
  const currentIndex = current === null ? -1 : attachments.indexOf(current);
  const imageFailed = current !== null && failedReceiptId === current.receiptId;

  // 切换附件时，左侧报销单跟随滚动到该凭证所属的报销页（多页报销单上下分屏时保持单据可见）。
  useEffect(() => {
    if (current === null) return;
    const row = rows.find((item) => item.key === current.rowKey);
    if (row === undefined) return;
    const canvas = formRef.current?.querySelector(`canvas[data-page-number="${row.sheetIndex + 1}"]`);
    (canvas as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, rows]);

  function select(receiptId: string): void {
    setSelectedReceiptId(receiptId);
    setFailedReceiptId(null);
  }

  return (
    <div className="reconcile">
      <section className="reconcile-form" aria-label="报销单" ref={formRef}>
        <ul className="reconcile-rows" aria-label="报销行">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                aria-current={current !== null && current.rowKey === row.key}
                onClick={() => {
                  const first = row.receiptIds[0];
                  if (first !== undefined) select(first);
                }}
              >
                {rows.some((item) => item.sheetIndex !== row.sheetIndex) ? `第 ${row.sheetIndex + 1} 页 · ` : ''}
                {row.category}：合计 {formatFen(row.totalFen)}（{row.receiptIds.length} 张凭证）
              </button>
            </li>
          ))}
        </ul>
        <PdfPreview url={previewUrl} />
      </section>
      <section className="reconcile-side" aria-label="凭证附件">
        {current === null ? (
          <p>本批次没有关联凭证。</p>
        ) : (
          <div className="attachment-viewer">
            <p className="attachment-title">
              第 {currentIndex + 1} / {attachments.length} 张 · {current.category} ·{' '}
              {current.merchant ?? '未识别商家'} · 实付 {formatFen(current.netFen)}
            </p>
            <div className="attachment-toolbar">
              <button
                type="button"
                disabled={currentIndex <= 0}
                onClick={() => select(attachments[currentIndex - 1]!.receiptId)}
              >
                上一张
              </button>
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
              {imageFailed ? (
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
              ) : (
                <img
                  key={`${current.receiptId}:${retryCount}`}
                  src={api.receiptOriginalUrl(current.receiptId)}
                  alt={`凭证 ${currentIndex + 1}：${current.category} ${current.merchant ?? ''}`}
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
