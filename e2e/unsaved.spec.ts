import { expect, test } from '@playwright/test';

import { createFixtureRuntime } from './fixture-runtime.ts';

// P-05 界面级回归：未保存的预览修改不能被吞。
// 报告特别指出：原有 e2e 恰好是“先点保存再生成”，测不出这个问题。
test.describe('unsaved preview edits (P-05)', () => {
  test('auto-saves dirty options before exporting the PDF', async ({ page }) => {
    const runtime = await createFixtureRuntime();
    try {
      await page.route('**/api/**', async (route) => {
        const original = new URL(route.request().url());
        await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
      });
      // 定稿确认框自动接受
      page.on('dialog', (dialog) => void dialog.accept());

      // 记录保存与导出的调用顺序及保存内容
      const calls: string[] = [];
      let savedDepartment: string | null = null;
      page.on('request', (request) => {
        const url = request.url();
        if (request.method() === 'PATCH' && url.includes('/options')) {
          calls.push('save-options');
          savedDepartment = (request.postDataJSON() as { options?: { department?: string } })
            .options?.department ?? null;
        }
        if (url.includes('/export')) {
          calls.push('export');
        }
      });

      await page.goto('/');
      await page.getByLabel('选择凭证图片').setInputFiles('e2e/fixtures/images/normal-01.png');
      await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
      await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: '本期报销池', exact: true }).click();
      await page.getByLabel('选择 食材 · 120.00').check();
      await page.getByRole('button', { name: '生成报销单' }).click();
      await expect(page.getByRole('heading', { name: '生成预览' })).toBeVisible();

      // 修改部门但不点「保存预览设置」——这正是 P-05 会被吞掉的场景
      await page.getByLabel('部门').fill('未保存部门');
      await expect(page.getByText('有未保存的修改', { exact: false })).toBeVisible();

      await page.getByRole('button', { name: '生成 PDF' }).click();
      await expect(page.getByRole('link', { name: '打开或下载 PDF' })).toBeVisible();

      // 导出前必须先把未保存的部门自动保存到服务器
      expect(calls).toEqual(['save-options', 'export']);
      expect(savedDepartment).toBe('未保存部门');
    } finally {
      await runtime.close();
    }
  });

  test('warns before navigating away with unsaved edits and stays when dismissed', async ({ page }) => {
    const runtime = await createFixtureRuntime();
    try {
      await page.route('**/api/**', async (route) => {
        const original = new URL(route.request().url());
        await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
      });
      // 离开确认：选择「取消」，应留在预览页
      page.on('dialog', (dialog) => void dialog.dismiss());

      await page.goto('/');
      await page.getByLabel('选择凭证图片').setInputFiles('e2e/fixtures/images/normal-01.png');
      // 等上传真正完成（「识别中：0」在上传前就成立，不能作为闸门）
      await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
      await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '本期报销池', exact: true }).click();
      await page.getByLabel('选择 食材 · 120.00').check();
      await page.getByRole('button', { name: '生成报销单' }).click();
      await expect(page.getByRole('heading', { name: '生成预览' })).toBeVisible();

      await page.getByLabel('部门').fill('未保存部门');
      // 等 React 提交 dirty 状态并挂载离开守卫，再触发跳转
      await expect(page.getByText('有未保存的修改', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '首页', exact: true }).click();

      // 取消离开后仍停留在该批次的预览页
      await expect(page).toHaveURL(/#batches\/[^/]+\/preview$/);
      await expect(page.getByLabel('部门')).toHaveValue('未保存部门');
    } finally {
      await runtime.close();
    }
  });
});
