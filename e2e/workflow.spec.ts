import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createFixtureRuntime } from './fixture-runtime.ts';

test('uploads, resolves exceptions, edits a receipt that carries an old refund, previews and exports', async ({ page }) => {
  const runtime = await createFixtureRuntime();
  try {
    await page.route('**/api/**', async (route) => {
      const original = new URL(route.request().url());
      await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
    });
    await page.goto('/');
    // 「生成 PDF」前会弹定稿确认框（P-05），自动接受
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByLabel('选择凭证图片').setInputFiles([
      'e2e/fixtures/images/normal-01.png',
      'e2e/fixtures/images/ambiguous-01.png',
    ]);
    await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
    await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '待处理', exact: true }).click();
    // 试点反馈：卡片标题是「分类 · 金额」；编辑框里没有商户和退款，只剩日期、金额、分类
    await expect(page.getByRole('heading', { name: '耗材 · 金额待确认' })).toBeVisible();
    await expect(page.getByLabel('商户')).toHaveCount(0);
    await expect(page.getByLabel('退款金额')).toHaveCount(0);
    await page.getByLabel('最终实付金额').fill('300.00');
    await page.getByLabel('分类', { exact: true }).selectOption('耗材');
    await page.getByRole('button', { name: '确认可报销' }).click();
    await expect(page.getByText('暂无待处理凭证', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '本期报销池', exact: true }).click();
    await expect(page.getByText('可报销笔数：2', { exact: true })).toBeVisible();

    const normal = page.locator('article').filter({ hasText: '食材 · 120.00' });
    const originalHref = await normal.getByRole('link', { name: /查看原图/ }).getAttribute('href');
    const originalId = originalHref?.split('/').at(-1);

    // 退款入口已从界面去掉，但旧数据里登记过的退款仍然有效：这里直接走接口模拟一张带退款的旧凭证
    const pool = await (await fetch(`${runtime.baseUrl}/api/receipts?view=pool`)).json() as Array<{ id: string; original: { id: string } }>;
    const legacyId = pool.find((item) => item.original.id === originalId)?.id;
    expect(legacyId).toBeDefined();
    const refundSet = await fetch(`${runtime.baseUrl}/api/receipts/${legacyId}/refund`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refundFen: 8000 }),
    });
    expect(refundSet.status).toBe(200);
    const evidence = new FormData();
    evidence.append('file', new Blob([await readFile('e2e/fixtures/images/normal-02.png')], { type: 'image/png' }), 'normal-02.png');
    const refundImage = await fetch(`${runtime.baseUrl}/api/receipts/${legacyId}/refund-images`, { method: 'POST', body: evidence });
    expect(refundImage.status).toBe(200);

    // 重新进入报销池：卡片只显示一个金额（净额 40.00）和一行只读的退款说明
    await page.getByRole('button', { name: '待处理', exact: true }).click();
    await page.getByRole('button', { name: '本期报销池', exact: true }).click();
    const refunded = page.locator('article').filter({ hasText: '已扣除退款 80.00' });
    await expect(refunded.getByRole('heading', { name: '食材 · 40.00' })).toBeVisible();
    await expect(refunded.getByRole('textbox')).toHaveCount(0);
    // P-13：编辑器默认收起，先展开；框里是净额 40.00，没有商户和退款控件
    await refunded.getByRole('button', { name: '编辑' }).click();
    await expect(refunded.getByLabel('最终实付金额')).toHaveValue('40.00');
    await expect(refunded.getByLabel('商户')).toHaveCount(0);
    await expect(refunded.getByLabel('退款金额')).toHaveCount(0);
    // 改成 30.00：后台把已登记的退款加回去（实付 110.00、退款 80.00），净额恰好是 30.00，不会重复扣
    await refunded.getByLabel('最终实付金额').fill('30.00');
    await refunded.getByRole('button', { name: '确认可报销' }).click();
    await expect(refunded.getByRole('heading', { name: '食材 · 30.00' })).toBeVisible();
    await expect(refunded.getByText('已扣除退款 80.00')).toBeVisible();

    await refunded.getByLabel('选择 食材 · 30.00').check();
    await page.getByLabel('选择 耗材 · 300.00').check();
    const batchCreated = page.waitForResponse((response) => response.url().includes('/api/batches') && response.request().method() === 'POST' && response.status() === 201);
    await page.getByRole('button', { name: '生成报销单' }).click();
    const batch = await batchCreated.then((response) => response.json());
    const refundedItem = batch.items.find((item: { original: { id: string } }) => item.original.id === originalId);
    expect(refundedItem).toEqual(expect.objectContaining({ paidFen: 11000, refundFen: 8000, netFen: 3000 }));
    expect(refundedItem.refundImages).toHaveLength(1);

    await expect(page.getByRole('heading', { name: '生成预览' })).toBeVisible();
    await page.getByLabel('部门').fill('验收部门');
    await expect(page.getByLabel('部门')).toHaveValue('验收部门');
    const previewSave = page.waitForResponse((response) => response.url().includes('/options'));
    await page.getByRole('button', { name: '保存预览设置' }).click();
    const savedResponse = await previewSave;
    expect(savedResponse.status()).toBe(200);
    const savedPreview = await savedResponse.json();
    expect(savedPreview.options.department).toBe('验收部门');
    const preview = await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/preview.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    const exportResponse = page.waitForResponse((response) => response.url().includes('/export') && response.status() === 200);
    await page.getByRole('button', { name: '生成 PDF' }).click();
    await exportResponse;
    const pdfLink = page.getByRole('link', { name: '打开或下载 PDF' });
    await expect(pdfLink).toHaveAttribute('href', /\/api\/batches\/[^/]+\/pdf$/);
    const pdfHref = new URL(await pdfLink.getAttribute('href') ?? '', runtime.baseUrl);
    const pdfResponse = await fetch(`${runtime.baseUrl}${pdfHref.pathname}${pdfHref.search}`);
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get('content-type')).toContain('application/pdf');
  } finally {
    await runtime.close();
  }
});
