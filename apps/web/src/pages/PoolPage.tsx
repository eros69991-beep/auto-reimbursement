import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, formatFen, netFenOrNull, type Receipt, type Settings, type Totals } from '@auto-reimbursement/contracts';
import { api, formOptionsFromSettings } from '../api';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptEditor } from '../components/ReceiptEditor';
import { receiptLabel } from '../receiptLabel';

function eligible(receipt: Receipt): boolean {
  const net = receipt.paidFen === null ? null : netFenOrNull(receipt);
  return receipt.status === 'ready' && receipt.category !== null && net !== null && net > 0;
}

export function PoolPage({ onBatch }: { onBatch: (id: string) => void }): React.JSX.Element {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [binOpen, setBinOpen] = useState(false);
  const [binRows, setBinRows] = useState<Receipt[]>([]);

  useEffect(() => {
    void Promise.all([api.receipts('pool'), api.totals(), api.settings()]).then(
      ([received, nextTotals, nextSettings]) => {
        setRows(received);
        setTotals(nextTotals);
        setSettings(nextSettings);
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : '获取报销池失败'),
    );
  }, []);

  const eligibleIds = useMemo(() => new Set(rows.filter(eligible).map((receipt) => receipt.id)), [rows]);
  // P-13：底部吸附栏的已选合计（净额求和）
  const selectedTotalFen = useMemo(
    () => rows
      .filter((receipt) => selected.includes(receipt.id))
      .reduce((sum, receipt) => sum + (receipt.paidFen === null ? 0 : (netFenOrNull(receipt) ?? 0)), 0),
    [rows, selected],
  );
  const allEligibleSelected = eligibleIds.size > 0 && [...eligibleIds].every((id) => selected.includes(id));

  function refreshTotals(): void {
    void api.totals().then(
      (nextTotals) => setTotals(nextTotals),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : '刷新报销池汇总失败'),
    );
  }

  function replace(updated: Receipt): void {
    if (updated.deletedAt !== null) {
      setRows((current) => current.filter((receipt) => receipt.id !== updated.id));
      setSelected((current) => current.filter((id) => id !== updated.id));
      refreshTotals();
      return;
    }
    setRows((current) => current.map((receipt) => receipt.id === updated.id ? updated : receipt));
    if (!eligible(updated)) setSelected((current) => current.filter((id) => id !== updated.id));
    refreshTotals();
  }

  function toggle(id: string, checked: boolean): void {
    setSelected((current) => checked ? [...current, id] : current.filter((selectedId) => selectedId !== id));
  }

  // P-13：全选 / 取消全选可报销凭证
  function toggleAll(checked: boolean): void {
    setSelected(checked ? [...eligibleIds] : []);
  }

  async function removeFromPool(id: string): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await api.setPoolMembership(id, false);
      setRows((current) => current.filter((receipt) => receipt.id !== id));
      setSelected((current) => current.filter((selectedId) => selectedId !== id));
      refreshTotals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '移出报销池失败');
    }
  }

  async function toggleBin(): Promise<void> {
    const next = !binOpen;
    setBinOpen(next);
    if (!next) return;
    setError(null);
    try {
      const [excluded, deleted] = await Promise.all([
        api.receipts('excluded'),
        api.receipts('deleted'),
      ]);
      setBinRows([...excluded, ...deleted]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载已移出与回收站失败');
    }
  }

  async function restore(row: Receipt): Promise<void> {
    setError(null);
    try {
      if (row.deletedAt !== null) {
        await api.restoreReceipt(row.id);
      } else {
        await api.setPoolMembership(row.id, true);
      }
      setBinRows((current) => current.filter((receipt) => receipt.id !== row.id));
      setMessage(`已恢复 ${receiptLabel(row)}`);
      // P-31：恢复后立即刷新报销池列表，不能只更新回收站和汇总
      void api.receipts('pool').then(
        (received) => setRows(received),
        (loadReason: unknown) => setError(loadReason instanceof Error ? loadReason.message : '刷新报销池失败'),
      );
      refreshTotals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复凭证失败');
    }
  }

  async function create(): Promise<void> {
    if (selected.length === 0) {
      setError('请选择至少一张可报销凭证');
      return;
    }
    if (settings === null) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await api.createBatch(selected, formOptionsFromSettings(settings, new Date()));
      onBatch(batch.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成报销单失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-content">
      <h2>报销池</h2>
      {error && <p role="alert">{error}</p>}
      {totals !== null && <section className="pool-totals" aria-label="报销池汇总">
        <p>可报销笔数：{totals.count}</p>
        <p>合计：{formatFen(totals.totalFen)}</p>
        <ul>{CATEGORIES.map((category) => <li key={category}>{category}：{formatFen(totals.byCategory[category])}</li>)}</ul>
      </section>}
      <button type="button" onClick={() => void toggleBin()}>查看已移出 / 回收站</button>
      {eligibleIds.size > 0 && <label className="pool-select-all">
        <input
          type="checkbox"
          aria-label="全选可报销"
          checked={allEligibleSelected}
          disabled={busy}
          onChange={(event) => toggleAll(event.target.checked)}
        />
        全选可报销（{eligibleIds.size} 张）
      </label>}
      {message && <p role="status">{message}</p>}
      {binOpen && <section className="pool-bin" aria-label="已移出与回收站">
        <h3>已移出 / 回收站</h3>
        {binRows.length === 0 && <p>没有已移出或已删除的凭证。</p>}
        {binRows.map((row) => <ReceiptCard key={row.id} receipt={row}>
          <button type="button" onClick={() => void restore(row)}>恢复凭证</button>
        </ReceiptCard>)}
      </section>}
      {/* P-26：空状态引导，告诉新手第一步该做什么 */}
      {rows.length === 0 && error === null && (
        <p role="status">本期报销池还是空的。先去<a href="#upload">上传凭证</a>，识别通过后凭证会出现在这里。</p>
      )}
      <div className="receipt-list">
        {rows.map((receipt) => {
          const selectable = eligibleIds.has(receipt.id);
          return <PoolRow
            key={receipt.id}
            receipt={receipt}
            selectable={selectable}
            checked={selected.includes(receipt.id)}
            busy={busy}
            onToggle={toggle}
            onSaved={replace}
            onRemove={removeFromPool}
          />;
        })}
      </div>
      <div className="pool-selection-bar" aria-label="已选汇总">
        <span>已选 {selected.length} 张 · 合计 {formatFen(selectedTotalFen)}</span>
        <button type="button" disabled={busy || settings === null} onClick={() => void create()}>生成报销单</button>
      </div>
    </main>
  );
}

// P-13：编辑器默认收起，点「编辑」才展开，保持列表紧凑
function PoolRow({
  receipt,
  selectable,
  checked,
  busy,
  onToggle,
  onSaved,
  onRemove,
}: {
  receipt: Receipt;
  selectable: boolean;
  checked: boolean;
  busy: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSaved: (receipt: Receipt) => void;
  onRemove: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [editorOpen, setEditorOpen] = useState(false);
  return <ReceiptCard receipt={receipt}>
    <label className="receipt-select">
      <input
        type="checkbox"
        aria-label={`选择 ${receiptLabel(receipt)}`}
        checked={checked}
        disabled={!selectable || busy}
        onChange={(event) => onToggle(receipt.id, event.target.checked)}
      />
      加入本次报销
    </label>
    <div className="receipt-actions">
      <button type="button" aria-expanded={editorOpen} onClick={() => setEditorOpen((open) => !open)}>
        {editorOpen ? '收起编辑' : '编辑'}
      </button>
      <button type="button" disabled={busy} onClick={() => void onRemove(receipt.id)}>移出本次报销池</button>
    </div>
    {editorOpen && <ReceiptEditor receipt={receipt} onSaved={onSaved} />}
  </ReceiptCard>;
}
