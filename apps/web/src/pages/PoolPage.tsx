import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, formatFen, netFen, type Receipt, type Settings, type Totals } from '@auto-reimbursement/contracts';
import { api, formOptionsFromSettings } from '../api';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptEditor } from '../components/ReceiptEditor';

function eligible(receipt: Receipt): boolean {
  return receipt.status === 'ready' && receipt.category !== null && receipt.paidFen !== null && netFen(receipt) > 0;
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
      setMessage(`已恢复 ${row.merchant ?? row.id}`);
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
      <button type="button" disabled={busy || settings === null} onClick={() => void create()}>生成报销单</button>
      <button type="button" onClick={() => void toggleBin()}>查看已移出 / 回收站</button>
      {message && <p role="status">{message}</p>}
      {binOpen && <section className="pool-bin" aria-label="已移出与回收站">
        <h3>已移出 / 回收站</h3>
        {binRows.length === 0 && <p>没有已移出或已删除的凭证。</p>}
        {binRows.map((row) => <ReceiptCard key={row.id} receipt={row}>
          <button type="button" onClick={() => void restore(row)}>恢复凭证</button>
        </ReceiptCard>)}
      </section>}
      <div className="receipt-list">
        {rows.map((receipt) => {
          const selectable = eligibleIds.has(receipt.id);
          return <ReceiptCard key={receipt.id} receipt={receipt}>
            <label className="receipt-select">
              <input
                type="checkbox"
                aria-label={`选择 ${receipt.merchant ?? receipt.id}`}
                checked={selected.includes(receipt.id)}
                disabled={!selectable || busy}
                onChange={(event) => toggle(receipt.id, event.target.checked)}
              />
              加入本次报销
            </label>
            <ReceiptEditor receipt={receipt} onSaved={replace} />
            <button type="button" disabled={busy} onClick={() => void removeFromPool(receipt.id)}>移出本次报销池</button>
          </ReceiptCard>;
        })}
      </div>
    </main>
  );
}
