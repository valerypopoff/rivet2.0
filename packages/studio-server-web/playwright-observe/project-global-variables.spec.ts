import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
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

  await mockHostedEditorBootstrap(page);
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
  const title = globalVariableEditor.getByText('Add Global Variable', { exact: true });
  const titleBounds = await title.boundingBox();
  expect(titleBounds).not.toBeNull();
  await page.mouse.move(titleBounds!.x + 4, titleBounds!.y + titleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBounds!.x + titleBounds!.width - 4, titleBounds!.y + titleBounds!.height / 2, {
    steps: 8,
  });
  await expect.poll(() => title.evaluate(() => window.getSelection()?.toString())).not.toBe('');
  await page.mouse.up();
  await expect.poll(() => title.evaluate(() => window.getSelection()?.toString())).toContain('Global Variable');
  await page.waitForTimeout(500);
  await expect.poll(() => title.evaluate(() => window.getSelection()?.toString())).toContain('Global Variable');
  const modalCopy = globalVariableEditor.locator('.project-global-variables-modal-copy');
  const copyBounds = await modalCopy.boundingBox();
  expect(copyBounds).not.toBeNull();
  await modalCopy.hover({ position: { x: 30, y: 12 } });
  await page.mouse.down();
  await page.mouse.move(copyBounds!.x + 250, copyBounds!.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => modalCopy.evaluate(() => window.getSelection()?.toString())).not.toBe('');
  await page.waitForTimeout(500);
  await expect.poll(() => modalCopy.evaluate(() => window.getSelection()?.toString())).not.toBe('');
  const idField = globalVariableEditor.getByLabel('ID');
  await idField.fill('selection-check');
  await idField.press('ControlOrMeta+A');
  await expect(idField).toHaveJSProperty('selectionStart', 0);
  await expect(idField).toHaveJSProperty('selectionEnd', 'selection-check'.length);
  await page.waitForTimeout(500);
  await expect(idField).toHaveJSProperty('selectionEnd', 'selection-check'.length);
  await idField.click({ clickCount: 3 });
  await expect(idField).toHaveJSProperty('selectionEnd', 'selection-check'.length);
  await page.waitForTimeout(500);
  await expect(idField).toHaveJSProperty('selectionEnd', 'selection-check'.length);
  const dataTypeControl = globalVariableEditor.locator('.data-type-selector');
  const [typeBounds, arrayBounds] = await Promise.all([
    dataTypeControl.getByRole('combobox').boundingBox(),
    dataTypeControl.getByText('Array', { exact: true }).boundingBox(),
  ]);
  expect(typeBounds).not.toBeNull();
  expect(arrayBounds).not.toBeNull();
  expect(arrayBounds!.x).toBeGreaterThan(typeBounds!.x + typeBounds!.width + 8);
  expect(Math.abs(arrayBounds!.y - typeBounds!.y)).toBeLessThan(40);
  await globalVariableEditor.locator('.data-type-selector').getByRole('combobox').click();
  await page.waitForTimeout(500);
  await expect(globalVariableEditor.getByText('Object', { exact: true })).toBeVisible();
  await globalVariableEditor.getByText('String', { exact: true }).last().click();
  await idField.fill('greeting');
  const literalField = globalVariableEditor.getByLabel('Value (JSON)');
  await literalField.fill('"selection check"');
  await literalField.press('ControlOrMeta+A');
  await expect(literalField).toHaveJSProperty('selectionStart', 0);
  await expect(literalField).toHaveJSProperty('selectionEnd', '"selection check"'.length);
  await page.waitForTimeout(500);
  await expect(literalField).toHaveJSProperty('selectionEnd', '"selection check"'.length);
  await literalField.fill('"hello from project settings"');
  await globalVariableEditor.getByRole('button', { name: 'Save', exact: true }).click();

  const globalVariableRow = modal.locator('.project-global-variables-row');
  await expect(globalVariableRow).toContainText('greeting');
  await expect(globalVariableRow).toContainText('string: "hello from project settings"');

  await modal.getByRole('button', { name: 'Add global variable', exact: true }).click();
  await globalVariableEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(globalVariableEditor).toHaveCount(0);

  await modal.getByRole('button', { name: 'Add global variable', exact: true }).click();
  await globalVariableEditor.press('Escape');
  await expect(globalVariableEditor).toHaveCount(0);

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
