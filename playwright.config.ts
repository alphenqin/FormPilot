import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  use: { trace: 'retain-on-failure', channel: 'chromium' },
  webServer: [
    {
      command: 'pnpm --filter @formpilot/web dev',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
    },
  ],
});
