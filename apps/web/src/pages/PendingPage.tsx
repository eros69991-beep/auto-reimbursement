import { useEffect, useState } from 'react';
import type { Reason, Receipt } from '@auto-reimbursement/contracts';
import { api } from '../api';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptEditor } from '../components/ReceiptEditor';

const labels: Record<Reason, string> = {
  amount_uncertain: '金额无法确定',
  category_uncertain: '分类低置信度',
  api_failed: 'API 最终失败',
  suspected_duplicate: '疑似重复',
  ambiguous_amount: '存在多个支付金额',
  unreadable: '图片无法读取',
  rule_conflict: '历史规则冲突',
};

export function PendingPage(): React.JSX.Element {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.receipts('pending').then(
      (received) => setRows(received.filter((receipt) => receipt.status === 'pending' && receipt.pendingReasons.length > 0)),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : '获取待处理凭证失败'),
    );
  }, []);

  function replaceOrRemove(updated: Receipt): void {
    setRows((current) => updated.deletedAt === null && updated.status === 'pending' && updated.pendingReasons.length > 0
      ? current.map((receipt) => receipt.id === updated.id ? updated : receipt)
      : current.filter((receipt) => receipt.id !== updated.id));
  }

  async function confirmDistinct(id: string): Promise<void> {
    setError(null);
    try {
      replaceOrRemove(await api.confirmDistinct(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求失败');
    }
  }

  async function retry(id: string): Promise<void> {
    setError(null);
    try {
      replaceOrRemove(await api.retryReceipt(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求失败');
    }
  }

  return (
    <main className="page-content">
      <h2>异常处理</h2>
      {error && <p role="alert">{error}</p>}
      {rows.length === 0 ? <p>暂无待处理凭证</p> : <div className="receipt-list">
        {rows.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt}>
          <ul className="reason-list" aria-label="待处理原因">{receipt.pendingReasons.map((reason) => <li key={reason}>{labels[reason]}</li>)}</ul>
          {receipt.pendingReasons.includes('suspected_duplicate') && <>
            {receipt.duplicateIds.map((id) => <a key={id} href={api.imageUrl(id)}>查看历史凭证</a>)}
            <button type="button" onClick={() => void confirmDistinct(receipt.id)}>确认不是重复，继续加入</button>
          </>}
          {receipt.pendingReasons.includes('api_failed') && <button type="button" onClick={() => void retry(receipt.id)}>重试识别</button>}
          <ReceiptEditor receipt={receipt} onSaved={replaceOrRemove} />
        </ReceiptCard>)}
      </div>}
    </main>
  );
}
