import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Graph-list filter', () => {
  test('opens from the Graphs heading and closes without leaving a stale filter', async ({ page }) => {
    const suffix = String(Date.now());
    const projectId = `graph-list-filter-${suffix}-project`;
    const projectPath = `/workflows/Graph list filter ${suffix}.rivet-project`;
    const alphaGraphId = `graph-list-filter-${suffix}-alpha`;
    const betaGraphId = `graph-list-filter-${suffix}-beta`;

    await seedHostedEditorProject(page, {
      extraGraphs: [
        { id: alphaGraphId, name: 'Alpha workflow' },
        { id: betaGraphId, name: 'Beta workflow' },
      ],
      graphId: `graph-list-filter-${suffix}-main`,
      loaded: true,
      projectId,
      projectPath,
      title: `Graph list filter ${suffix}`,
    });

    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          folders: [],
          projects: [
            {
              absolutePath: projectPath,
              fileName: `Graph list filter ${suffix}.rivet-project`,
              id: projectId,
              name: `Graph list filter ${suffix}`,
              relativePath: `Graph list filter ${suffix}.rivet-project`,
              settings: {
                endpointName: '',
                lastPublishedAt: null,
                publishedWebApps: [],
                status: 'unpublished',
              },
              updatedAt: '2026-09-16T00:00:00.000Z',
            },
          ],
          root: '/workflows',
          sync: { epoch: 'graph-list-filter', revision: 0 },
        },
      }),
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const filterButton = editor.getByRole('button', { name: 'Filter graphs' });
    const heading = editor.getByText('Graphs', { exact: true });
    const alphaGraph = editor.locator(`[data-graphid="${alphaGraphId}"]`);
    const betaGraph = editor.locator(`[data-graphid="${betaGraphId}"]`);

    await expect(heading).toBeVisible({ timeout: 120_000 });
    await expect(filterButton).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Filter graphs' })).toHaveCount(0);

    await filterButton.hover();
    await expect(editor.locator('.tooltip-enter-done .box').getByText('Filter graphs', { exact: true })).toBeVisible();

    await filterButton.click();
    const filterInput = editor.getByRole('textbox', { name: 'Filter graphs' });
    await expect(heading).toHaveCount(0);
    await expect(filterInput).toBeFocused();
    await expect(editor.getByRole('button', { name: 'Close graph filter' })).toBeVisible();

    await filterInput.fill('Alpha');
    await expect(alphaGraph).toBeVisible();
    await expect(betaGraph).toBeHidden();

    await editor.getByRole('button', { name: 'Close graph filter' }).click();
    await expect(heading).toBeVisible();
    await expect(filterInput).toHaveCount(0);
    await expect(alphaGraph).toBeVisible();
    await expect(betaGraph).toBeVisible();

    await filterButton.click();
    await filterInput.fill('Beta');
    await filterInput.press('Escape');
    await expect(heading).toBeVisible();
    await expect(alphaGraph).toBeVisible();
    await expect(betaGraph).toBeVisible();
  });
});
