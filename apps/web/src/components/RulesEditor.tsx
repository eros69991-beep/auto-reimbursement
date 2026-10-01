import { useState } from 'react';
import {
  categoriesFor,
  isManualRule,
  MIN_MANUAL_RULE_KEY_LENGTH,
  type Ledger,
  type Rule,
} from '@auto-reimbursement/contracts';
import { sayFor } from '../wording';

const SCOPE_LABELS: Record<Rule['kind'], string> = {
  keyword: '商户或图中文字',
  merchant: '只看商户',
};

const FEATURE_LABELS: Record<Rule['kind'], string> = { merchant: '商户', keyword: '关键词' };

interface RulesEditorProps {
  /** 哪个区的规则：决定能选的分类和界面说法。不给就是店内 */
  ledger?: Ledger;
  rules: Rule[];
  onSave: (rule: Rule) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** 用已有识别结果对待处理凭证重新套用规则，返回有变化的张数 */
  onReapply: () => Promise<number>;
}

function keyLength(key: string): number {
  return [...key.trim()].length;
}

/**
 * 分类规则。固定规则（手动添加）保存即生效、命中就直接定分类；
 * 学习规则是确认分类时自动记下的，只能放行或提示冲突，可一键设为固定规则。
 */
export function RulesEditor({ ledger = 'store', rules, onSave, onDelete, onReapply }: RulesEditorProps): React.JSX.Element {
  const say = sayFor(ledger);
  const categories = categoriesFor(ledger);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fixed = rules.filter(isManualRule).sort((left, right) => left.key.localeCompare(right.key));
  const learned = rules.filter((rule) => !isManualRule(rule));
  const draftTooShort = draft !== null && keyLength(draft.key) < MIN_MANUAL_RULE_KEY_LENGTH;

  const blank = (): Rule => ({
    id: crypto.randomUUID(),
    kind: 'keyword',
    key: '',
    originalCategory: null,
    category: categories[0]!,
    confirmations: 0,
    strong: false,
    updatedAt: new Date().toISOString(),
    source: 'manual',
  });

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? say(reason.message) : fallback);
    } finally {
      setBusy(false);
    }
  }

  function saveDraft(): Promise<void> {
    if (draft === null) return Promise.resolve();
    return run(async () => {
      await onSave({ ...draft, key: draft.key.trim(), source: 'manual', strong: false, updatedAt: new Date().toISOString() });
      setDraft(null);
      setNotice(say('固定规则已保存，之后识别的凭证马上按它归类；已在待处理里的，点「套用到待处理凭证」。'));
    }, '保存规则失败');
  }

  function promote(rule: Rule): Promise<void> {
    return run(async () => {
      await onSave({ ...rule, source: 'manual', strong: false, updatedAt: new Date().toISOString() });
      setNotice(`已把「${rule.key}」设为固定规则`);
    }, '保存规则失败');
  }

  function remove(rule: Rule): Promise<void> {
    return run(() => onDelete(rule.id), '删除规则失败');
  }

  function reapply(): Promise<void> {
    return run(async () => {
      const affected = await onReapply();
      setNotice(affected > 0 ? say(`已重新套用规则，${affected} 张待处理凭证有变化`) : say('待处理凭证里没有需要按规则调整的'));
    }, '套用规则失败');
  }

  function edit(rule: Rule): void {
    setError(null);
    setNotice(null);
    setDraft(rule);
  }

  return (
    <section className="rules-editor">
      <h3>分类规则</h3>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <h4>固定规则</h4>
      <p className="rule-hint">保存后马上生效：识别出的商户或图中文字包含这段文字，就直接归到指定分类，不管 AI 怎么判断。</p>
      {fixed.length === 0 ? <p>暂无固定规则</p> : (
        <ul aria-label="固定规则">
          {fixed.map((rule) => (
            <li key={rule.id}>
              <span>包含「{rule.key}」<small>（{SCOPE_LABELS[rule.kind]}）</small> → {rule.category}</span>
              <button type="button" disabled={busy} aria-label={`编辑固定规则 ${rule.key}`} onClick={() => edit(rule)}>编辑</button>
              <button type="button" disabled={busy} aria-label={`删除固定规则 ${rule.key}`} onClick={() => void remove(rule)}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy} onClick={() => edit(blank())}>新建固定规则</button>
      {draft && (
        <section className="rule-draft" aria-label="编辑固定规则">
          <label>
            包含文字
            <input value={draft.key} maxLength={50} placeholder={ledger === 'company' ? '例如：新沣' : '例如：武汉仓'} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
          </label>
          <label>
            匹配范围
            <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Rule['kind'] })}>
              <option value="keyword">{SCOPE_LABELS.keyword}</option>
              <option value="merchant">{SCOPE_LABELS.merchant}</option>
            </select>
          </label>
          <label>
            归到分类
            <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as Rule['category'] })}>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          {draftTooShort && <p className="rule-hint">{say(`至少 ${MIN_MANUAL_RULE_KEY_LENGTH} 个字，避免把无关的凭证也归进来。`)}</p>}
          <button type="button" disabled={busy || draftTooShort} onClick={() => void saveDraft()}>保存规则</button>
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button>
        </section>
      )}
      <p>
        <button type="button" disabled={busy} onClick={() => void reapply()}>{say('套用到待处理凭证')}</button>
      </p>
      <p className="rule-hint">{say('用已有识别结果重新套一遍规则，不会重新调用 AI，也不会改动你手动改过的凭证。')}</p>

      <h4>学习到的规则</h4>
      <p className="rule-hint">你确认分类时自动记下的。同一特征确认满 3 次成为强规则：AI 判断和它不一样时，{say('凭证')}会进待处理，并提示规则的分类。</p>
      {learned.length === 0 ? <p>暂无学习规则</p> : (
        <ul aria-label="学习到的规则">
          {learned.map((rule) => (
            <li key={rule.id}>
              <span>
                {FEATURE_LABELS[rule.kind]}：{rule.key} → {rule.category}
                <small>（确认 {rule.confirmations} 次{rule.strong ? '，强规则' : ''}{rule.originalCategory ? `，AI 原判${rule.originalCategory}` : ''}）</small>
              </span>
              <button
                type="button"
                disabled={busy || keyLength(rule.key) < MIN_MANUAL_RULE_KEY_LENGTH}
                aria-label={`把 ${rule.key} 设为固定规则`}
                onClick={() => void promote(rule)}
              >
                设为固定规则
              </button>
              <button type="button" disabled={busy} aria-label={`删除学习规则 ${rule.key}`} onClick={() => void remove(rule)}>删除</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
