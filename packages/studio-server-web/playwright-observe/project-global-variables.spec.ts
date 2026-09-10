import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Project Settings General adds a project global variable', async ({ page }) => {
  const projectId = 'project-global-variables-project';
  const graphId = 'project-global-variables-graph';

  await seedHostedEditorProject(page, {
    graphId,
    loaded: true,
    projectId,
    projectPath: '/workflows/Project Global Variables.rivet-project',
    title: 'Project Global Variables',
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  await editor.getByRole('button', { name: 'Project settings', exact: true }).click();

  const modal = editor.getByTestId('project-settings-modal');
  await expect(modal.getByText('Global variables', { exact: true })).toBeVisible();
  await expect(modal.getByText(/same global variables used by Set Global and Get Global/i)).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Add global variable', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Add global variable', exact: true }).click();

  const globalVariableEditor = editor.getByTestId('project-global-variable-editor-modal');
  await expect(globalVariableEditor).toBeVisible();
  await globalVariableEditor.getByLabel('Data Type').click();
  const lowestVisibleDataTypeOption = editor.getByText('Object', { exact: true }).last();
  await expect(lowestVisibleDataTypeOption).toBeVisible();
  const [dataTypeOptionBounds, saveButtonBounds] = await Promise.all([
    lowestVisibleDataTypeOption.boundingBox(),
    globalVariableEditor.getByRole('button', { name: 'Save', exact: true }).boundingBox(),
  ]);
  expect(dataTypeOptionBounds).not.toBeNull();
  expect(saveButtonBounds).not.toBeNull();
  expect(dataTypeOptionBounds!.y + dataTypeOptionBounds!.height).toBeGreaterThan(saveButtonBounds!.y);
  await editor.getByText('String', { exact: true }).last().click();
  await globalVariableEditor.getByLabel('ID').fill('greeting');
  await globalVariableEditor.getByLabel('Value (JSON)').fill('"hello from project settings"');
  await globalVariableEditor.getByRole('button', { name: 'Save', exact: true }).click();

  const globalVariableRow = modal.locator('.project-global-variables-row');
  await expect(globalVariableRow).toContainText('greeting');
  await expect(globalVariableRow).toContainText('string: "hello from project settings"');

  await modal.getByRole('button', { name: 'Add global variable', exact: true }).click();
  await globalVariableEditor.getByLabel('ID').fill('__proto__');
  await globalVariableEditor.getByLabel('Value (JSON)').fill('"a valid Set Global ID"');
  await globalVariableEditor.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(globalVariableRow).toHaveCount(2);
  await expect(globalVariableRow.filter({ hasText: '__proto__' })).toContainText('a valid Set Global ID');

  const greetingRow = globalVariableRow.filter({ hasText: 'greeting' });
  await greetingRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await globalVariableEditor.getByLabel('Value (JSON)').fill('"edited project global value"');
  await globalVariableEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(greetingRow).toContainText('edited project global value');

  await greetingRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await globalVariableEditor.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(greetingRow).toHaveCount(0);
});
