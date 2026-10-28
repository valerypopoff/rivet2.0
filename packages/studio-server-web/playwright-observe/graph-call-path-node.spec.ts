import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Debug context nodes appear with their outputs and documentation in the editor', async ({ page }) => {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'Isolated editor fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  const suffix = String(Date.now());
  const projectPath = `/workflows/Graph Call Path ${suffix}.rivet-project`;
  await seedHostedEditorProject(page, {
    graphId: `graph-call-path-${suffix}-graph`,
    loaded: true,
    projectId: `graph-call-path-${suffix}-project`,
    projectPath,
    title: `Graph Call Path ${suffix}`,
    graph: {
      nodes: [
        {
          id: 'excluded-preview',
          type: 'text',
          title: 'Excluded output',
          disabled: true,
          visualData: { x: 30, y: 500, width: 200 },
          data: { text: 'Must not appear as an executed value' },
        },
      ],
    },
  });
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'graph-call-path', revision: 0 },
        folders: [],
        projects: [
          {
            id: `graph-call-path-${suffix}-project`,
            name: `Graph Call Path ${suffix}`,
            fileName: `Graph Call Path ${suffix}.rivet-project`,
            relativePath: `Graph Call Path ${suffix}.rivet-project`,
            absolutePath: projectPath,
            updatedAt: '2026-09-15T00:00:00.000Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
      },
    }),
  );

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
  await editor.locator('button.more-menu').click();

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

  await canvas.click({ position: { x: 350, y: 480 } });
  await canvas.click({ button: 'right', position: { x: 350, y: 480 }, timeout: 10_000 });
  // The Add node search is retained when reopening this menu.
  await expect(search).toBeVisible();
  await search.fill('AI Cost');
  await labels.filter({ hasText: /^AI Cost$/ }).click();
  const costNode = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^AI Cost$/ }),
  });
  await expect(costNode).toHaveCount(1);
  await expect(costNode.locator('.debug-node-title-icon')).toBeVisible();
  await expect(costNode.locator('.input-ports .port-label')).toHaveCount(0);
  await expect(costNode.locator('.conditional-if-port')).toHaveCount(0);
  await expect(costNode.locator('.output-ports .port-label')).toHaveText(['LLM cost', 'Decision AI cost', 'Sum cost']);
  await expect(costNode.locator('.node-body')).toContainText('Observed AI estimates (USD)');
  await expect(costNode.locator('.node-body')).toContainText('Current project subtree');
  await costNode.locator('.node-title').click();
  await expect(editor.locator('.node-doc-link')).toHaveAttribute(
    'href',
    'https://valerypopoff.github.io/rivet2.0/node-reference/ai-cost',
  );
  await editor.getByText('Conditional node', { exact: true }).click();
  await expect(costNode.locator('.conditional-if-port')).toBeVisible();
  await expect(costNode.locator('.input-ports .port-label')).toHaveCount(0);
  await editor.getByText('Conditional node', { exact: true }).click();
  await expect(costNode.locator('.conditional-if-port')).toHaveCount(0);
  await canvas.click({ position: { x: 350, y: 750 } });
  await editor.getByRole('button', { name: 'Run project', exact: true }).click();
  await editor.getByRole('button', { name: 'Open Run Activity', exact: true }).click({ timeout: 10_000 });
  const activityCost = editor.locator('[aria-label="Run Activity"] .run-activity-row').filter({ hasText: 'AI Cost' });
  await expect(activityCost).toHaveCount(1);
  await expect(activityCost.locator('.run-activity-preview')).toHaveText('0');
  const excluded = editor
    .locator('[aria-label="Run Activity"] .run-activity-row')
    .filter({ hasText: 'Excluded output' });
  await expect(excluded.locator('.run-activity-preview')).toHaveText('Not ran');
});
