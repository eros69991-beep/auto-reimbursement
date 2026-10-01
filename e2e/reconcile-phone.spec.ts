import { readFile } from 'node:fs/promises';

import type { Batch } from '@auto-reimbursement/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { createFixtureRuntime, type FixtureRuntime } from './fixture-runtime.ts';
import { pretendToBeSafari } from './safari.ts';

// 试点反馈 Task 6/7：手机上对账看不全、报销单预览加载失败。
// 这里用真实接口造一份报销单（含一张由两张截图合并的凭证），在真实浏览器里按手机和电脑两种尺寸走一遍对账页。

const PHONE = { width: 390, height: 664 };
const DESKTOP = { width: 1280, height: 800 };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface Seeded {
  batchId: string;
  mergedId: string;
  /** 合并凭证里每张截图在拼图里的位置，占整张图宽度的比例 */
  panels: Array<{ left: number; width: number }>;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url} → ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function seedBatch(runtime: FixtureRuntime): Promise<Seeded> {
  const base = runtime.baseUrl;
  const files = ['normal-01.png', 'normal-02.png', 'normal-06.png', 'normal-04.png', 'normal-05.png'];
  const form = new FormData();
  for (const name of files) {
    form.append('files', new Blob([await readFile(`e2e/fixtures/images/${name}`)], { type: 'image/png' }), name);
  }
  const uploaded = await json<{ accepted: Array<{ id: string }> }>(
    await fetch(`${base}/api/receipts/upload`, { method: 'POST', body: form }),
  );
  expect(uploaded.accepted).toHaveLength(files.length);
  const ids = uploaded.accepted.map((receipt) => receipt.id);
  const [food, supplies, energy, meat, drink] = ids as [string, string, string, string, string];

  // 假识别按图片内容给出固定结果：5 张都进报销池
  await expect.poll(async () => (await json<unknown[]>(await fetch(`${base}/api/receipts?view=pool`))).length).toBe(files.length);

  // 把最后两张（同一单的两张截图）合并成一张
  const merged = await json<{ id: string }>(await fetch(`${base}/api/receipts/merge`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ receiptIds: [meat, drink] }),
  }));
  // 拼图不在假识别的样本里，识别失败后进「待处理」；像真人一样手动确认金额和分类
  await expect.poll(async () => {
    const pending = await json<Array<{ id: string; status: string }>>(await fetch(`${base}/api/receipts?view=pending`));
    return pending.find((receipt) => receipt.id === merged.id)?.status;
  }).toBe('pending');
  await json(await fetch(`${base}/api/receipts/${merged.id}/confirm`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ paidFen: 13400, category: '食材' }),
  }));

  const created = await json<Batch>(await fetch(`${base}/api/batches`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      receiptIds: [food, supplies, energy, merged.id],
      options: { department: '验收部门', date: '2026-09-30', signerMode: 'text', signerName: '验收人', signature: null },
    }),
  }));
  const item = created.items.find((candidate) => candidate.receiptId === merged.id);
  const panels = item?.original.panels;
  expect(panels, '合并凭证应当记下每张截图的位置').toHaveLength(2);
  const imageWidth = item!.original.width;
  return {
    batchId: created.id,
    mergedId: merged.id,
    panels: panels!.map((panel) => ({ left: panel.left / imageWidth, width: panel.width / imageWidth })),
  };
}

async function routeApiToRuntime(page: Page, runtime: FixtureRuntime): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const original = new URL(route.request().url());
    await route.continue({ url: `${runtime.baseUrl}${original.pathname}${original.search}` });
  });
}

/** 凭证图当前的显示情况：容器宽、图宽、横向滚动位置 */
async function viewerMetrics(scroller: Locator): Promise<{ container: number; image: number; scrollLeft: number }> {
  return scroller.evaluate((element) => {
    const image = element.querySelector('img');
    return {
      container: element.clientWidth,
      image: image === null ? 0 : image.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('对账页（试点反馈 Task 6/7）', () => {
  let runtime: FixtureRuntime;
  let seeded: Seeded;

  test.beforeAll(async () => {
    runtime = await createFixtureRuntime();
    seeded = await seedBatch(runtime);
  });

  test.afterAll(async () => {
    await runtime.close();
  });

  // 用户的手机和 Mac 用的都是 Safari，而 Safari（到 26）的 ReadableStream 不能 for await：
  // 报销单预览曾因此在 Safari 上全部加载失败，Chromium 里却一切正常。这里让页面也缺这项功能。
  test.beforeEach(async ({ page }) => {
    await pretendToBeSafari(page);
  });

  test('替身自检：页面里的 ReadableStream 确实不能 for await，和 Safari 26 一样', async ({ page }) => {
    await page.goto('/');
    const outcome = await page.evaluate(async () => {
      const stream = new ReadableStream({ start: (controller) => controller.close() });
      try {
        for await (const chunk of stream as unknown as AsyncIterable<unknown>) void chunk;
        return 'iterated';
      } catch (error) {
        return error instanceof Error ? error.name : 'other';
      }
    });
    expect(outcome).toBe('TypeError');
  });

  test('手机：凭证占满剩下的屏幕，标签一次只显示一块，合并凭证逐张截图对准，可全屏', async ({ page }) => {
    await routeApiToRuntime(page, runtime);
    await page.setViewportSize(PHONE);
    const previewRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/preview.pdf')) previewRequests.push(request.url());
    });
    await page.goto(`/#batches/${seeded.batchId}/preview`);

    // 默认看「凭证」，图片真的加载出来了
    const tabs = page.getByRole('group', { name: '对账视图' });
    await expect(tabs.getByRole('button', { name: '凭证', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const firstImage = page.getByRole('img', { name: /^凭证 1：/ });
    await expect(firstImage).toBeVisible();
    await expect.poll(() => firstImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);

    // 凭证图区至少占视口高度的一半（旧版只有 140–240px，一张图只露出一条）
    const scroller = page.locator('.attachment-viewer .attachment-image-scroll');
    const viewerBox = await scroller.boundingBox();
    expect(viewerBox!.height).toBeGreaterThanOrEqual(PHONE.height * 0.45);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    // 报销单预览要等第一次点开「报销单」才开始下载，先把带宽留给凭证图（等网络静下来再查，免得只是还没来得及发）
    await page.waitForLoadState('networkidle');
    expect(previewRequests).toHaveLength(0);

    // 「清单」：整屏只显示清单，凭证图收起来
    await tabs.getByRole('button', { name: '清单', exact: true }).click();
    await expect(page.getByRole('region', { name: '对账清单' })).toBeVisible();
    await expect(firstImage).toBeHidden();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    // 点合并凭证的金额：直接切到「凭证」，并从第 1 张截图看起
    await page.getByRole('button', { name: '134.00（食材 第 2/2 张）' }).click();
    await expect(tabs.getByRole('button', { name: '凭证', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.attachment-title')).toHaveText(/食材 第 2\/2 张 · 本张 134\.00/);
    const panelButtons = page.getByRole('group', { name: '合并的截图' });
    await expect(panelButtons.getByRole('button', { name: '截图 1' })).toHaveAttribute('aria-pressed', 'true');

    // 每张截图都撑满屏幕宽，并且滚动位置正好对在那张的左边缘
    const mergedImage = page.getByRole('img', { name: /^凭证 \d：食材 134\.00/ });
    await expect.poll(() => mergedImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    for (const [index, panel] of seeded.panels.entries()) {
      await panelButtons.getByRole('button', { name: `截图 ${index + 1}` }).click();
      await expect(panelButtons.getByRole('button', { name: `截图 ${index + 1}` })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => {
        const metrics = await viewerMetrics(scroller);
        return {
          imageWidthOk: Math.abs(metrics.image - metrics.container / panel.width) <= 2,
          scrollLeftOk: Math.abs(metrics.scrollLeft - panel.left * metrics.image) <= 2,
        };
      }, { message: `截图 ${index + 1} 没有对准` }).toEqual({ imageWidthOk: true, scrollLeftOk: true });
    }
    // 「整图」：整张拼图适宽，从最左边看起
    await panelButtons.getByRole('button', { name: '整图' }).click();
    await expect.poll(async () => {
      const metrics = await viewerMetrics(scroller);
      return { wide: Math.abs(metrics.image - metrics.container) <= 2, scrollLeft: metrics.scrollLeft };
    }).toEqual({ wide: true, scrollLeft: 0 });

    // 手机上行内工具栏不放缩放按钮，放大缩小在「全屏查看」里：盖满整个屏幕
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeHidden();
    const fullscreenButton = page.getByRole('button', { name: '全屏查看' });
    await fullscreenButton.click();
    const dialog = page.getByRole('dialog', { name: '凭证大图' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img', { name: /^凭证 \d：食材 134\.00/ })).toBeVisible();
    // 盖满整个屏幕（桌面浏览器里页面常驻的那条滚动条槽，最多 20px，不算）
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox!.width).toBeGreaterThanOrEqual(PHONE.width - 20);
    expect(dialogBox!.height).toBeGreaterThanOrEqual(PHONE.height - 1);

    // 放大真的会变大（全局 max-width: 100% 曾让放大在真实浏览器里没有效果），「适宽」回到原样
    const fullscreenScroller = dialog.locator('.attachment-image-scroll');
    await expect.poll(async () => (await viewerMetrics(fullscreenScroller)).image).toBeGreaterThan(0);
    const fitted = (await viewerMetrics(fullscreenScroller)).image;
    await dialog.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(async () => (await viewerMetrics(fullscreenScroller)).image).toBeGreaterThan(fitted * 1.2);
    await dialog.getByRole('button', { name: '恢复适宽' }).click();
    await expect.poll(async () => (await viewerMetrics(fullscreenScroller)).image).toBe(fitted);

    // Esc 关闭，焦点回到「全屏查看」按钮
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(fullscreenButton).toBeFocused();

    // 第一次点开「报销单」才开始加载预览；窄屏上按至少 960px 宽画，横向滑动看
    await tabs.getByRole('button', { name: '报销单', exact: true }).click();
    const formCanvas = page.locator('canvas[data-sheet-index="0"]');
    await expect(formCanvas).toBeVisible({ timeout: 20_000 });
    expect(previewRequests.length).toBeGreaterThan(0);
    expect((await formCanvas.boundingBox())!.width).toBeGreaterThanOrEqual(900);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('手机：凭证图和报销单预览加载失败时说明原因，点「重试」后恢复', async ({ page }) => {
    await routeApiToRuntime(page, runtime);
    // 后注册的路由先生效；断网或服务器出错期间在这里拦下，恢复后交给上面的通用路由放行
    let imageBroken = true;
    let previewBroken = true;
    await page.route('**/original-image**', async (route) => {
      if (imageBroken) await route.abort('connectionreset');
      else await route.fallback();
    });
    await page.route('**/preview.pdf**', async (route) => {
      if (previewBroken) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'upstream unavailable' });
      } else {
        await route.fallback();
      }
    });
    await page.setViewportSize(PHONE);
    await page.goto(`/#batches/${seeded.batchId}/preview`);

    // 凭证图：断网时说原因、给「重试」；恢复后点重试就看到图
    const imageAlert = page.getByRole('alert').filter({ hasText: '凭证图片加载失败' });
    await expect(imageAlert).toContainText('无法连接服务器');
    imageBroken = false;
    await imageAlert.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('img', { name: /^凭证 1：/ })).toBeVisible();

    // 报销单预览：服务器暂时没有响应时说原因（带状态码）、给「重试」和技术细节；恢复后点重试就画出来
    await page.getByRole('group', { name: '对账视图' }).getByRole('button', { name: '报销单', exact: true }).click();
    const previewAlert = page.locator('.pdf-preview-error');
    await expect(previewAlert).toContainText('服务器暂时没有响应（503）');
    await expect(previewAlert.getByText('技术细节')).toBeVisible();
    previewBroken = false;
    await previewAlert.getByRole('button', { name: '重试' }).click();
    await expect(page.locator('canvas[data-sheet-index="0"]')).toBeVisible({ timeout: 20_000 });
    await expect(previewAlert).toBeHidden();
  });

  test('电脑：清单、报销单、凭证图同屏，没有手机用的标签和全屏按钮', async ({ page }) => {
    await routeApiToRuntime(page, runtime);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/#batches/${seeded.batchId}/preview`);

    await expect(page.getByRole('region', { name: '对账清单' })).toBeVisible();
    await expect(page.getByRole('img', { name: /^凭证 1：/ })).toBeVisible();
    await expect(page.locator('canvas[data-sheet-index="0"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('group', { name: '对账视图' })).toBeHidden();
    await expect(page.getByRole('button', { name: '全屏查看' })).toBeHidden();

    // 点清单里的金额，右边切到那张凭证
    await page.getByRole('button', { name: '134.00（食材 第 2/2 张）' }).click();
    await expect(page.getByRole('img', { name: /^凭证 \d：食材 134\.00/ })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});
