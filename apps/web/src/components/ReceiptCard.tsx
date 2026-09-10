import { formatFen, netFen, STATUS_LABELS, type Receipt } from '@auto-reimbursement/contracts';
import { api } from '../api';

export function ReceiptCard({ receipt, children }: { receipt: Receipt; children?: React.ReactNode }): React.JSX.Element {
  const originalAmount = receipt.paidFen === null ? '待确认' : formatFen(receipt.paidFen);
  const netAmount = receipt.paidFen === null ? '待确认' : formatFen(netFen(receipt));

  return (
    <article className="receipt-card">
      <a className="receipt-thumbnail" href={api.imageUrl(receipt.original.id)} aria-label={`查看原图 ${receipt.id}`}>
        <img src={api.imageUrl(receipt.original.id)} alt={`${receipt.merchant ?? receipt.id} 原始凭证缩略图`} />
      </a>
      <div className="receipt-card-body">
        <div className="receipt-card-heading">
          <h3>{receipt.merchant ?? receipt.id}</h3>
          <span className="status-badge">{STATUS_LABELS[receipt.status]}</span>
        </div>
        <p>{receipt.date ?? '日期待确认'} · {receipt.category ?? '分类待确认'}</p>
        <dl className="receipt-amounts">
          <div aria-label={`原金额：${originalAmount}`}><dt>原金额：</dt><dd>{originalAmount}</dd></div>
          <div aria-label={`已退款：${formatFen(receipt.refundFen)}`}><dt>已退款：</dt><dd>{formatFen(receipt.refundFen)}</dd></div>
          <div aria-label={`净额：${netAmount}`}><dt>净额：</dt><dd>{netAmount}</dd></div>
        </dl>
        <details>
          <summary>查看识别详情</summary>
          {receipt.analysis === null ? <p>暂无识别结果</p> : (
            <dl className="analysis-details">
              <div><dt>原始分析</dt><dd>{receipt.analysis.evidence}</dd></div>
              <div><dt>金额置信度</dt><dd>{receipt.analysis.confidence.amount}</dd></div>
              <div><dt>分类置信度</dt><dd>{receipt.analysis.confidence.category}</dd></div>
            </dl>
          )}
        </details>
        {children}
      </div>
    </article>
  );
}
