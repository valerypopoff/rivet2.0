import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('request-count baseline: dashboard and editor cold browser startup', async ({ page }, testInfo) => {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', folders: [], projects: [], sync: { epoch: 'request-count', revision: 0 } },
    }),
  );
  const requests: string[] = [];
  const base = process.env.PLAYWRIGHT_BASE_URL!;
  page.on('request', (request) => {
    if (new URL(request.url()).origin === new URL(base).origin) requests.push(request.url());
  });
  const start = Date.now();
  await page.goto('/');
  await waitForDashboardReady(page);
  const generation = await page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')?.content ?? null,
  );
  const mode = generation ? 'tunnel' : 'live';
  const result = {
    mode,
    startupMs: Date.now() - start,
    sameOriginRequests: requests.length,
    sourceModuleRequests: requests.filter((url) => /\.tsx?(?:\?|$)|\/@vite\//.test(url)).length,
  };
  if (mode === 'tunnel') expect(result.sourceModuleRequests).toBe(0);
  else expect(result.sourceModuleRequests).toBeGreaterThan(0);
  const directory = path.resolve('../../artifacts/tunnel-browser-measurements');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${mode}.json`), JSON.stringify(result, null, 2));
  await testInfo.attach('browser-startup', { body: JSON.stringify(result), contentType: 'application/json' });
  console.log(`[tunnel-browser-measurement] ${JSON.stringify(result)}`);
});
