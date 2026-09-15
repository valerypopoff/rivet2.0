import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.describe('Graph-folder bulk expansion', () => {
  test('Control-click or Command-click applies a folder\'s next state to every folder', async ({ page }) => {
    const suffix = String(Date.now());
    const projectId = `graph-folder-bulk-toggle-${suffix}-project`;
    const projectPath = `/workflows/Graph folder bulk toggle ${suffix}.rivet-project`;

    await seedHostedEditorProject(page, {
      extraGraphs: [
        { id: `graph-folder-bulk-toggle-${suffix}-alpha`, name: 'Alpha/First' },
        { id: `graph-folder-bulk-toggle-${suffix}-nested`, name: 'Alpha/Nested/Deep' },
        { id: `graph-folder-bulk-toggle-${suffix}-beta`, name: 'Beta/Second' },
      ],
      graphId: `graph-folder-bulk-toggle-${suffix}-main`,
      loaded: true,
      projectId,
      projectPath,
      title: `Graph folder bulk toggle ${suffix}`,
    });

    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          folders: [],
          projects: [
            {
              absolutePath: projectPath,
              fileName: `Graph folder bulk toggle ${suffix}.rivet-project`,
              id: projectId,
              name: `Graph folder bulk toggle ${suffix}`,
              relativePath: `Graph folder bulk toggle ${suffix}.rivet-project`,
              settings: {
                endpointName: '',
                lastPublishedAt: null,
                publishedWebApps: [],
                status: 'unpublished',
              },
              updatedAt: '2026-09-15T00:00:00.000Z',
            },
          ],
          root: '/workflows',
          sync: { epoch: 'graph-folder-bulk-toggle', revision: 0 },
        },
      }),
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const alphaFolder = editor.locator('[data-folderpath="Alpha"] .graph-item-select');
    const betaFolder = editor.locator('[data-folderpath="Beta"] .graph-item-select');
    const nestedFolder = editor.locator('[data-folderpath="Alpha/Nested"]');
    const nestedFolderControl = nestedFolder.locator('.graph-item-select');
    const alphaGraph = editor.locator(`[data-graphid="graph-folder-bulk-toggle-${suffix}-alpha"]`);
    const betaGraph = editor.locator(`[data-graphid="graph-folder-bulk-toggle-${suffix}-beta"]`);

    await expect(alphaFolder).toBeVisible({ timeout: 120_000 });
    await expect(betaFolder).toBeVisible();
    await expect(nestedFolder).toBeVisible();
    await expect(alphaGraph).toBeVisible();
    await expect(betaGraph).toBeVisible();

    const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await nestedFolderControl.click({ modifiers: [primaryModifier] });
    await expect(nestedFolder).toBeHidden();
    await expect(alphaGraph).toBeHidden();
    await expect(betaGraph).toBeHidden();

    // On macOS this is the normal Command gesture. Elsewhere it proves that
    // the same browser metaKey event opens every folder.
    await betaFolder.click({ modifiers: ['Meta'] });
    await expect(nestedFolder).toBeVisible();
    await expect(alphaGraph).toBeVisible();
    await expect(betaGraph).toBeVisible();
  });
});
