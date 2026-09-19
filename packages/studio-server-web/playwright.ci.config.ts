import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(webRoot, '../..');
const port = Number.parseInt(process.env.PLAYWRIGHT_CI_PORT ?? '5174', 10);
const baseURL = `http://127.0.0.1:${Number.isFinite(port) ? port : 5174}`;

export default defineConfig({
  testDir: './playwright-observe',
  testMatch: ['fullscreen-output-search-paging.spec.ts', 'sidebar-name-wrapping.spec.ts'],
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  outputDir: '../../artifacts/playwright/ci-test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../artifacts/playwright/ci-report' }],
  ],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: {
      width: 1600,
      height: 1000,
    },
  },
  webServer: {
    command:
      'node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-web run dev -- --host 127.0.0.1 --strictPort',
    cwd: workspaceRoot,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium-ci',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
