import {
  ALL_CATEGORIES,
  categoryLedger,
  isManualRule,
  ledgerOf,
  MIN_MANUAL_RULE_KEY_LENGTH,
  type Category,
  type Ledger,
  type Receipt,
  type Rule,
} from '@auto-reimbursement/contracts';

import type { Store } from './db.js';

type Feature = Pick<Rule, 'kind' | 'key'>;

export function normalizeFeature(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function recordCorrection(
  store: Store,
  id: string,
  category: Category,
): Rule | null {
  return store.transact(() => recordCorrectionInTransaction(store, id, category));
}

export function recordCorrectionInTransaction(
  store: Store,
  id: string,
  category: Category,
): Rule | null {
  assertCategory(category);
  const receipt = store.get('receipts', id);
  if (receipt === null) {
    throw new Error('NOT_FOUND');
  }
  const feature = featureFor(receipt);
  if (feature === null) {
    return null;
  }

  // 公账区学到的规则 id 加前缀：同一个商户名在两个区里是两条互不相干的规则，不会互相覆盖
  const ruleId = `${ledgerOf(receipt) === 'company' ? 'company:' : ''}${feature.kind}:${feature.key}`;
  const previous = store.get('rules', ruleId);
  // 已被用户设为固定规则的特征，不再被确认记录改写（否则一次手动改类会把固定规则悄悄改回学习规则）
  if (previous !== null && isManualRule(previous)) {
    return previous;
  }
  if (!store.recordConfirmation(id, category)) {
    return previous;
  }

  const confirmations =
    previous?.category === category ? previous.confirmations + 1 : 1;
  const rule: Rule = {
    id: ruleId,
    kind: feature.kind,
    key: feature.key,
    originalCategory: receipt.analysis?.category ?? null,
    category,
    confirmations,
    strong: confirmations >= 3,
    updatedAt: new Date().toISOString(),
  };
  saveRule(store, rule);
  return rule;
}

/** 规则没有单独的区字段，属于哪个区看它的分类。不给 ledger 就是全部。 */
export function listRules(store: Store, ledger?: Ledger): Rule[] {
  return store
    .list('rules')
    .filter((rule) => ledger === undefined || categoryLedger(rule.category) === ledger)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function saveRule(store: Store, rule: Rule): Rule {
  if (rule.kind !== 'merchant' && rule.kind !== 'keyword') {
    throw new Error('INVALID_RULE_KIND');
  }
  if (rule.source !== undefined && rule.source !== 'manual' && rule.source !== 'learned') {
    throw new Error('INVALID_RULE_SOURCE');
  }
  const key = normalizeFeature(rule.key);
  if (key === '') {
    throw new Error('INVALID_RULE_KEY');
  }
  if (
    !Number.isInteger(rule.confirmations) ||
    rule.confirmations < 0
  ) {
    throw new Error('INVALID_CONFIRMATIONS');
  }
  assertCategory(rule.category);
  if (rule.originalCategory !== null) {
    assertCategory(rule.originalCategory);
  }
  if (isManualRule(rule)) {
    // 固定规则保存即生效，不需要确认次数；「强规则」只对学习规则有意义
    if ([...key].length < MIN_MANUAL_RULE_KEY_LENGTH) {
      throw new Error('RULE_KEY_TOO_SHORT');
    }
    const saved: Rule = { ...rule, key, strong: false };
    store.put('rules', saved);
    return saved;
  }
  if (rule.strong && rule.confirmations < 3) {
    throw new Error('INVALID_STRONG_RULE');
  }
  const saved: Rule = { ...rule, key };
  store.put('rules', saved);
  return saved;
}

export function deleteRule(store: Store, id: string): void {
  store.remove('rules', id);
}

function featureFor(receipt: Receipt): Feature | null {
  // P-11：优先使用用户修正后的商户，其次才是 AI 识别结果
  for (const source of [receipt.merchant, receipt.analysis?.merchant]) {
    const merchant = normalizeFeature(source ?? '');
    if (merchant !== '') {
      return { kind: 'merchant', key: merchant };
    }
  }
  const keyword = receipt.analysis?.keywords
    .map(normalizeFeature)
    .find((value) => value !== '');
  return keyword === undefined ? null : { kind: 'keyword', key: keyword };
}

function assertCategory(value: unknown): asserts value is Category {
  if (!ALL_CATEGORIES.includes(value as Category)) {
    throw new Error('INVALID_CATEGORY');
  }
}
