import type { Rule } from '@auto-reimbursement/contracts';

export function RulesEditor({ rules, onDelete }: { rules: Rule[]; onDelete: (id: string) => Promise<void> }): React.JSX.Element {
  return <section><h3>学习规则</h3>{rules.length === 0 ? <p>暂无学习规则</p> : <table><thead><tr><th>特征</th><th>原分类</th><th>最终分类</th><th>次数</th><th>强规则</th><th /></tr></thead><tbody>{rules.map((rule) => <tr key={rule.id}><td>{rule.kind}：{rule.key}</td><td>{rule.originalCategory ?? '—'}</td><td>{rule.category}</td><td>{rule.confirmations}</td><td>{rule.strong ? '是' : '否'}</td><td><button type="button" onClick={() => void onDelete(rule.id)}>删除规则</button></td></tr>)}</tbody></table>}</section>;
}
