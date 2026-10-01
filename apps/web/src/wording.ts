import type { Ledger } from '@auto-reimbursement/contracts';

/**
 * 界面文字按区换说法。页面里写的都是店内的原话（「本期报销池」「生成报销单」「上传凭证」……），
 * 店内区原样显示；公账付款区把这几个词换掉：报销→付款、凭证→回单、部门→付款单位、报销人/签名人→经办人。
 * 页面只给静态文字套 say()，用户输入的内容（商户、户名、备注……）不要套，免得被误换。
 */
export type Say = (text: string) => string;

/**
 * 按顺序一个个换。「报销人」要排在「报销」前面，不然会先变成「付款人」；
 * 「报销」一条就管了报销池→付款池、报销单→付款单、可报销→可付款、报销→付款，不用再单列。
 */
const TERMS: ReadonlyArray<readonly [string, string]> = [
  ['报销人', '经办人'],
  ['签名人', '经办人'],
  ['报销', '付款'],
  ['凭证', '回单'],
  ['部门', '付款单位'],
];

/** 整句专门的说法，优先于上面的换词。 */
const WHOLE_TEXT: ReadonlyMap<string, string> = new Map([
  ['生成预览', '付款单预览'],
  // 换词会变成「完整付款 PDF 预览」，读起来不通
  ['完整报销 PDF 预览', '完整付款单 PDF 预览'],
]);

/** 区的名字，导航栏的切换按钮和提示里用。 */
export const LEDGER_NAMES: Record<Ledger, string> = {
  store: '店内报销',
  company: '公账付款',
};

const asIs: Say = (text) => text;

function replaceTerms(text: string): string {
  let result = text;
  for (const [from, to] of TERMS) result = result.replaceAll(from, to);
  return result;
}

const toCompany: Say = (text) => {
  const whole = WHOLE_TEXT.get(text);
  if (whole !== undefined) return whole;
  // 「店内报销」是店内区的名字（后台报「店内报销和公账付款的凭证不能合并」时会出现），
  // 换词时原样留着，不能变成「店内付款」
  const store = LEDGER_NAMES.store;
  return text.split(store).map(replaceTerms).join(store);
};

/** 这个区的说法：店内原样返回；公账换成付款、回单这套词。 */
export function sayFor(ledger: Ledger): Say {
  return ledger === 'company' ? toCompany : asIs;
}
