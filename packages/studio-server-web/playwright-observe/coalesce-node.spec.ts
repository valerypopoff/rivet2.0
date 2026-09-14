import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function openEmptyProject(page: Page, suffix: string): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `coalesce-node-${suffix}-graph`,
    loaded: true,
    projectId: `coalesce-node-${suffix}-project`,
    projectPath: `/workflows/Coalesce nodes ${suffix}.rivet-project`,
    title: `Coalesce nodes ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  return editor;
}

async function searchAddNode(editor: FrameLocator, nodeName: string, position: { x: number; y: number }): Promise<void> {
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position, timeout: 20_000 });

  const search = editor.getByPlaceholder('Type in node name...');
  await expect(search).toBeVisible();
  await search.fill(nodeName);
}

test('Coalesce is the new no-conditional node while Coalesce (legacy) keeps its port', async ({ page }) => {
  const editor = await openEmptyProject(page, String(Date.now()));

  await searchAddNode(editor, 'Coalesce', { x: 320, y: 260 });
  const menuLabels = editor.locator('.context-menu-items .context-menu-label-text');
  const currentMenuItem = menuLabels.filter({ hasText: /^Coalesce$/ });
  const legacyMenuItem = menuLabels.filter({ hasText: /^Coalesce \(legacy\)$/ });

  await expect(currentMenuItem).toHaveCount(1);
  await expect(legacyMenuItem).toHaveCount(1);
  await currentMenuItem.click();

  const currentNode = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Coalesce$/ }),
  });
  await expect(currentNode).toHaveCount(1);
  await expect(currentNode.locator('.port-label', { hasText: /^Input 1$/ })).toHaveCount(1);
  await expect(currentNode.locator('.port-label', { hasText: /^Conditional$/ })).toHaveCount(0);

  await searchAddNode(editor, 'Coalesce (legacy)', { x: 500, y: 700 });
  await legacyMenuItem.click();

  const legacyNode = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Coalesce \(legacy\)$/ }),
  });
  await expect(legacyNode).toHaveCount(1);
  await expect(legacyNode.locator('.port-label', { hasText: /^Conditional$/ })).toHaveCount(1);
});
