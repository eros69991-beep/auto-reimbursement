import { formatFen, STATUS_LABELS, type Receipt } from '@auto-reimbursement/contracts';
import { api } from '../api';
import { receiptLabel } from '../receiptLabel';
import { AuthedImage } from './AuthedImage';

export function ReceiptCard({ receipt, children }: { receipt: Receipt; children?: React.ReactNode }): React.JSX.Element {
  // 标题是「分类 · 金额」（金额已扣掉旧数据里登记的退款），不再显示商户名和内部编号
  const label = receiptLabel(receipt);
  const imagePath = `/api/images/${encodeURIComponent(receipt.original.id)}`;
  // P-13：列表只加载 320px WebP 缩略图，点击查看原图时才取全尺寸
  const thumbPath = `${imagePath}?size=thumb`;

  return (
    <article className="receipt-card">
      <a
        className="receipt-thumbnail"
        href={api.imageUrl(receipt.original.id)}
        aria-label={`查看原图 ${label}`}
        onClick={(event) => {
          event.preventDefault();
          void api.openAuthed(imagePath);
        }}
      >
        <AuthedImage path={thumbPath} alt={`${label} 原始凭证缩略图`} />
      </a>
      <div className="receipt-card-body">
        <div className="receipt-card-heading">
          <h3>{label}</h3>
          <span className="status-badge">{STATUS_LABELS[receipt.status]}</span>
        </div>
        <p>{receipt.date ?? '日期待确认'}</p>
        {/* 退款入口已去掉；这里只给旧数据里已登记过退款的凭证说明上面的金额是怎么来的 */}
        {receipt.refundFen > 0 && <p className="refund-note">已扣除退款 {formatFen(receipt.refundFen)}</p>}
        {receipt.ruleMatch?.mode === 'applied' && receipt.ruleMatch.category === receipt.category && (
          <p className="rule-note">按固定规则「{receipt.ruleMatch.key}」归类</p>
        )}
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
