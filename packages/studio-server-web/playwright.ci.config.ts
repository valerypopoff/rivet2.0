import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(webRoot, '../..');
const port = Number.parseInt(process.env.PLAYWRIGHT_CI_PORT ?? '5174', 10);
const baseURL = `http://127.0.0.1:${Number.isFinite(port) ? port : 5174}`;

export default defineConfig({
  testDir: './playwright-observe',
  testMatch: [
    'fullscreen-output-search-paging.spec.ts',
    'hosted-dashboard-contracts.spec.ts',
    'project-bundle.spec.ts',
    'sidebar-name-wrapping.spec.ts',
    'streaming-nodes.spec.ts',
    'project-tree-activation.spec.ts',
    'node-editor-ownership.spec.ts',
    'node-editor-lifecycle.spec.ts',
    'llm-temperature.spec.ts',
  ],
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  // Files own browser contexts, mocked APIs and temporary artifacts. Preserve
  // serial scenarios within each file; use two independent files per runner.
  workers: 2,
  outputDir: '../../artifacts/playwright/ci-test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../artifacts/playwright/ci-report' }]],
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
    // CI restores this same-commit build before running the browser lane. Do
    // not rebuild through HMR or flood each isolated context with source modules.
    command: `node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-web run preview --host 127.0.0.1 --port ${port} --strictPort`,
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
