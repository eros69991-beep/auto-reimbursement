import { useState } from 'react';
import { CATEGORIES, formatFen, parseFen, type Category, type Receipt } from '@auto-reimbursement/contracts';
import { api } from '../api';

type EditorProps = { receipt: Receipt; onSaved: (receipt: Receipt) => void };

export function ReceiptEditor({ receipt, onSaved }: EditorProps): React.JSX.Element {
  const [amount, setAmount] = useState(receipt.paidFen === null ? '' : formatFen(receipt.paidFen));
  const [category, setCategory] = useState<Category | ''>(receipt.category ?? '');
  const [refund, setRefund] = useState(formatFen(receipt.refundFen));
  const [savedReceipt, setSavedReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function message(reason: unknown): string {
    return reason instanceof Error ? reason.message : '请求失败';
  }

  async function confirm(): Promise<void> {
    if (category === '') {
      setError('请选择分类');
      return;
    }
    let paidFen: number;
    try {
      paidFen = parseFen(amount);
    } catch {
      setError('请输入正确的金额');
      return;
    }
    setBusy(true);
    setError(null);
    let saved = savedReceipt;
    try {
      if (saved === null) {
        saved = await api.updateReceipt(receipt.id, { paidFen, category });
        setSavedReceipt(saved);
        onSaved(saved);
      }
    } catch (reason) {
      setError(`保存修改失败：${message(reason)}`);
      setBusy(false);
      return;
    }

    try {
      const confirmed = await api.confirmReceipt(saved.id);
      setSavedReceipt(null);
      onSaved(confirmed);
    } catch (reason) {
      setError(`修改已保存，但确认可报销失败：${message(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveRefund(): Promise<void> {
    let refundFen: number;
    try {
      refundFen = parseFen(refund);
    } catch {
      setError('请输入正确的退款金额');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setRefund(receipt.id, refundFen));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  function chooseFullRefund(): void {
    if (receipt.paidFen !== null) setRefund(formatFen(receipt.paidFen));
  }

  async function addEvidence(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.addRefundImage(receipt.id, file));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm('确定删除这张凭证吗？')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteReceipt(receipt.id);
      onSaved({ ...receipt, deletedAt: new Date().toISOString() });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="receipt-editor" aria-label="编辑凭证">
      <label>最终实付金额<input aria-label="最终实付金额" inputMode="decimal" value={amount} disabled={busy} onChange={(event) => {
        setAmount(event.target.value);
        setSavedReceipt(null);
      }} /></label>
      <label>分类<select aria-label="分类" value={category} disabled={busy} onChange={(event) => {
        setCategory(event.target.value as Category | '');
        setSavedReceipt(null);
      }}>
        <option value="">请选择分类</option>
        {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => void confirm()}>确认可报销</button>
      {savedReceipt !== null && <p role="status">修改已保存，待确认可报销</p>}
      <div className="refund-editor">
        <label>退款金额<input aria-label="退款金额" inputMode="decimal" value={refund} disabled={busy} onChange={(event) => setRefund(event.target.value)} /></label>
        <button type="button" disabled={busy || receipt.paidFen === null} onClick={chooseFullRefund}>全额退款</button>
        <button type="button" disabled={busy} onClick={() => void saveRefund()}>保存退款</button>
        <label>上传退款凭证<input aria-label="上传退款凭证" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void addEvidence(event.target.files?.[0])} /></label>
      </div>
      <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>删除凭证</button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
