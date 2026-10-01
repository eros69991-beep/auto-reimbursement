import type { Ledger } from '@auto-reimbursement/contracts';
import { api, type ReceiptView } from './api';

type Api = typeof api;

/**
 * 公账付款区的页面调用这几个接口时自动带上 ledger=company，页面里不用到处写区域参数。
 * 只放「调用时没有别的参数能说明区域」的接口：上传、凭证列表、汇总、历史、归档。
 * 规则、重新套用规则这两个由设置页自己把区域当参数传进去。
 * 一律在调用的那一刻去 api 上取函数，测试里换掉 api 的某个方法也能生效。
 */
const COMPANY_CALLS: ReadonlyMap<PropertyKey, unknown> = new Map<PropertyKey, unknown>([
  ['upload', (files: File[], onProgress?: (loaded: number, total: number) => void) => api.upload(files, onProgress, 'company')],
  ['receipts', (view: ReceiptView) => api.receipts(view, 'company')],
  ['totals', () => api.totals('company')],
  ['history', () => api.history('company')],
  ['archive', (month: string) => api.archive(month, 'company')],
  ['unarchive', (month: string) => api.unarchive(month, 'company')],
  ['cleanup', (month: string, confirmation: string) => api.cleanup(month, confirmation, 'company')],
]);

let companyClient: Api | undefined;

/**
 * 页面用的接口对象。店内就是 api 本身（调用写法一个字没变）；
 * 公账是同一个 api 加上面那几个自动带 ledger=company 的版本，别的接口原样转给 api。
 */
export function apiFor(ledger: Ledger): Api {
  if (ledger === 'store') return api;
  companyClient ??= new Proxy(api, {
    get(target, key, receiver) {
      return COMPANY_CALLS.has(key) ? COMPANY_CALLS.get(key) : Reflect.get(target, key, receiver);
    },
  });
  return companyClient;
}
