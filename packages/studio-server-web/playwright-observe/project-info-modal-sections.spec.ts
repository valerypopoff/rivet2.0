import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('project settings uses the shared settings-style navigation rail', async ({ page }) => {
  const projectId = 'project-settings-sections-project';
  const graphId = 'project-settings-sections-graph';

  await seedHostedEditorProject(page, {
    graphId,
    loaded: true,
    metadata: {
      knowledgeStores: {
        existing: {
          displayName: 'Existing store',
          provider: 'example',
        },
      },
    },
    projectId,
    projectPath: '/workflows/Project Settings Sections.rivet-project',
    title: 'Project Settings Sections',
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  await editor.getByRole('button', { name: 'Project settings', exact: true }).click();

  const modal = editor.getByTestId('project-settings-modal');
  const modalWidth = await modal.evaluate((element) => element.getBoundingClientRect().width);
  const editorWidth = await editor
    .locator('body')
    .evaluate((element) => element.ownerDocument!.defaultView!.innerWidth);
  expect(modalWidth / editorWidth).toBeGreaterThan(0.35);
  expect(modalWidth / editorWidth).toBeLessThan(0.45);
  const navigation = modal.getByRole('navigation', { name: 'Project settings' });
  await expect(navigation.getByRole('button')).toHaveText([
    'General',
    'MCP',
    'Knowledge stores',
    'Plugins',
    'Context values',
    'Other',
  ]);
  await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  await expect(modal.locator('.project-info-section')).toContainText('Project Name');
  await expect(modal.locator('.project-info-section')).toContainText('Description');
  await expect(modal.locator('.project-info-section')).toContainText('Main Graph');

  await navigation.getByRole('button', { name: 'MCP' }).click();
  await expect(navigation.getByRole('button', { name: 'MCP' })).toHaveAttribute('aria-current', 'page');
  await expect(modal.getByText('To use local MCP servers with your Rivet project')).toBeVisible();
  await expect(modal.getByText('Configuration (JSON)')).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Edit MCP Configuration' })).toHaveCount(0);

  await navigation.getByRole('button', { name: 'Knowledge stores' }).click();
  await expect(modal.getByRole('button', { name: 'Add Store' })).toBeVisible();
  await expect(modal.getByText('Existing store')).toBeVisible();
  await expect(modal.locator('.knowledge-store-list + .knowledge-store-add')).toBeVisible();

  await navigation.getByRole('button', { name: 'Plugins' }).click();
  await expect(modal.getByText('No plugins used by this project')).toBeVisible();

  await navigation.getByRole('button', { name: 'Context values' }).click();
  await expect(modal.getByRole('button', { name: 'Add Context Value' })).toBeVisible();

  await navigation.getByRole('button', { name: 'Other' }).click();
  await expect(modal.locator('.project-info-section')).toContainText('Project References');
  await expect(modal.locator('.project-info-section')).toContainText('Project compare');
  await expect(modal.locator('.project-info-section')).toContainText('Revisions');
  await expect(modal.locator('.project-info-foldable')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
});
