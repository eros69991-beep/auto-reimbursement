import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'pnpm exec tsx e2e/start-api.ts',
      url: 'http://127.0.0.1:3100/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @auto-reimbursement/web exec vite --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      env: { API_PROXY_TARGET: 'http://127.0.0.1:3100' },
      reuseExistingServer: false,
    },
  ],
});
