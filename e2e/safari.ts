import type { Page } from '@playwright/test';

/**
 * Playwright 跑不了真正的 Safari，所以让 Chromium 假装缺 Safari 缺的那一项功能：
 * Safari 26 及更早版本（iPhone 上的 18.x 也是）的 ReadableStream 不能用 for await 遍历，Safari 27 才有。
 * 页面里任何代码一碰它——包括 pdf.js 的 page.getTextContent()——就会抛和真机上一样的
 * 「TypeError: undefined is not a function」。
 *
 * 试点时报销单预览在手机和 Mac 的 Safari 上全部加载失败，正是因为这条路在 Chromium 里走得通、在 Safari 里走不通，
 * 而单元测试把 pdf.js 整个替换成了假的，e2e 又只跑 Chromium，两边都没发现。凡是要在页面里真跑 pdf.js 的 e2e 都应该先调用它。
 * 只影响页面本身；pdf.js 的 worker 是另一个运行环境，不受影响（worker 里同类的调用 pdf.js 自己有兜底）。
 */
export async function pretendToBeSafari(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const streams = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    delete streams[Symbol.asyncIterator];
    delete streams.values;
  });
}
