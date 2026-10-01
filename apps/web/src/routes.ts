import type { Ledger } from '@auto-reimbursement/contracts';

/**
 * 页面地址（#后面的部分）和「哪个区、哪一页」之间的换算。
 * 店内报销的地址保持原样（#pool、#preview、#batches/xxx/preview……），公账付款在前面加 company：
 * #company/pool、#company/preview、#company/batches/xxx/preview……
 * 这里只做纯换算，不碰浏览器，方便单独测。
 */

export type PageKey = 'home' | 'upload' | 'pool' | 'pending' | 'preview' | 'history' | 'settings';

export interface Route {
  ledger: Ledger;
  page: PageKey;
  /** 只有带批次号的预览地址（#batches/xxx/preview）才有，其余是 null */
  batchId: string | null;
}

/** 导航栏上各区显示哪几项、什么顺序。公账区没有「首页」：切到公账区直接就是上传回单。 */
export const NAV_PAGES: Record<Ledger, readonly PageKey[]> = {
  store: ['home', 'upload', 'pool', 'pending', 'preview', 'history', 'settings'],
  company: ['upload', 'pool', 'pending', 'preview', 'history', 'settings'],
};

const COMPANY_PREFIX = '#company';

const PAGE_BY_NAME: ReadonlyMap<string, PageKey> = new Map<string, PageKey>([
  ['upload', 'upload'],
  ['pool', 'pool'],
  ['pending', 'pending'],
  ['preview', 'preview'],
  ['history', 'history'],
  ['settings', 'settings'],
]);

const BATCH_PREVIEW = /^batches\/([^/]+)\/preview$/;

/**
 * 地址 → 区、页面。认不出的地址落到这个区的默认页（店内是「首页」，公账是「上传回单」），
 * 和以前店内认不出就显示上传页一致。「#companyx」这种不算公账地址。
 */
export function parseRoute(hash: string): Route {
  const company = hash === COMPANY_PREFIX || hash.startsWith(`${COMPANY_PREFIX}/`);
  const ledger: Ledger = company ? 'company' : 'store';
  const rest = company ? hash.slice(COMPANY_PREFIX.length + 1) : hash.replace(/^#/, '');
  const batch = BATCH_PREVIEW.exec(rest);
  if (batch !== null) return { ledger, page: 'preview', batchId: batch[1]! };
  const page = PAGE_BY_NAME.get(rest);
  if (page !== undefined) return { ledger, page, batchId: null };
  return { ledger, page: company ? 'upload' : 'home', batchId: null };
}

/** 区、页面（、批次）→ 地址。店内的写法和以前完全一样。 */
export function routeHash(ledger: Ledger, page: PageKey, batchId?: string): string {
  const prefix = ledger === 'company' ? `${COMPANY_PREFIX}/` : '#';
  if (page === 'preview' && batchId !== undefined) return `${prefix}batches/${batchId}/preview`;
  if (ledger === 'company' && page === 'home') return COMPANY_PREFIX;
  return `${prefix}${page}`;
}

/**
 * 切换到另一个区时去哪：留在同一页（上传、池、待处理、预览、历史、设置各区都有）。
 * 带批次号的预览是上一个区的批次，到另一个区只能去它自己的「预览」页（会落到那个区最近的草稿）。
 * 店内的「首页」到公账区对应「上传回单」，反过来「上传」还是上传。
 */
export function switchLedgerHash(route: Route, target: Ledger): string {
  const page: PageKey = target === 'company' && route.page === 'home' ? 'upload' : route.page;
  return routeHash(target, page);
}
