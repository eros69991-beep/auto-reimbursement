import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    // 本地用系统 Chrome；CI 没有安装 Chrome，改用 Playwright 自带的 chromium
    channel: process.env.CI ? undefined : 'chrome',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @auto-reimbursement/web exec vite --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
    },
  ],
});
