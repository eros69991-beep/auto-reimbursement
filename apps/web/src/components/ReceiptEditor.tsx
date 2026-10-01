import { useId, useState } from 'react';
import { CATEGORIES, formatFen, netFenOrNull, parseFen, type Category, type Receipt } from '@auto-reimbursement/contracts';
import { api, type ReceiptPatch } from '../api';

type EditorProps = { receipt: Receipt; onSaved: (receipt: Receipt) => void };

// 金额框显示「实际花的钱」。旧数据里登记过退款的凭证，这里是扣掉退款后的数；数据异常（退款大于实付）时留空让用户重填
function initialAmount(receipt: Receipt): string {
  if (receipt.paidFen === null) return '';
  const net = netFenOrNull(receipt);
  return net === null ? '' : formatFen(net);
}

export function ReceiptEditor({ receipt, onSaved }: EditorProps): React.JSX.Element {
  const [amount, setAmount] = useState(initialAmount(receipt));
  const [category, setCategory] = useState<Category | ''>(receipt.category ?? '');
  const [date, setDate] = useState(receipt.date ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountHintId = useId();
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
    let spentFen: number;
    try {
      spentFen = parseFen(amount);
    } catch {
      setError('请输入正确的金额');
      return;
    }
    // 旧数据里已登记退款的凭证：框里的是扣掉退款后的数，后台存的「实付」要把退款加回去，
    // 这样退款登记不用动、净额恰好等于框里的数（不会重复扣一次，也不会触发「实付小于退款」）。
    const paidFen = spentFen + receipt.refundFen;
    try {
      formatFen(paidFen); // 超出可记录的最大金额时抛异常
    } catch {
      setError('金额过大，请检查');
      return;
    }
    // 日期选填（参与查重）：AI 没识别出来时不强迫用户编造，留空则保持原值。
    // 商户不再让用户填：AI 仍会识别它用来套分类规则和查重，但填错的商户反而会误导规则。
    const patch: ReceiptPatch = { paidFen, category };
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
      <label>日期（选填）<input aria-label="日期" type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} /></label>
      <label>最终实付金额
        <input aria-label="最终实付金额" aria-describedby={amountHintId} inputMode="decimal" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} />
        <small id={amountHintId} className="field-hint">有退款的，填扣掉退款后实际花的钱</small>
      </label>
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
      <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>删除凭证</button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
