import { useEffect, useState } from 'react';
import type { Reason, Receipt } from '@auto-reimbursement/contracts';
import { api } from '../api';
import { friendlyError } from '../errors';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptEditor } from '../components/ReceiptEditor';

const labels: Record<Reason, string> = {
  amount_uncertain: '金额无法确定',
  category_uncertain: '分类低置信度',
  api_failed: 'API 最终失败',
  suspected_duplicate: '疑似重复',
  ambiguous_amount: '存在多个支付金额',
  unreadable: '图片无法读取',
  rule_conflict: '分类规则冲突',
};

// 学习规则与 AI 判断不一致时，把两边说清楚，编辑框里可一键改用规则的分类
function reasonLabel(receipt: Receipt, reason: Reason): string {
  if (reason === 'rule_conflict' && receipt.ruleMatch?.mode === 'suggested') {
    return `历史规则冲突：「${receipt.ruleMatch.key}」以前都归「${receipt.ruleMatch.category}」，这次 AI 判断为「${receipt.category ?? '未识别'}」`;
  }
  return labels[reason];
}

export function PendingPage(): React.JSX.Element {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // P-10：显示所有 pending；reasons 为空的（旧版两步确认留下的）标记为「修改待确认」
    void api.receipts('pending').then(
      (received) => setRows(received.filter((receipt) => receipt.status === 'pending')),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : '获取待处理凭证失败'),
    );
  }, []);

  function replaceOrRemove(updated: Receipt): void {
    setRows((current) => updated.deletedAt === null && updated.status === 'pending'
      ? current.map((receipt) => receipt.id === updated.id ? updated : receipt)
      : current.filter((receipt) => receipt.id !== updated.id));
  }

  async function confirmDistinct(id: string): Promise<void> {
    setError(null);
    try {
      replaceOrRemove(await api.confirmDistinct(id));
    } catch (reason) {
      setError(friendlyError(reason, '请求失败'));
    }
  }

  async function retry(id: string): Promise<void> {
    setError(null);
    try {
      replaceOrRemove(await api.retryReceipt(id));
    } catch (reason) {
      setError(friendlyError(reason, '请求失败'));
    }
  }

  // P-25：AI 故障时不用一张张点，全部「API 最终失败」的一键重试
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const apiFailedCount = rows.filter((receipt) => receipt.pendingReasons.includes('api_failed')).length;

  async function retryAll(): Promise<void> {
    setError(null);
    setRetryAllBusy(true);
    try {
      const targets = rows.filter((receipt) => receipt.pendingReasons.includes('api_failed'));
      const results = await Promise.allSettled(targets.map((receipt) => api.retryReceipt(receipt.id)));
      let failed = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          replaceOrRemove(result.value);
        } else {
          failed += 1;
        }
      }
      if (failed > 0) {
        setError(`${failed} 张重试失败，可稍后再次全部重试`);
      }
    } finally {
      setRetryAllBusy(false);
    }
  }

  return (
    <main className="page-content">
      <h2>异常处理</h2>
      {error && <p role="alert">{error}</p>}
      {apiFailedCount > 1 && (
        <button type="button" disabled={retryAllBusy} onClick={() => void retryAll()}>
          {retryAllBusy ? '正在全部重试…' : `全部重试识别（${apiFailedCount} 张）`}
        </button>
      )}
      {rows.length === 0 ? <p>暂无待处理凭证</p> : <div className="receipt-list">
        {rows.map((receipt) => <ReceiptCard key={receipt.id} receipt={receipt}>
          <ul className="reason-list" aria-label="待处理原因">{receipt.pendingReasons.length === 0
            ? <li>修改待确认</li>
            : receipt.pendingReasons.map((reason) => <li key={reason}>{reasonLabel(receipt, reason)}</li>)}</ul>
          {receipt.pendingReasons.includes('suspected_duplicate') && <>
            {receipt.duplicateIds.map((id) => <a key={id} href={api.receiptOriginalUrl(id)} onClick={(event) => { event.preventDefault(); void api.openAuthed(`/api/receipts/${encodeURIComponent(id)}/original-image`); }}>查看历史凭证</a>)}
            <button type="button" onClick={() => void confirmDistinct(receipt.id)}>确认不是重复，继续加入</button>
          </>}
          {receipt.pendingReasons.includes('api_failed') && <button type="button" onClick={() => void retry(receipt.id)}>重试识别</button>}
          <ReceiptEditor receipt={receipt} onSaved={replaceOrRemove} />
        </ReceiptCard>)}
      </div>}
    </main>
  );
}
