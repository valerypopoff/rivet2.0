import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('proxy serves the authenticated dashboard and hosted editor', async ({ page }) => {
  await seedHostedEditorProject(page, {
    graphId: 'proxy-routing-graph',
    projectId: 'proxy-routing-project',
    projectPath: '/workflows/proxy-routing.rivet-project',
    title: 'Proxy routing fixture',
    loaded: true,
  });
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.frameLocator('iframe.dashboard-editor-frame').locator('.node-canvas')).toBeVisible({
    timeout: 60000,
  });
  const api = await page.request.get('/api/workflows/tree');
  expect(api.status()).toBe(200);
  expect(api.headers()['content-type']).toContain('application/json');
});
