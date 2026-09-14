import { useState } from 'react';
import { CATEGORIES, type Rule } from '@auto-reimbursement/contracts';

export function RulesEditor({ rules, onSave, onDelete }: { rules: Rule[]; onSave: (rule: Rule) => Promise<void>; onDelete: (id: string) => Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState<Rule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = (): Rule => ({ id: crypto.randomUUID(), kind: 'keyword', key: '', originalCategory: null, category: CATEGORIES[0], confirmations: 0, strong: false, updatedAt: new Date().toISOString() });
  const strongAvailable = draft !== null && draft.confirmations >= 3;
  async function save(): Promise<void> {
    if (draft === null) return;
    try {
      setError(null);
      await onSave({ ...draft, strong: strongAvailable && draft.strong, updatedAt: new Date().toISOString() });
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存规则失败');
    }
  }
  return <section><h3>学习规则</h3>{error && <p role="alert">{error}</p>}{rules.length === 0 ? <p>暂无学习规则</p> : <table><thead><tr><th>特征</th><th>原分类</th><th>最终分类</th><th>次数</th><th>强规则</th><th /></tr></thead><tbody>{rules.map((rule) => <tr key={rule.id}><td>{rule.kind}：{rule.key}</td><td>{rule.originalCategory ?? '—'}</td><td>{rule.category}</td><td>{rule.confirmations}</td><td>{rule.strong ? '是' : '否'}</td><td><button type="button" onClick={() => setDraft(rule)}>编辑规则</button><button type="button" onClick={() => void onDelete(rule.id)}>删除规则</button></td></tr>)}</tbody></table>}<button type="button" onClick={() => { setError(null); setDraft(blank()); }}>新建规则</button>{draft && <section><label>规则特征<input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></label><label>最终分类<select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Rule['category'] })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label><label>强规则<input type="checkbox" disabled={!strongAvailable} checked={strongAvailable && draft.strong} onChange={(e) => setDraft({ ...draft, strong: e.target.checked })} /></label>{!strongAvailable && <p>至少需 3 次确认才能设为强规则。</p>}<button type="button" disabled={!draft.key} onClick={() => void save()}>保存规则</button></section>}</section>;
}
