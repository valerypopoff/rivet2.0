import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function openEmptyProject(page: Page, suffix: string): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `regex-match-node-${suffix}-graph`,
    loaded: true,
    projectId: `regex-match-node-${suffix}-project`,
    projectPath: `/workflows/Regex Match ${suffix}.rivet-project`,
    title: `Regex Match ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  return editor;
}

test('Regex Match presents its trigger mode as a dimmed setting label and updates it', async ({ page }) => {
  const editor = await openEmptyProject(page, String(Date.now()));
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 320, y: 260 } });

  const search = editor.getByPlaceholder('Type in node name...');
  await expect(search).toBeVisible();
  await search.fill('Regex Match');
  await editor.locator('.context-menu-items .context-menu-label-text').filter({ hasText: /^Regex Match$/ }).click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Regex Match$/ }),
  });
  const triggerField = node.locator('.llm-node-body-field');
  const triggerLabel = node.locator('.llm-node-body-label');
  await expect(triggerField).toHaveText('Trigger: All matching cases');
  await expect(triggerLabel).toHaveText('Trigger:');
  await expect(triggerLabel).toHaveCSS('opacity', '0.6');

  await node.locator('.node-title').click();
  await editor.getByRole('group', { name: 'Matching cases to trigger' }).getByRole('button', { name: 'Trigger first only' }).click();
  await expect(triggerField).toHaveText('Trigger: First matching case only');
});
