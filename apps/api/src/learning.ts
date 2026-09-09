import {
  CATEGORIES,
  type Category,
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

  const ruleId = `${feature.kind}:${feature.key}`;
  const previous = store.get('rules', ruleId);
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

export function listRules(store: Store): Rule[] {
  return store
    .list('rules')
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function saveRule(store: Store, rule: Rule): Rule {
  if (rule.kind !== 'merchant' && rule.kind !== 'keyword') {
    throw new Error('INVALID_RULE_KIND');
  }
  if (normalizeFeature(rule.key) === '') {
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
  if (rule.strong && rule.confirmations < 3) {
    throw new Error('INVALID_STRONG_RULE');
  }
  const saved: Rule = { ...rule, key: normalizeFeature(rule.key) };
  store.put('rules', saved);
  return saved;
}

export function deleteRule(store: Store, id: string): void {
  store.remove('rules', id);
}

function featureFor(receipt: Receipt): Feature | null {
  const merchant = normalizeFeature(receipt.analysis?.merchant ?? receipt.merchant ?? '');
  if (merchant !== '') {
    return { kind: 'merchant', key: merchant };
  }
  const keyword = receipt.analysis?.keywords
    .map(normalizeFeature)
    .find((value) => value !== '');
  return keyword === undefined ? null : { kind: 'keyword', key: keyword };
}

function assertCategory(value: unknown): asserts value is Category {
  if (!CATEGORIES.includes(value as Category)) {
    throw new Error('INVALID_CATEGORY');
  }
}
