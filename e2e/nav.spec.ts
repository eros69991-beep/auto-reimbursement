import { expect, test } from '@playwright/test';

import { createFixtureRuntime } from './fixture-runtime.ts';

// P-14：609–870px 曾够不到「设置」；回归覆盖手机、平板竖屏、手机横屏、桌面
const widths = [375, 768, 834, 1024, 1366];
const navItems = ['首页', '上传凭证', '本期报销池', '待处理', '生成预览', '历史报销单', '设置'];
// 公账付款区没有「首页」，叫法也换成付款、回单
const companyNavItems = ['上传回单', '本期付款池', '待处理', '付款单预览', '历史付款单', '设置'];

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

        // 顶部的「店内报销 / 公账付款」切换也要够得着
        const ledgers = page.getByRole('group', { name: '切换区域' });
        await expect(ledgers.getByRole('button', { name: '店内报销' })).toBeVisible();
        await expect(ledgers.getByRole('button', { name: '公账付款' })).toBeVisible();

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

// 公账付款区：切过去以后导航还是每一项都够得着、不横向溢出，再切回店内也一样
test.describe('company navigation reachability', () => {
  for (const width of widths) {
    test(`switching to the company ledger keeps every nav item reachable at ${width}px`, async ({ page }) => {
      const runtime = await createFixtureRuntime();
      try {
        await page.route('**/api/**', async (route) => {
          const original = new URL(route.request().url());
          await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
        });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/');

        const ledgers = page.getByRole('group', { name: '切换区域' });
        await ledgers.getByRole('button', { name: '公账付款' }).scrollIntoViewIfNeeded();
        await ledgers.getByRole('button', { name: '公账付款' }).click();
        await expect(page).toHaveURL(/#company\/upload$/);
        await expect(ledgers.getByRole('button', { name: '公账付款' })).toHaveAttribute('aria-pressed', 'true');

        const nav = page.getByRole('navigation', { name: '主导航' });
        await expect(nav.getByRole('button')).toHaveText(companyNavItems);
        for (const name of companyNavItems) {
          const item = nav.getByRole('button', { name, exact: true });
          await item.scrollIntoViewIfNeeded();
          await expect(item).toBeVisible();
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);

        await nav.getByRole('button', { name: '设置', exact: true }).click();
        await expect(page).toHaveURL(/#company\/settings$/);
        await expect(nav.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');

        // 切回店内：回到店内的设置页，导航又是原来那 7 项
        await ledgers.getByRole('button', { name: '店内报销' }).click();
        await expect(page).toHaveURL(/#settings$/);
        await expect(nav.getByRole('button')).toHaveText(navItems);
      } finally {
        await runtime.close();
      }
    });
  }
});
