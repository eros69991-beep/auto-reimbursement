import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canMergeReceipt,
  MERGE_MAX,
  MERGE_MIN,
  suggestMerges,
  type MergeSuggestion,
  type Reason,
  type Receipt,
} from '@auto-reimbursement/contracts';
import { api } from '../api';
import { friendlyError } from '../errors';
import { AuthedImage } from '../components/AuthedImage';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptEditor } from '../components/ReceiptEditor';
import { receiptLabel } from '../receiptLabel';
import { useRecognitionWatch } from '../useRecognitionWatch';

const labels: Record<Reason, string> = {
  amount_uncertain: '金额无法确定',
  category_uncertain: '分类低置信度',
  api_failed: 'API 最终失败',
  suspected_duplicate: '疑似重复',
  ambiguous_amount: '存在多个支付金额',
  unreadable: '图片无法读取',
  rule_conflict: '分类规则冲突',
  incomplete_screenshot: '截图不完整：可能只是同一单的一部分，可以和相邻的截图合并',
  lines_mismatch: '各项金额加起来和合计对不上，请核对每一项',
};

const basisLabels: Record<MergeSuggestion['basis'][number], string> = {
  orderNo: '订单号相同',
  merchant: '商户相同',
  date: '日期相同',
};

// 学习规则与 AI 判断不一致时，把两边说清楚，编辑框里可一键改用规则的分类
function reasonLabel(receipt: Receipt, reason: Reason): string {
  if (reason === 'rule_conflict' && receipt.ruleMatch?.mode === 'suggested') {
    return `历史规则冲突：「${receipt.ruleMatch.key}」以前都归「${receipt.ruleMatch.category}」，这次 AI 判断为「${receipt.category ?? '未识别'}」`;
  }
  return labels[reason];
}

function suggestionKey(suggestion: MergeSuggestion): string {
  return suggestion.receiptIds.join('+');
}

export function PendingPage(): React.JSX.Element {
  const [rows, setRows] = useState<Receipt[]>([]);
  // 报销池里的凭证只用来和待处理的比对「疑似同一单」
  const [pool, setPool] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const mergedId = useRef<string | null>(null);

  const load = useCallback(async (): Promise<Receipt[]> => {
    const [pending, ready] = await Promise.all([
      api.receipts('pending'),
      // 取不到报销池只是少了「疑似同一单」的提示，不算错
      api.receipts('pool').catch(() => [] as Receipt[]),
    ]);
    // P-10：显示所有 pending；reasons 为空的（旧版两步确认留下的）标记为「修改待确认」
    const waiting = pending.filter((receipt) => receipt.status === 'pending');
    setRows(waiting);
    setPool(ready);
    setSelected((current) => current.filter((id) => waiting.some((receipt) => receipt.id === id)));
    return waiting;
  }, []);

  useEffect(() => {
    void load().catch(
      (reason: unknown) => setError(reason instanceof Error ? reason.message : '获取待处理凭证失败'),
    );
  }, [load]);

  const { watching, watch } = useRecognitionWatch((outcome, reason) => {
    void (async () => {
      try {
        const waiting = await load();
        if (outcome === 'error') {
          setError(friendlyError(reason, '获取识别进度失败'));
        } else if (outcome === 'timeout') {
          setNotice('合并后的凭证还在识别中，稍后刷新本页就能看到结果。');
        } else {
          setNotice(waiting.some((receipt) => receipt.id === mergedId.current)
            ? '合并完成，重新识别后这张还需要你确认，见下面的卡片。'
            : '合并完成，重新识别通过，已进入报销池。');
        }
      } catch (loadReason) {
        setError(friendlyError(loadReason, '获取待处理凭证失败'));
      }
    })();
  });
  const busy = mergeBusy || watching;

  function replaceOrRemove(updated: Receipt): void {
    setRows((current) => updated.deletedAt === null && updated.status === 'pending'
      ? current.map((receipt) => receipt.id === updated.id ? updated : receipt)
      : current.filter((receipt) => receipt.id !== updated.id));
    if (updated.deletedAt !== null || updated.status !== 'pending') {
      setSelected((current) => current.filter((id) => id !== updated.id));
    }
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

  // 同一单被截成几张图：服务器把它们左右拼成一张，作为新凭证重新识别
  async function merge(ids: string[]): Promise<void> {
    setError(null);
    setNotice(null);
    setMergeBusy(true);
    try {
      const merged = await api.mergeReceipts(ids);
      mergedId.current = merged.id;
      setRows((current) => current.filter((receipt) => !ids.includes(receipt.id)));
      setPool((current) => current.filter((receipt) => !ids.includes(receipt.id)));
      setSelected([]);
      setNotice('已合并，正在重新识别拼好的图…');
      watch([merged.id]);
    } catch (reason) {
      setError(friendlyError(reason, '合并失败'));
      // 失败多半是凭证状态已经变了（还在识别、已删除…），刷新一下列表
      void load().catch(() => undefined);
    } finally {
      setMergeBusy(false);
    }
  }

  async function split(receipt: Receipt): Promise<void> {
    if (!window.confirm('拆开后，这张合并凭证的识别结果和修改会丢掉，截图恢复成合并前的几张。确定拆开吗？')) return;
    setError(null);
    setNotice(null);
    setMergeBusy(true);
    try {
      const restored = await api.splitReceipt(receipt.id);
      await load();
      setNotice(`已拆开，恢复成 ${restored.length} 张截图。`);
    } catch (reason) {
      setError(friendlyError(reason, '拆开失败'));
    } finally {
      setMergeBusy(false);
    }
  }

  function toggle(id: string, checked: boolean): void {
    setSelected((current) => checked ? [...current, id] : current.filter((selectedId) => selectedId !== id));
  }

  const rowIds = useMemo(() => new Set(rows.map((receipt) => receipt.id)), [rows]);
  const byId = useMemo(
    () => new Map([...pool, ...rows].map((receipt) => [receipt.id, receipt])),
    [pool, rows],
  );
  // 至少有一张在本页的才提示（两张都在报销池里的，在报销池页处理）
  const suggestions = useMemo(
    () => suggestMerges([...rows, ...pool]).filter((suggestion) =>
      !dismissed.includes(suggestionKey(suggestion)) && suggestion.receiptIds.some((id) => rowIds.has(id))),
    [rows, pool, dismissed, rowIds],
  );
  const mergeableCount = rows.filter(canMergeReceipt).length;
  // 按列表里的顺序（也就是上传顺序）合并：同一单的截图从上到下，拼出来就是从左到右
  const selectedInOrder = rows.filter((receipt) => selected.includes(receipt.id)).map((receipt) => receipt.id);

  return (
    <main className="page-content">
      <h2>异常处理</h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {suggestions.length > 0 && (
        <section className="merge-suggestions" aria-label="疑似同一单">
          <h3>这几张可能是同一单</h3>
          <p className="field-hint">同一单被截成几张时，合并后会左右拼成一张图重新识别；合并错了可以「拆开」。</p>
          <ul>
            {suggestions.map((suggestion) => {
              const members = suggestion.receiptIds.map((id) => byId.get(id)!);
              return (
                <li key={suggestionKey(suggestion)} className="merge-suggestion">
                  <div className="merge-suggestion-images">
                    {members.map((member, index) => (
                      <a
                        key={member.id}
                        className="receipt-thumbnail"
                        href={api.imageUrl(member.original.id)}
                        aria-label={`查看第 ${index + 1} 张截图`}
                        onClick={(event) => {
                          event.preventDefault();
                          void api.openAuthed(`/api/images/${encodeURIComponent(member.original.id)}`);
                        }}
                      >
                        <AuthedImage
                          path={`/api/images/${encodeURIComponent(member.original.id)}?size=thumb`}
                          alt={`第 ${index + 1} 张截图缩略图`}
                        />
                      </a>
                    ))}
                  </div>
                  <div className="merge-suggestion-body">
                    <p>
                      {members.map(receiptLabel).join(' ＋ ')}
                      <small>（{suggestion.basis.map((item) => basisLabels[item]).join('、')}）</small>
                    </p>
                    <div className="receipt-actions">
                      <button type="button" disabled={busy} onClick={() => void merge(suggestion.receiptIds)}>
                        合并这 {members.length} 张
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDismissed((current) => [...current, suggestionKey(suggestion)])}
                      >
                        不是同一单
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {apiFailedCount > 1 && (
        <button type="button" disabled={retryAllBusy} onClick={() => void retryAll()}>
          {retryAllBusy ? '正在全部重试…' : `全部重试识别（${apiFailedCount} 张）`}
        </button>
      )}
      {mergeableCount >= MERGE_MIN && (
        <p className="field-hint">同一单被截成几张？勾选这几张（最多 {MERGE_MAX} 张），点「合并为一单」，会左右拼成一张重新识别。</p>
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
          {mergeableCount >= MERGE_MIN && canMergeReceipt(receipt) && (
            <label className="receipt-select">
              <input
                type="checkbox"
                aria-label={`选择合并 ${receiptLabel(receipt)}`}
                checked={selected.includes(receipt.id)}
                disabled={busy || (!selected.includes(receipt.id) && selected.length >= MERGE_MAX)}
                onChange={(event) => toggle(receipt.id, event.target.checked)}
              />
              选来合并（同一单的几张截图）
            </label>
          )}
          {receipt.mergedFrom !== undefined && (
            <div className="receipt-actions">
              <button type="button" disabled={busy} onClick={() => void split(receipt)}>拆开</button>
            </div>
          )}
          <ReceiptEditor receipt={receipt} onSaved={replaceOrRemove} />
        </ReceiptCard>)}
      </div>}
      {selected.length > 0 && (
        <div className="pool-selection-bar merge-bar" aria-label="合并所选">
          <span>
            已选 {selected.length} 张{selected.length < MERGE_MIN ? `，再选 ${MERGE_MIN - selected.length}–${MERGE_MAX - selected.length} 张同一单的截图` : ''}
          </span>
          <span className="receipt-actions">
            <button
              type="button"
              disabled={busy || selected.length < MERGE_MIN || selected.length > MERGE_MAX}
              onClick={() => void merge(selectedInOrder)}
            >
              合并为一单
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected([])}>取消选择</button>
          </span>
        </div>
      )}
    </main>
  );
}
