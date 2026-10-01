import {
  categoryLedger,
  isManualRule,
  ledgerOf,
  MIN_MANUAL_RULE_KEY_LENGTH,
  parseFen,
  type Analysis,
  type Category,
  type Ledger,
  type Reason,
  type Receipt,
  type Rule,
  type RuleMatch,
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
  /** 只在规则起作用时出现：固定规则决定了分类，或学习规则与 AI 不一致时给出的建议。 */
  ruleMatch?: RuleMatch;
};

/**
 * 分类决策。优先级：人工确认（不经过这里）> 固定规则 > AI。
 * - 固定规则（设置页手动添加）命中就直接定分类，只剩金额需要把关。
 * - 学习到的强规则只能放行或报冲突，不改写分类；冲突时把规则的分类作为建议附上，由人一键选择。
 * 规则只看凭证所在的区（ledger）：店内的规则不会用到公账凭证上，反过来也一样。
 */
export function decide(
  analysis: Analysis,
  allRules: Rule[],
  settings: Settings,
  ledger: Ledger = 'store',
): Decision {
  const rules = allRules.filter((rule) => categoryLedger(rule.category) === ledger);
  const manualMatches = rules.filter(
    (rule) => isManualRule(rule) && matchesManualRule(rule, analysis),
  );
  if (manualMatches.length > 0) {
    return decideByManualRules(analysis, manualMatches, settings);
  }
  const strongMatches = rules.filter(
    (rule) => !isManualRule(rule) && rule.strong && matchesRule(rule, analysis),
  );
  return withSuggestion(
    decideByAi(analysis, strongMatches, settings),
    strongMatches,
    analysis.category,
  );
}

function decideByAi(
  analysis: Analysis,
  matchingStrongRules: Rule[],
  settings: Settings,
): Decision {
  if (analysis.incomplete === true) {
    // 只拍到了一单的一部分（比如只有菜品清单、没有实付）：金额不可信，交给人合并截图或手填
    return pending(incompleteReasons(analysis), analysis.category);
  }
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

function decideByManualRules(
  analysis: Analysis,
  matches: Rule[],
  settings: Settings,
): Decision {
  const amountReasons = amountUncertainty(analysis, settings);
  if (new Set(matches.map((rule) => rule.category)).size > 1) {
    // 多条固定规则给出不同分类：不替用户挑，保留 AI 的判断交给人工
    return pending(['rule_conflict', ...amountReasons], analysis.category);
  }
  const rule = [...matches].sort(compareRules)[0]!;
  const ruleMatch: RuleMatch = {
    mode: 'applied',
    ruleId: rule.id,
    key: rule.key,
    category: rule.category,
  };
  if (amountReasons.length > 0) {
    return { ...pending(amountReasons, rule.category), ruleMatch };
  }
  return { ...ready(rule.category), ruleMatch };
}

// 学习规则一致给出同一个、且与 AI 不同的分类时，附上建议；分类本身保持 AI 的判断。
// （试点反馈里的冲突，AI 判断的酒水才是对的，所以不预选规则分类，两边都给一键可选。）
function withSuggestion(
  decision: Decision,
  strongMatches: Rule[],
  aiCategory: Category | null,
): Decision {
  if (decision.status !== 'pending' || strongMatches.length === 0) {
    return decision;
  }
  const categories = new Set(strongMatches.map((rule) => rule.category));
  if (categories.size !== 1 || categories.has(aiCategory as Category)) {
    return decision;
  }
  const rule = [...strongMatches].sort(compareRules)[0]!;
  return {
    ...decision,
    ruleMatch: {
      mode: 'suggested',
      ruleId: rule.id,
      key: rule.key,
      category: rule.category,
    },
  };
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
    const decision = decide(analysis, store.list('rules'), getSettings(store), ledgerOf(receipt));
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
      ruleMatch: decision.ruleMatch ?? null,
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

const DECISION_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'amount_uncertain',
  'category_uncertain',
  'ambiguous_amount',
  'incomplete_screenshot',
  'rule_conflict',
]);

/**
 * 设置页「套用到待处理」：规则改动后，用已保存的识别结果重新走一遍分类决策（不调用 AI）。
 * 只处理仍保持识别原样的待处理凭证——人工改过金额或分类的、疑似重复、识别失败的都不动。
 * 给了 ledger 就只处理那个区的凭证（设置页在哪个区，就只重新套用哪个区的）。返回有变化的凭证数。
 */
export function reapplyRules(store: Store, ledger?: Ledger): number {
  return store.transact(() => {
    const rules = store.list('rules');
    const settings = getSettings(store);
    let affected = 0;
    for (const receipt of store.list('receipts')) {
      if (!canReapply(receipt) || (ledger !== undefined && ledgerOf(receipt) !== ledger)) {
        continue;
      }
      const decision = decide(receipt.analysis!, rules, settings, ledgerOf(receipt));
      const next: Receipt = {
        ...receipt,
        category: decision.category,
        status: decision.status,
        pendingReasons: decision.reasons,
        ruleMatch: decision.ruleMatch ?? null,
      };
      if (next.status === 'ready' && (next.paidFen === null || next.category === null)) {
        continue;
      }
      if (sameDecision(receipt, next)) {
        continue;
      }
      store.put('receipts', next);
      affected += 1;
    }
    return affected;
  });
}

function canReapply(receipt: Receipt): boolean {
  if (
    receipt.status !== 'pending' ||
    receipt.deletedAt !== null ||
    receipt.batchId !== null ||
    receipt.archivedAt !== null ||
    receipt.analysis === null ||
    receipt.duplicateIds.length > 0
  ) {
    return false;
  }
  // 原因为空是「修改待确认」：人工改过，交给人确认
  if (
    receipt.pendingReasons.length === 0 ||
    !receipt.pendingReasons.every((reason) => DECISION_REASONS.has(reason))
  ) {
    return false;
  }
  if (receipt.paidFen !== receipt.recognizedFen) {
    return false;
  }
  const automaticCategory =
    receipt.ruleMatch?.mode === 'applied'
      ? receipt.ruleMatch.category
      : receipt.analysis.category;
  return receipt.category === automaticCategory;
}

function sameDecision(left: Receipt, right: Receipt): boolean {
  return (
    left.category === right.category &&
    left.status === right.status &&
    JSON.stringify(left.pendingReasons) === JSON.stringify(right.pendingReasons) &&
    JSON.stringify(left.ruleMatch ?? null) === JSON.stringify(right.ruleMatch ?? null)
  );
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

// 固定规则只替代分类判断，金额仍按原标准把关
function amountUncertainty(analysis: Analysis, settings: Settings): Reason[] {
  if (analysis.incomplete === true) {
    return incompleteReasons(analysis);
  }
  if (analysis.ambiguous) {
    return ['ambiguous_amount'];
  }
  if (
    analysis.amount === null ||
    analysis.confidence.amount < AMOUNT_FLOOR ||
    analysis.confidence.amount < settings.amountThreshold
  ) {
    return ['amount_uncertain'];
  }
  return [];
}

// 「截图不完整」放在最前面；同时读不出金额时再补一条，卡片上两个原因都能看到
function incompleteReasons(analysis: Analysis): Reason[] {
  return analysis.amount === null
    ? ['incomplete_screenshot', 'amount_uncertain']
    : ['incomplete_screenshot'];
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

// 固定规则按「包含」匹配（忽略空格与全半角、大小写）：
// 商户规则只看商户；关键词规则看商户、关键词和识别原文。
export function matchesManualRule(rule: Rule, analysis: Analysis): boolean {
  const key = compact(rule.key);
  if ([...key].length < MIN_MANUAL_RULE_KEY_LENGTH) {
    return false;
  }
  const texts =
    rule.kind === 'merchant'
      ? [analysis.merchant ?? '']
      : [analysis.merchant ?? '', ...analysis.keywords, analysis.evidence];
  return texts.some((text) => compact(text).includes(key));
}

function compact(value: string): string {
  return normalizeFeature(value).replace(/\s+/g, '');
}

// 多条同类规则同时命中时取文字最长（最具体）的一条，其次按 id，保证结果稳定
function compareRules(left: Rule, right: Rule): number {
  return (
    [...right.key].length - [...left.key].length ||
    left.id.localeCompare(right.id)
  );
}

function uniqueReasons(reasons: Reason[]): Reason[] {
  return [...new Set(reasons)];
}
