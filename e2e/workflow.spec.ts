import { expect, test } from '@playwright/test';

test('uploads, resolves exceptions, refunds, previews and exports', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('选择凭证图片').setInputFiles([
    'e2e/fixtures/images/normal-01.png',
    'e2e/fixtures/images/ambiguous-01.png',
  ]);
  await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
  await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '待处理', exact: true }).click();
  await page.getByLabel('最终实付金额').fill('300.00');
  await page.getByLabel('分类', { exact: true }).selectOption('耗材');
  await page.getByRole('button', { name: '确认可报销' }).click();
  await expect(page.getByText('暂无待处理凭证', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '本期报销池', exact: true }).click();
  await expect(page.getByText('可报销笔数：2', { exact: true })).toBeVisible();

  const normal = page.locator('article').filter({ hasText: '微信生鲜' });
  const originalHref = await normal.getByRole('link', { name: /查看原图/ }).getAttribute('href');
  await normal.getByLabel('退款金额').fill('80.00');
  await normal.getByRole('button', { name: '保存退款' }).click();
  const refundUpload = page.waitForResponse((response) => response.url().includes('/refund-images') && response.status() === 200);
  await normal.getByLabel('上传退款凭证').setInputFiles('e2e/fixtures/images/normal-02.png');
  await refundUpload;
  await normal.getByLabel('选择 微信生鲜').check();
  await page.getByLabel('选择 模糊折扣').check();
  const batchCreated = page.waitForResponse((response) => response.url().includes('/api/batches') && response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('button', { name: '生成报销单' }).click();
  const batch = await batchCreated.then((response) => response.json());
  const originalId = originalHref?.split('/').at(-1);
  const refunded = batch.items.find((item: { original: { id: string } }) => item.original.id === originalId);
  expect(refunded).toEqual(expect.objectContaining({ refundFen: 8000, netFen: 4000 }));
  expect(refunded.refundImages).toHaveLength(1);

  await expect(page.getByRole('heading', { name: '生成预览' })).toBeVisible();
  await page.getByLabel('部门').fill('验收部门');
  await expect(page.getByLabel('部门')).toHaveValue('验收部门');
  const previewSave = page.waitForResponse((response) => response.url().includes('/options'));
  await page.getByRole('button', { name: '保存预览设置' }).click();
  const savedResponse = await previewSave;
  expect(savedResponse.status()).toBe(200);
  const savedPreview = await savedResponse.json();
  expect(savedPreview.options.department).toBe('验收部门');
  const preview = await page.request.get(`/api/batches/${batch.id}/preview.pdf`);
  expect(preview.status()).toBe(200);
  expect(preview.headers()['content-type']).toContain('application/pdf');
  expect(Buffer.from(await preview.body()).subarray(0, 4).toString()).toBe('%PDF');
  const exportResponse = page.waitForResponse((response) => response.url().includes('/export') && response.status() === 200);
  await page.getByRole('button', { name: '生成 PDF' }).click();
  await exportResponse;
  const pdfLink = page.getByRole('link', { name: '打开或下载 PDF' });
  await expect(pdfLink).toHaveAttribute('href', /\/api\/batches\/[^/]+\/pdf$/);
  const pdfResponse = await page.request.get(new URL(await pdfLink.getAttribute('href') ?? '', page.url()).href);
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
});
