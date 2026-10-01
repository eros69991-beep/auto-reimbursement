import { readFile } from 'node:fs/promises';

import type { Batch, HistoryMonth, Receipt, Totals } from '@auto-reimbursement/contracts';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { createFixtureRuntime, type FixtureRuntime } from './fixture-runtime.ts';
import { pretendToBeSafari } from './safari.ts';

// 公账付款区：两张银行回单（肉款、品牌管理费）加一张收费通知单（租金、物业费、水费、电费、空调能源费五项，
// 其中租金和物业费是 9 月，水电和空调能源费是上个月的 7 月），在真实后端和真实浏览器里走完
// 上传 → 付款池 → 付款单预览 → 导出 → 历史，同时店内有一张凭证，两边互相看不到。
// 图是合成的，账号和户名都是编的；假识别按图给出固定结果（e2e/fixtures/company-manifest.json）。

const COMPANY_IMAGES = ['company-meat.png', 'company-brand.png', 'company-notice.png'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const UNIT = '武汉市火门里餐饮管理有限公司';

const MEAT_ACCOUNT = '9876543210987654321';
const BRAND_ACCOUNT = '6217000012345678901';
const NOTICE_ACCOUNT = '1234567890123456789';

async function routeApiToRuntime(page: Page, runtime: FixtureRuntime): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const original = new URL(route.request().url());
    await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
  });
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url} → ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

/** 一页一个字符串，空白全部去掉（pdf.js 把一行字拆成好几段，段与段之间的空格不固定） */
async function pdfPages(bytes: Buffer): Promise<string[]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  return Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.map((item) => ('str' in item ? item.str : '')).join('').replace(/\s+/g, '');
  }));
}

/**
 * 公账区的页面正文里不能出现店内的叫法（凭证、报销）。头部不算：那里有「店内报销」切换按钮；
 * 「店内报销」这个区名出现在正文里（例如「已在「店内报销」里」）是对的，所以前面是「店内」的「报销」不算。
 */
async function expectCompanyWords(page: Page): Promise<void> {
  await expect(page.locator('main')).not.toContainText(/凭证|(?<!店内)报销/);
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** 用接口上传公账图并等识别完，三张都进了付款池；返回它们在池里的凭证 */
async function seedCompanyPool(runtime: FixtureRuntime): Promise<Receipt[]> {
  const form = new FormData();
  for (const name of COMPANY_IMAGES) {
    form.append('files', new Blob([await readFile(`e2e/fixtures/images/${name}`)], { type: 'image/png' }), name);
  }
  const uploaded = await json<{ accepted: Receipt[] }>(
    await fetch(`${runtime.baseUrl}/api/receipts/upload?ledger=company`, { method: 'POST', body: form }),
  );
  expect(uploaded.accepted).toHaveLength(COMPANY_IMAGES.length);
  await expect.poll(async () => (await json<Receipt[]>(await fetch(`${runtime.baseUrl}/api/receipts?view=pool&ledger=company`))).length).toBe(COMPANY_IMAGES.length);
  return json<Receipt[]>(await fetch(`${runtime.baseUrl}/api/receipts?view=pool&ledger=company`));
}

test.describe('公账付款区', () => {
  test('两张回单加一张通知单：上传 → 付款池 → 付款单预览 → 导出 → 历史，和店内互不出现', async ({ page }) => {
    const runtime = await createFixtureRuntime();
    try {
      await pretendToBeSafari(page);
      await routeApiToRuntime(page, runtime);
      // 「生成 PDF」前会弹定稿确认框，自动接受
      page.on('dialog', (dialog) => void dialog.accept());
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/');

      // 店内先放一张凭证，后面检查公账区里看不到它
      await page.getByLabel('选择凭证图片').setInputFiles('e2e/fixtures/images/normal-01.png');
      await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
      await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();

      // ---- 切到公账区：上传回单 ----
      const ledgers = page.getByRole('group', { name: '切换区域' });
      await expect(ledgers.getByRole('button', { name: '店内报销' })).toHaveAttribute('aria-pressed', 'true');
      await ledgers.getByRole('button', { name: '公账付款' }).click();
      await expect(page).toHaveURL(/#company\/upload$/);
      await expect(ledgers.getByRole('button', { name: '公账付款' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('heading', { name: '上传回单' })).toBeVisible();
      await expectCompanyWords(page);
      // 店内上传页上的「上传结果」不会带到公账区
      await expect(page.getByRole('heading', { name: '上传结果' })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button')).toHaveText(['上传回单', '本期付款池', '待处理', '付款单预览', '历史付款单', '设置']);

      await page.getByLabel('选择回单图片').setInputFiles(COMPANY_IMAGES.map((name) => `e2e/fixtures/images/${name}`));
      await expect(page.getByRole('heading', { name: '上传结果' })).toBeVisible();
      await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();
      await expect(page.getByText('成功数：3', { exact: true })).toBeVisible();
      await expectCompanyWords(page);

      // 三张都识别通过：待处理里没有
      await page.getByRole('button', { name: '待处理', exact: true }).click();
      await expect(page.getByText('暂无待处理回单', { exact: true })).toBeVisible();
      await expectCompanyWords(page);

      // ---- 设置里填公账付款单位（付款单上的「付款单位」），店内的部门不动 ----
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('公账付款单位').fill(UNIT);
      await page.getByRole('button', { name: '保存设置' }).click();
      await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
      await expectCompanyWords(page);

      // ---- 付款池：三张回单、八类分类的汇总，一张通知单拆成五项 ----
      await page.getByRole('button', { name: '本期付款池', exact: true }).click();
      await expect(page.getByRole('heading', { name: '付款池' })).toBeVisible();
      await expect(page.getByText('可付款笔数：3', { exact: true })).toBeVisible();
      await expect(page.getByText('合计：59256.12', { exact: true })).toBeVisible();
      const totals = page.getByRole('region', { name: '付款池汇总' });
      for (const line of ['肉款：12909.49', '品牌管理费：6785.00', '店面租金：22814.10', '物业费：5069.80', '水费：48.86', '电费：11466.87', '空调能源费：162.00', '其他公账支出：0.00']) {
        await expect(totals.getByText(line, { exact: true })).toBeVisible();
      }
      await expect(totals.getByText(/^(食材|耗材|日常用品|肉类|酒水|能耗费|人工费用|租金及管理费|员工餐|百慕达食材)：/)).toHaveCount(0);

      await expect(page.getByRole('heading', { name: '肉款 · 12909.49' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '品牌管理费 · 6785.00' })).toBeVisible();
      const notice = page.locator('article').filter({ has: page.getByRole('heading', { name: '含 5 项 · 39561.63' }) });
      await expect(notice.getByRole('list', { name: '收费项目' }).getByRole('listitem')).toHaveText([
        '店面租金（2026年9月） 22814.10',
        '物业费（2026年9月） 5069.80',
        '水费（2026年7月） 48.86',
        '电费（2026年7月） 11466.87',
        '空调能源费（2026年7月） 162.00',
      ]);
      await expect(notice.getByLabel('收款方')).toContainText(NOTICE_ACCOUNT);
      await expect(page.getByRole('heading', { name: '食材 · 120.00' })).toHaveCount(0);
      await expectCompanyWords(page);

      // 编辑框：公账的编辑框有费用月份、拆成多项、收款方；账号读错一位可以在这里改
      const meat = page.locator('article').filter({ has: page.getByRole('heading', { name: '肉款 · 12909.49' }) });
      await meat.getByRole('button', { name: '编辑' }).click();
      await expect(meat.getByLabel('费用月份')).toBeVisible();
      await expect(meat.getByLabel('银行账号')).toHaveValue(MEAT_ACCOUNT);
      await expect(meat.getByRole('button', { name: '拆成多项（一张通知单有好几项费用）' })).toBeVisible();
      await expectCompanyWords(page);
      await meat.getByRole('button', { name: '收起编辑' }).click();

      // ---- 生成付款单 ----
      await page.getByLabel('全选可付款').check();
      const created = page.waitForResponse((response) => response.url().includes('/api/batches') && response.request().method() === 'POST' && response.status() === 201);
      await page.getByRole('button', { name: '生成付款单' }).click();
      const batch = await created.then((response) => response.json()) as Batch;
      expect(batch.ledger).toBe('company');
      expect(batch.options.department).toBe(UNIT);
      expect(batch.totalFen).toBe(5_925_612);
      // 回单各占一行，放在第 1 张；通知单的五项排在同一张单上（第 2 张）
      expect(batch.sheets.map((sheet) => sheet.groups.map((group) => `${group.category}${group.period === undefined ? '' : `（${group.period}）`}`))).toEqual([
        ['肉款', '品牌管理费'],
        ['店面租金（2026-09）', '物业费（2026-09）', '水费（2026-07）', '电费（2026-07）', '空调能源费（2026-07）'],
      ]);

      // ---- 付款单预览 ----
      await expect(page.getByRole('heading', { name: '付款单预览' })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#company/batches/${batch.id}/preview$`));
      await expect(page.getByLabel('付款单位')).toHaveValue(UNIT);
      // 对账页左边画付款单原样：两张付款单（附件页不画），pdf.js 在缺 for-await 的 Safari 替身里照样画得出来
      const forms = page.getByRole('region', { name: '付款单原样' }).locator('canvas');
      await expect(forms).toHaveCount(2, { timeout: 20_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);

      // 右边逐张看回单：说明写第几张付款单，收款方放在图旁边
      const side = page.getByRole('region', { name: '回单附件' });
      await expect(side.locator('.attachment-title')).toHaveText('第 1 张付款单 · 肉款 第 1/1 张 · 本张 12909.49 · 肉款合计 12909.49');
      await expect(side.getByRole('group', { name: '收款方信息' })).toContainText(MEAT_ACCOUNT);
      await side.getByRole('button', { name: '下一张' }).click();
      await expect(side.locator('.attachment-title')).toHaveText('第 1 张付款单 · 品牌管理费 第 1/1 张 · 本张 6785.00 · 品牌管理费合计 6785.00');
      await expect(side.getByRole('group', { name: '收款方信息' })).toContainText(BRAND_ACCOUNT);
      await side.getByRole('button', { name: '下一张' }).click();
      await expect(side.locator('.attachment-title')).toContainText('第 2 张付款单 · 本张回单 39561.63，含 5 项');
      await expect(side.getByRole('group', { name: '收款方信息' })).toContainText(NOTICE_ACCOUNT);
      await expect(side.getByRole('button', { name: '下一张' })).toBeDisabled();
      await expectCompanyWords(page);

      // ---- 导出 ----
      const exported = page.waitForResponse((response) => response.url().includes('/export') && response.status() === 200);
      await page.getByRole('button', { name: '生成 PDF' }).click();
      const finished = await exported.then((response) => response.json()) as Batch;
      expect(finished.pdfPath).not.toBeNull();
      const pdfLink = page.getByRole('link', { name: '打开或下载 PDF' });
      await expect(pdfLink).toHaveAttribute('href', /\/api\/batches\/[^/]+\/pdf$/);
      const pdfResponse = await fetch(`${runtime.baseUrl}/api/batches/${batch.id}/pdf`);
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get('content-type')).toContain('application/pdf');

      // 付款单 PDF：2 张付款单，每张后面跟着它的回单附件页（共 3 页）
      const pages = await pdfPages(Buffer.from(await pdfResponse.arrayBuffer()));
      expect(pages).toHaveLength(5);
      const [meatForm, meatAttachment, brandAttachment, noticeForm, noticeAttachment] = pages as [string, string, string, string, string];
      for (const form of [meatForm, noticeForm]) {
        expect(form).toContain('公账付款单');
        expect(form).toContain(`付款单位：${UNIT}`);
        expect(form).not.toContain('费用报销单');
        expect(form).not.toContain('报销部门');
      }
      // 第 1 张：两行项目；备注栏写两家收款方的户名、开户银行、银行账号（账号原样、一位不差）
      expect(meatForm).toContain('肉款');
      expect(meatForm).toContain('品牌管理费');
      // 金额栏的合计是按「分」一格一位写的：12909.49 + 6785.00 = 19694.49 → 1969449；通知单 39561.63 → 3956163
      expect(meatForm).toContain('合计1969449');
      for (const part of ['收款户名：示例食品销售有限公司', '开户银行：示例银行上海分行', `银行账号：${MEAT_ACCOUNT}`, '收款户名：示例品牌管理有限公司', '开户银行：示例银行武汉分行', `银行账号：${BRAND_ACCOUNT}`]) {
        expect(meatForm).toContain(part);
      }
      // 第 2 张：通知单的五项各一行，项目名带费用月份（水电、空调能源费是上个月的）
      for (const part of ['店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）', '电费（2026年7月）', '空调能源费（2026年7月）', '合计3956163', '收款户名：示例商业管理有限公司', `银行账号：${NOTICE_ACCOUNT}`]) {
        expect(noticeForm).toContain(part);
      }
      expect(meatAttachment).toContain('第1张付款单');
      expect(brandAttachment).toContain('第1张付款单');
      expect(noticeAttachment).toContain('第2张付款单');
      expect(noticeAttachment).toContain('含5项');

      // ---- 历史付款单 ----
      await page.getByRole('button', { name: '历史付款单', exact: true }).click();
      await expect(page.getByRole('heading', { name: '历史付款单' })).toBeVisible();
      await expect(page.getByText('合计：59256.12', { exact: false })).toBeVisible();
      await expect(page.getByRole('link', { name: '已保存 PDF' })).toBeVisible();
      await expect(page.getByText('退款凭证')).toHaveCount(0);
      await expectCompanyWords(page);

      // ---- 回到店内：公账的付款单和回单一样都看不到，店内那张凭证还在 ----
      await ledgers.getByRole('button', { name: '店内报销' }).click();
      await expect(page).toHaveURL(/#history$/);
      await expect(page.getByRole('heading', { name: '历史报销单' })).toBeVisible();
      await expect(page.getByText('暂无历史报销单。')).toBeVisible();
      await page.getByRole('button', { name: '本期报销池', exact: true }).click();
      await expect(page.getByText('可报销笔数：1', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '食材 · 120.00' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '肉款 · 12909.49' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '含 5 项 · 39561.63' })).toHaveCount(0);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(page.getByLabel('部门')).toBeVisible();
      await expect(page.getByLabel('公账付款单位')).toHaveCount(0);

      // 接口层面：两个区的池、汇总、历史各是各的
      const storePool = await json<Receipt[]>(await fetch(`${runtime.baseUrl}/api/receipts?view=pool`));
      expect(storePool.map((receipt) => receipt.category)).toEqual(['食材']);
      const companyPool = await json<Receipt[]>(await fetch(`${runtime.baseUrl}/api/receipts?view=pool&ledger=company`));
      expect(companyPool).toHaveLength(0);
      const storeTotals = await json<Totals>(await fetch(`${runtime.baseUrl}/api/pool/totals`));
      expect(storeTotals.count).toBe(1);
      const storeHistory = await json<HistoryMonth[]>(await fetch(`${runtime.baseUrl}/api/history`));
      expect(storeHistory.flatMap((month) => month.batches)).toHaveLength(0);
      const companyHistory = await json<HistoryMonth[]>(await fetch(`${runtime.baseUrl}/api/history?ledger=company`));
      expect(companyHistory.flatMap((month) => month.batches).map((item) => item.id)).toEqual([batch.id]);
    } finally {
      await runtime.close();
    }
  });

  test('同一张图传到另一个区会被拦下，并说明它已经在哪个区', async ({ page }) => {
    const runtime = await createFixtureRuntime();
    try {
      await routeApiToRuntime(page, runtime);
      await page.goto('/#company/upload');
      await page.getByLabel('选择回单图片').setInputFiles('e2e/fixtures/images/company-meat.png');
      await expect(page.getByText('识别中：0', { exact: true })).toBeVisible();

      // 店内再传同一张图：不是重复进店内池，而是被拦下，并说明已经在公账里
      await page.getByRole('group', { name: '切换区域' }).getByRole('button', { name: '店内报销' }).click();
      await expect(page.getByRole('heading', { name: '上传凭证' })).toBeVisible();
      await page.getByLabel('选择凭证图片').setInputFiles('e2e/fixtures/images/company-meat.png');
      await expect(page.getByRole('list', { name: '被拒绝文件' })).toContainText('重复文件（已在「公账付款」里）');
      await page.getByRole('button', { name: '本期报销池', exact: true }).click();
      await expect(page.getByText('可报销笔数：0', { exact: true })).toBeVisible();
    } finally {
      await runtime.close();
    }
  });
});

// 手机上看公账的对账页：试点时手机上对账看不全、报销单加载失败，这里把公账版按手机宽度和 Safari 替身走一遍
test.describe('公账对账页（手机）', () => {
  const PHONE = { width: 390, height: 664 };
  let runtime: FixtureRuntime;
  let batchId = '';

  test.beforeAll(async () => {
    runtime = await createFixtureRuntime();
    const pool = await seedCompanyPool(runtime);
    const created = await json<Batch>(await fetch(`${runtime.baseUrl}/api/batches`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        receiptIds: pool.map((receipt) => receipt.id),
        options: { department: UNIT, date: '2026-09-30', signerMode: 'text', signerName: '验收经办人', signature: null },
      }),
    }));
    expect(created.ledger).toBe('company');
    batchId = created.id;
  });

  test.afterAll(async () => {
    await runtime.close();
  });

  test.beforeEach(async ({ page }) => {
    await pretendToBeSafari(page);
    await routeApiToRuntime(page, runtime);
    await page.setViewportSize(PHONE);
  });

  test('顶部的区域切换和导航在手机上够得着，页面不横向溢出', async ({ page }) => {
    await page.goto(`/#company/batches/${batchId}/preview`);
    await expect(page.getByRole('heading', { name: '付款单预览' })).toBeVisible();

    const ledgers = page.getByRole('group', { name: '切换区域' });
    await expect(ledgers.getByRole('button', { name: '店内报销' })).toBeVisible();
    await expect(ledgers.getByRole('button', { name: '公账付款' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '主导航' });
    for (const name of ['上传回单', '本期付款池', '待处理', '付款单预览', '历史付款单', '设置']) {
      const item = nav.getByRole('button', { name, exact: true });
      await item.scrollIntoViewIfNeeded();
      await expect(item).toBeVisible();
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('回单标签下图和收款方都看得到，清单按行列出通知单的五项，付款单标签里画出两张付款单', async ({ page }) => {
    await page.goto(`/#company/batches/${batchId}/preview`);

    const tabs = page.getByRole('group', { name: '对账视图' });
    await expect(tabs.getByRole('button')).toHaveText(['回单', '清单', '付款单']);
    await expect(tabs.getByRole('button', { name: '回单', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const firstImage = page.getByRole('img', { name: /^回单 1：/ });
    await expect(firstImage).toBeVisible();
    await expect.poll(() => firstImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);

    // 收款方就在图旁边，三项齐全，不被屏幕切掉
    const payee = page.getByRole('group', { name: '收款方信息' });
    await expect(payee).toContainText('收款户名');
    await expect(payee).toContainText('银行账号');
    await expect(payee).toContainText(MEAT_ACCOUNT);
    const box = await payee.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    // 清单：每个费用月份各一行，金额按行
    await tabs.getByRole('button', { name: '清单', exact: true }).click();
    const list = page.getByRole('region', { name: '对账清单' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('heading', { name: '第 2 张付款单' })).toBeVisible();
    for (const label of ['店面租金（2026年9月）', '物业费（2026年9月）', '水费（2026年7月）', '电费（2026年7月）', '空调能源费（2026年7月）']) {
      await expect(list.getByText(label, { exact: true })).toBeVisible();
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    // 点通知单里电费的金额：切回「回单」看这张通知单，说明里列出五项
    await list.getByRole('button', { name: '11466.87（电费（2026年7月） 第 1/1 张）' }).click();
    await expect(tabs.getByRole('button', { name: '回单', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.attachment-title')).toContainText('第 2 张付款单 · 本张回单 39561.63，含 5 项');
    await expect(page.getByRole('group', { name: '收款方信息' })).toContainText(NOTICE_ACCOUNT);

    // 「付款单」标签：付款单原样第一次点开才加载，这里在缺 for-await 的 Safari 替身里照样画出两张
    await tabs.getByRole('button', { name: '付款单', exact: true }).click();
    await expect(page.getByRole('region', { name: '付款单原样' }).locator('canvas')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});
