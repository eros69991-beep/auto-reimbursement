import { useState } from 'react';
import { CATEGORIES, formatFen, parseFen, type Category, type Receipt } from '@auto-reimbursement/contracts';
import { api, type ReceiptPatch } from '../api';

type EditorProps = { receipt: Receipt; onSaved: (receipt: Receipt) => void };

export function ReceiptEditor({ receipt, onSaved }: EditorProps): React.JSX.Element {
  const [amount, setAmount] = useState(receipt.paidFen === null ? '' : formatFen(receipt.paidFen));
  const [category, setCategory] = useState<Category | ''>(receipt.category ?? '');
  const [merchant, setMerchant] = useState(receipt.merchant ?? '');
  const [date, setDate] = useState(receipt.date ?? '');
  const [refund, setRefund] = useState(formatFen(receipt.refundFen));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 学习规则与 AI 冲突时的建议分类：分类保持 AI 的判断，这里给一键改用
  const suggestion = receipt.ruleMatch?.mode === 'suggested' ? receipt.ruleMatch : null;

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
    if (paidFen < receipt.refundFen) {
      setError(`实付金额不能小于已登记的退款 ${formatFen(receipt.refundFen)}，请先调整退款`);
      return;
    }
    // P-11：商户（打印在报销单摘要栏）与日期（参与查重）可随确认一起修正。
    // 两者选填：AI 没识别出来时不强迫用户编造（编造的商户会进学习规则、印到摘要栏）；留空则保持原值。
    const trimmedMerchant = merchant.trim();
    if (trimmedMerchant.length > 50) {
      setError('商户名称不能超过 50 字');
      return;
    }
    const patch: ReceiptPatch = { paidFen, category };
    if (trimmedMerchant !== '') patch.merchant = trimmedMerchant;
    if (date !== '') patch.date = date;
    setBusy(true);
    setError(null);
    // P-10：修改 + 确认一次原子请求；失败时凭证保持原状态，仍可见可重试
    try {
      onSaved(await api.confirmReceipt(receipt.id, patch));
    } catch (reason) {
      setError(`确认可报销失败：${message(reason)}`);
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
      <label>商户（选填）<input aria-label="商户" maxLength={50} value={merchant} disabled={busy} onChange={(event) => setMerchant(event.target.value)} /></label>
      <label>日期（选填）<input aria-label="日期" type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} /></label>
      <label>最终实付金额<input aria-label="最终实付金额" inputMode="decimal" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>分类<select aria-label="分类" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as Category | '')}>
        <option value="">请选择分类</option>
        {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {suggestion !== null && category !== suggestion.category && (
        <p className="rule-note">
          历史规则「{suggestion.key}」建议归「{suggestion.category}」{' '}
          <button type="button" disabled={busy} onClick={() => setCategory(suggestion.category)}>
            改用规则分类：{suggestion.category}
          </button>
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void confirm()}>确认可报销</button>
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
