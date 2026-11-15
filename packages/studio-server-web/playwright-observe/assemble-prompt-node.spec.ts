import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Assemble Prompt enables empty-prompt filtering by default and allows opting out', async ({ page }) => {
  await page.route('**/api/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/workflows/tree')
      return route.fulfill({ json: { root: '/workflows', folders: [], projects: [] } });
    return route.fulfill({ status: 503, json: { error: 'Isolated Assemble Prompt fixture' } });
  });
  await mockHostedEditorBootstrap(page);
  const suffix = String(Date.now());
  await seedHostedEditorProject(page, {
    graphId: `assemble-prompt-${suffix}-graph`,
    loaded: true,
    projectId: `assemble-prompt-${suffix}-project`,
    projectPath: `/workflows/Assemble Prompt ${suffix}.rivet-project`,
    title: `Assemble Prompt ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvas = editor.locator('.node-canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await canvas.click({ button: 'right', position: { x: 360, y: 260 } });

  const search = editor.getByPlaceholder('Type in node name...');
  await search.fill('Assemble Prompt');
  await editor
    .locator('.context-menu-items .context-menu-label-text')
    .filter({ hasText: /^Assemble Prompt$/ })
    .click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Assemble Prompt$/ }),
  });
  await expect(node).toHaveCount(1);
  await expect(node.getByText('Filter empty prompts: Enabled', { exact: true })).toBeVisible();
  await expect(node.locator('.assemble-prompt-node-body-label')).toHaveText('Filter empty prompts:');
  await expect(node.locator('.assemble-prompt-node-body-label')).toHaveCSS('opacity', '0.6');

  await node.locator('.node-title').click();
  const setting = editor.getByLabel('Filter empty prompts');
  await expect(setting).toBeChecked();
  await editor
    .locator('.toggle-editor-field', { has: editor.getByText('Filter empty prompts', { exact: true }) })
    .locator('.scalable-toggle')
    .click();

  await expect(setting).not.toBeChecked();
  await expect(node.getByText('Filter empty prompts: Enabled', { exact: true })).toHaveCount(0);

  const cacheBreakpointInputToggle = editor.getByRole('button', {
    name: 'Use an input port for Is Last Message Cache Breakpoint',
  });
  await expect(cacheBreakpointInputToggle).toHaveAttribute('aria-pressed', 'false');
  await cacheBreakpointInputToggle.click();
  await expect(cacheBreakpointInputToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(node.locator('.input-ports .port-label')).toContainText([
    'Is Last Message Cache Breakpoint',
    'Message 1',
  ]);
  await expect(node.locator('.node-body')).toContainText('Last message cache breakpoint: From input');

  await editor
    .locator('.toggle-editor-field', { has: editor.getByText('Filter empty prompts', { exact: true }) })
    .locator('.scalable-toggle')
    .click();

  await expect(setting).toBeChecked();
  await expect(node.getByText('Filter empty prompts: Enabled', { exact: true })).toBeVisible();
});
