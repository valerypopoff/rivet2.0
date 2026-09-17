import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Debug context nodes appear with their outputs and documentation in the editor', async ({ page }) => {
  const suffix = String(Date.now());
  const projectPath = `/workflows/Graph Call Path ${suffix}.rivet-project`;
  await seedHostedEditorProject(page, {
    graphId: `graph-call-path-${suffix}-graph`,
    loaded: true,
    projectId: `graph-call-path-${suffix}-project`,
    projectPath,
    title: `Graph Call Path ${suffix}`,
  });
  await page.route('**/api/config', (route) => route.fulfill({
    json: {
      executorWsUrl: 'ws://127.0.0.1:8081/ws/executor/internal',
      remoteDebuggerDefaultWs: 'ws://127.0.0.1:8081/ws/latest-debugger',
      publishedWorkflowsBasePath: '/workflows',
      latestWorkflowsBasePath: '/workflows-latest',
      publishedAppsBasePath: '/apps',
      latestAppsBasePath: '/apps-latest',
      webAppsAuthMode: 'ui-gate',
    },
  }));
  await page.route('**/api/workflows/evaluation-runs/library', (route) => route.fulfill({
    json: {
      revision: 0,
      resourceVersions: { suites: {}, datasets: {} },
      library: {
        version: 1,
        data: { version: 1, suites: [], baselines: [] },
        datasets: [],
        migratedLegacyProjectIds: [],
      },
    },
  }));
  await page.route('**/api/workflows/tree', (route) => route.fulfill({
    json: {
      root: '/workflows',
      sync: { epoch: 'graph-call-path', revision: 0 },
      folders: [],
      projects: [{
        id: `graph-call-path-${suffix}-project`,
        name: `Graph Call Path ${suffix}`,
        fileName: `Graph Call Path ${suffix}.rivet-project`,
        relativePath: `Graph Call Path ${suffix}.rivet-project`,
        absolutePath: projectPath,
        updatedAt: '2026-09-15T00:00:00.000Z',
        settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
      }],
    },
  }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvas = editor.locator('.node-canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await canvas.click({ button: 'right', position: { x: 320, y: 260 } });

  const labels = editor.locator('.context-menu-items .context-menu-label-text');
  await labels.filter({ hasText: /^Add node$/ }).click();
  await expect(labels.filter({ hasText: /^Debug$/ })).toHaveCount(1);
  const search = editor.getByPlaceholder('Type in node name...');
  await search.fill('Graph Call Path');
  await labels.filter({ hasText: /^Graph Call Path$/ }).click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Graph Call Path$/ }),
  });
  await expect(node).toHaveCount(1);
  await expect(node.locator('.node-title svg.debug-node-title-icon')).toBeVisible();
  await expect(node.locator('.port-label', { hasText: /^Current Graph Name$/ })).toHaveCount(1);
  await expect(node.locator('.port-label', { hasText: /^Graph Path$/ })).toHaveCount(1);
  await node.locator('.node-title').click();
  await expect(editor.locator('.node-doc-link')).toHaveAttribute(
    'href',
    'https://valerypopoff.github.io/rivet2.0/node-reference/graph-call-path',
  );

  await editor.locator('button.more-menu').click();
  const debuggerMenuItem = editor.getByRole('button', { name: 'Remote Debugger' });
  await expect(debuggerMenuItem).toBeVisible();
  const titleIconPath = await node.locator('.debug-node-title-icon path').getAttribute('d');
  const debuggerIconPath = await debuggerMenuItem.locator('svg path').getAttribute('d');
  expect(titleIconPath).toBe(debuggerIconPath);

  await canvas.click({ button: 'right', position: { x: 620, y: 260 } });
  await labels.filter({ hasText: /^Add node$/ }).click();
  await expect(labels.filter({ hasText: /^Debug$/ })).toHaveCount(1);
  await search.fill('Project Name');
  await labels.filter({ hasText: /^Project Name$/ }).click();

  const projectNameNode = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Project Name$/ }),
  });
  await expect(projectNameNode).toHaveCount(1);
  await expect(projectNameNode.locator('.node-title svg.debug-node-title-icon')).toBeVisible();
  await expect(projectNameNode.locator('.port-label', { hasText: /^Project Name$/ })).toHaveCount(1);
});
