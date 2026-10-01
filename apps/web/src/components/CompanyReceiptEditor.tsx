import { useId, useRef, useState } from 'react';
import { COMPANY_CATEGORIES, formatFen, netFenOrNull, type Category, type Receipt } from '@auto-reimbursement/contracts';
import { api, type ReceiptPatch } from '../api';
import { MAX_LINES, buildLines, draftsFromLines, parseAmountInput, parsePeriodInput, readPayee, sumLinesFen, type LineDraft } from '../companyEditing';

type EditorProps = { receipt: Receipt; onSaved: (receipt: Receipt) => void };

function initialAmount(receipt: Receipt): string {
  if (receipt.paidFen === null) return '';
  const net = netFenOrNull(receipt);
  return net === null ? '' : formatFen(net);
}

/**
 * 公账区的凭证编辑框（回单、收费通知单）。
 * 单项：金额、分类、费用月份；一张收费通知单有好几项费用时「拆成多项」，每项一个分类、月份和金额，合计自动算出。
 * 收款方（户名、开户银行、银行账号）三项都能改，AI 读错一位的账号就在这里改；它们会写进付款单的备注栏。
 */
export function CompanyReceiptEditor({ receipt, onSaved }: EditorProps): React.JSX.Element {
  const [mode, setMode] = useState<'single' | 'lines'>(receipt.lines === undefined ? 'single' : 'lines');
  const [lines, setLines] = useState<LineDraft[]>(() => draftsFromLines(receipt.lines));
  // 新加的行从已有的行数往后编号，只在点按钮时取号
  const nextLineId = useRef(lines.length);
  const [amount, setAmount] = useState(initialAmount(receipt));
  const [category, setCategory] = useState<Category | ''>(receipt.category ?? '');
  const [period, setPeriod] = useState(receipt.period ?? '');
  const [date, setDate] = useState(receipt.date ?? '');
  const [payeeName, setPayeeName] = useState(receipt.payee?.name ?? '');
  const [payeeBank, setPayeeBank] = useState(receipt.payee?.bank ?? '');
  const [payeeAccount, setPayeeAccount] = useState(receipt.payee?.account ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const periodHintId = useId();
  const accountHintId = useId();
  // 学习规则与 AI 冲突时的建议分类：分类保持 AI 的判断，这里给一键改用（只对单项凭证）
  const suggestion = receipt.ruleMatch?.mode === 'suggested' ? receipt.ruleMatch : null;

  const linesTotal = sumLinesFen(lines);
  const recognizedTotal = receipt.recognizedFen;

  function message(reason: unknown): string {
    return reason instanceof Error ? reason.message : '请求失败';
  }

  function newLine(values: Partial<Omit<LineDraft, 'id'>> = {}): LineDraft {
    return { id: nextLineId.current++, category: '', period: '', amount: '', ...values };
  }

  function updateLine(id: number, change: Partial<Omit<LineDraft, 'id'>>): void {
    setLines((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }

  function addLine(): void {
    const added = newLine();
    setLines((current) => [...current, added]);
  }

  // 单项 → 多项：当前这一项作为第一行，再给一个空行
  function splitIntoLines(): void {
    setError(null);
    setLines([newLine({ category, period, amount }), newLine()]);
    setMode('lines');
  }

  // 多项 → 单项：分类、月份取第一行，金额取各项合计
  function mergeIntoOne(): void {
    setError(null);
    const first = lines[0];
    setCategory(first?.category ?? '');
    setPeriod(first?.period ?? '');
    setAmount(linesTotal > 0 ? formatFen(linesTotal) : '');
    setMode('single');
  }

  async function confirm(): Promise<void> {
    const patch: ReceiptPatch = {};
    if (mode === 'lines') {
      const built = buildLines(lines);
      if ('error' in built) {
        setError(built.error);
        return;
      }
      // 金额由各项之和决定，分类取第一项，月份都在各项里，这里一概不另给
      patch.lines = built.lines;
    } else {
      if (category === '') {
        setError('请选择分类');
        return;
      }
      const paidFen = parseAmountInput(amount);
      if (paidFen === null) {
        setError('请输入正确的金额');
        return;
      }
      const normalized = parsePeriodInput(period);
      if (normalized === 'invalid') {
        setError('费用月份请写成 2026-07 这样');
        return;
      }
      patch.paidFen = paidFen;
      patch.category = category;
      patch.period = normalized;
      // 原来是拆成多项的，现在合回一项：明确告诉后台去掉明细
      if (receipt.lines !== undefined) patch.lines = null;
    }
    const payee = readPayee({ name: payeeName, bank: payeeBank, account: payeeAccount });
    if ('error' in payee) {
      setError(payee.error);
      return;
    }
    // 日期选填（参与查重）：没识别出来时不强迫用户编造，留空则保持原值
    if (date !== '') patch.date = date;
    patch.payee = payee.payee;
    setBusy(true);
    setError(null);
    // 修改 + 确认一次原子请求；失败时回单保持原状态，仍可见可重试
    try {
      onSaved(await api.confirmReceipt(receipt.id, patch));
    } catch (reason) {
      setError(`确认可付款失败：${message(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm('确定删除这张回单吗？')) return;
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
    <section className="receipt-editor company-editor" aria-label="编辑回单">
      <label>日期（选填）<input aria-label="日期" type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} /></label>
      {mode === 'single' ? (
        <>
          <label>付款金额
            <input aria-label="付款金额" inputMode="decimal" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <label>分类<select aria-label="分类" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as Category | '')}>
            <option value="">请选择分类</option>
            {COMPANY_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          {suggestion !== null && category !== suggestion.category && (
            <p className="rule-note">
              历史规则「{suggestion.key}」建议归「{suggestion.category}」{' '}
              <button type="button" disabled={busy} onClick={() => setCategory(suggestion.category)}>
                改用规则分类：{suggestion.category}
              </button>
            </p>
          )}
          <label>费用月份（选填）
            <input aria-label="费用月份" aria-describedby={periodHintId} type="month" placeholder="例如 2026-07" value={period} disabled={busy} onChange={(event) => setPeriod(event.target.value)} />
            <small id={periodHintId} className="field-hint">这笔钱是哪个月的费用，会写在付款单的项目名里，例如「电费（2026年7月）」</small>
          </label>
          <button type="button" disabled={busy} onClick={splitIntoLines}>拆成多项（一张通知单有好几项费用）</button>
        </>
      ) : (
        <fieldset className="lines-editor" disabled={busy}>
          <legend>收费项目（每项一个分类和费用月份）</legend>
          {lines.map((row, index) => {
            const number = index + 1;
            return (
              <div className="line-row" key={row.id}>
                <label>第 {number} 项分类<select aria-label={`第 ${number} 项分类`} value={row.category} onChange={(event) => updateLine(row.id, { category: event.target.value as Category | '' })}>
                  <option value="">请选择分类</option>
                  {COMPANY_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select></label>
                <label>费用月份<input aria-label={`第 ${number} 项费用月份`} type="month" placeholder="例如 2026-07" value={row.period} onChange={(event) => updateLine(row.id, { period: event.target.value })} /></label>
                <label>金额<input aria-label={`第 ${number} 项金额`} inputMode="decimal" value={row.amount} onChange={(event) => updateLine(row.id, { amount: event.target.value })} /></label>
                <button type="button" aria-label={`删除第 ${number} 项`} disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((item) => item.id !== row.id))}>删除</button>
              </div>
            );
          })}
          <p className="lines-total" role="status">合计：{formatFen(linesTotal)}</p>
          {recognizedTotal !== null && recognizedTotal !== linesTotal && (
            <p className="field-hint">AI 读到的通知单合计是 {formatFen(recognizedTotal)}，和各项相加不一样，请对着图核对每一项。</p>
          )}
          <div className="receipt-actions">
            <button type="button" disabled={lines.length >= MAX_LINES} onClick={addLine}>再加一项</button>
            <button type="button" onClick={mergeIntoOne}>合回一项</button>
          </div>
        </fieldset>
      )}
      <fieldset className="payee-editor" disabled={busy}>
        <legend>收款方（会写进付款单的备注栏）</legend>
        <label>收款户名<input aria-label="收款户名" maxLength={100} value={payeeName} onChange={(event) => setPayeeName(event.target.value)} /></label>
        <label>开户银行<input aria-label="开户银行" maxLength={100} value={payeeBank} onChange={(event) => setPayeeBank(event.target.value)} /></label>
        <label>银行账号
          <input aria-label="银行账号" aria-describedby={accountHintId} inputMode="text" autoComplete="off" value={payeeAccount} onChange={(event) => setPayeeAccount(event.target.value)} />
          <small id={accountHintId} className="field-hint">账号有十几位，请对着图逐位核对，一位都不能错</small>
        </label>
      </fieldset>
      <button type="button" disabled={busy} onClick={() => void confirm()}>确认可付款</button>
      <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>删除回单</button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
