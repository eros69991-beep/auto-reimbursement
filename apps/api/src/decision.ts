import {
  parseFen,
  type Analysis,
  type Category,
  type Reason,
  type Receipt,
  type Rule,
  type Settings,
} from '@auto-reimbursement/contracts';

import type { Store } from './db.js';
import { refineDuplicates } from './duplicates.js';
import { normalizeFeature } from './learning.js';
import { getSettings } from './settings.js';

const AMOUNT_FLOOR = 0.8;
const CATEGORY_FLOOR = 0.7;

export type Decision = {
  status: 'ready' | 'pending';
  reasons: Reason[];
  category: Category | null;
};

export function decide(
  analysis: Analysis,
  rules: Rule[],
  settings: Settings,
): Decision {
  if (analysis.ambiguous) {
    return pending(['ambiguous_amount'], analysis.category);
  }
  if (analysis.amount === null) {
    return pending(['amount_uncertain'], analysis.category);
  }
  if (analysis.category === null) {
    return pending(['category_uncertain'], null);
  }
  if (
    analysis.confidence.amount < AMOUNT_FLOOR ||
    analysis.confidence.category < CATEGORY_FLOOR
  ) {
    return pending(confidenceReasons(analysis, settings), analysis.category);
  }

  const matchingStrongRules = rules.filter(
    (rule) => rule.strong && matchesRule(rule, analysis),
  );
  if (
    matchingStrongRules.some((rule) => rule.category !== analysis.category) ||
    new Set(matchingStrongRules.map((rule) => rule.category)).size > 1
  ) {
    return pending(['rule_conflict'], analysis.category);
  }

  if (
    analysis.confidence.amount >= settings.amountThreshold &&
    analysis.confidence.category >= settings.categoryThreshold
  ) {
    return ready(analysis.category);
  }

  if (matchingStrongRules.length > 0) {
    return ready(analysis.category);
  }
  return pending(confidenceReasons(analysis, settings), analysis.category);
}

export function applyAnalysis(
  store: Store,
  id: string,
  analysis: Analysis,
): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('RECEIPT_NOT_FOUND');
    }
    if (receipt.status !== 'recognizing' || receipt.deletedAt !== null) {
      throw new Error('INVALID_RECEIPT_STATE');
    }

    const recognizedFen = analysis.amount === null ? null : parseFen(analysis.amount);
    const decision = decide(analysis, store.list('rules'), getSettings(store));
    const analyzed: Receipt = {
      ...receipt,
      analysis,
      recognizedFen,
      paidFen: recognizedFen,
      category: decision.category,
      merchant: analysis.merchant,
      date: analysis.date,
      status: decision.status,
      pendingReasons: decision.reasons,
      duplicateIds: [],
      nextAttemptAt: null,
    };
    const duplicateIds = refineDuplicates(store, analyzed);
    const duplicateReasons: Reason[] =
      duplicateIds.length > 0 ? ['suspected_duplicate'] : [];
    const reasons = uniqueReasons([
      ...decision.reasons,
      ...duplicateReasons,
    ]);
    const updated: Receipt = {
      ...analyzed,
      status: duplicateIds.length > 0 ? 'pending' : decision.status,
      pendingReasons: reasons,
      duplicateIds,
    };
    if (
      updated.status === 'ready' &&
      (updated.paidFen === null || updated.category === null)
    ) {
      throw new Error('INVALID_READY_RECEIPT');
    }
    store.put('receipts', updated);
    return updated;
  });
}

function ready(category: Category): Decision {
  return { status: 'ready', reasons: [], category };
}

function pending(reasons: Reason[], category: Category | null): Decision {
  return { status: 'pending', reasons: uniqueReasons(reasons), category };
}

function confidenceReasons(analysis: Analysis, settings: Settings): Reason[] {
  const reasons: Reason[] = [];
  if (analysis.confidence.amount < settings.amountThreshold) {
    reasons.push('amount_uncertain');
  }
  if (analysis.confidence.category < settings.categoryThreshold) {
    reasons.push('category_uncertain');
  }
  return reasons;
}

function matchesRule(rule: Rule, analysis: Analysis): boolean {
  if (rule.kind === 'merchant') {
    return (
      normalizeFeature(rule.key) !== '' &&
      normalizeFeature(rule.key) === normalizeFeature(analysis.merchant ?? '')
    );
  }
  const key = normalizeFeature(rule.key);
  return (
    key !== '' &&
    analysis.keywords.some((keyword) => normalizeFeature(keyword) === key)
  );
}

function uniqueReasons(reasons: Reason[]): Reason[] {
  return [...new Set(reasons)];
}
