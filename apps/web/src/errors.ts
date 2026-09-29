// P-25：把浏览器/网络层的英文错误翻译成用户可执行的中文提示
export function friendlyError(reason: unknown, fallback: string): string {
  if (reason instanceof TypeError && /failed to fetch|network|load failed|fetch/i.test(reason.message)) {
    return '网络连接失败，请检查网络后重试';
  }
  return reason instanceof Error ? reason.message : fallback;
}
