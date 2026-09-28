import { expect, test } from '@playwright/test';

import { createFixtureRuntime } from './fixture-runtime.ts';

// P-14：609–870px 曾够不到「设置」；回归覆盖手机、平板竖屏、手机横屏、桌面
const widths = [375, 768, 834, 1024, 1366];
const navItems = ['首页', '上传凭证', '本期报销池', '待处理', '生成预览', '历史报销单', '设置'];

test.describe('navigation reachability (P-14)', () => {
  for (const width of widths) {
    test(`every nav item is reachable at ${width}px and nothing overflows`, async ({ page }) => {
      const runtime = await createFixtureRuntime();
      try {
        await page.route('**/api/**', async (route) => {
          const original = new URL(route.request().url());
          await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
        });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/');

        const nav = page.getByRole('navigation', { name: '主导航' });
        for (const name of navItems) {
          const item = nav.getByRole('button', { name, exact: true });
          // scrollIntoViewIfNeeded 验证按钮可以被滚到可视区内（即真实可达）
          await item.scrollIntoViewIfNeeded();
          await expect(item).toBeVisible();
        }

        // 页面本身不允许横向溢出
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);

        // 「设置」真实可点并进入设置页
        await nav.getByRole('button', { name: '设置', exact: true }).click();
        await expect(page).toHaveURL(/#settings/);
        // 当前页高亮
        await expect(nav.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');
      } finally {
        await runtime.close();
      }
    });
  }
});
