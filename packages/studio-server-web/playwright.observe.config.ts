import { defineConfig } from '@playwright/test';

const slowMo = Number.parseInt(process.env.PLAYWRIGHT_SLOW_MO ?? '300', 10);
const headless = process.env.PLAYWRIGHT_HEADLESS === '1';

export default defineConfig({
  testDir: './playwright-observe',
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  outputDir: '../../artifacts/playwright/test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../artifacts/playwright/report' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8080',
    headless,
    trace: 'on',
    video: 'on',
    screenshot: 'only-on-failure',
    viewport: {
      width: 1600,
      height: 1000,
    },
    launchOptions: {
      slowMo: Number.isFinite(slowMo) ? slowMo : 300,
    },
  },
  projects: [
    {
      name: 'chromium-observe',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
