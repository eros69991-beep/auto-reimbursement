// P-25：把浏览器/网络层的英文错误翻译成用户可执行的中文提示
// 后台返回的报错是写给店内的（「凭证当前状态不可确认」「报销批次不存在」……），公账区把页面的 say 传进来，
// 显示前换成付款、回单的说法。这些句子是固定的，不含用户填的内容，所以可以放心换词。
export function friendlyError(reason: unknown, fallback: string, say: (text: string) => string = (text) => text): string {
  if (reason instanceof TypeError && /failed to fetch|network|load failed|fetch/i.test(reason.message)) {
    return '网络连接失败，请检查网络后重试';
  }
  return reason instanceof Error ? say(reason.message) : fallback;
}
