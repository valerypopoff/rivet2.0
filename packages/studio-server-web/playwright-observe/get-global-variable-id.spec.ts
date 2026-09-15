import { expect, test } from '@playwright/test';
import { GetGlobalNodeImpl, SetGlobalNodeImpl } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Get Global uses one searchable Variable ID field for suggestions and manual IDs', async ({ page }) => {
  const writer = SetGlobalNodeImpl.create();
  writer.data.id = 'knownGlobalId';
  writer.visualData = { ...writer.visualData, x: 120, y: 150, width: 320 };
  const reader = GetGlobalNodeImpl.create();
  reader.data.id = 'originalId';
  reader.visualData = { ...reader.visualData, x: 530, y: 150, width: 320 };

  await seedHostedEditorProject(page, {
    graph: { nodes: [writer, reader] },
    graphId: 'get-global-variable-id-graph',
    loaded: true,
    projectId: 'get-global-variable-id-project',
    projectPath: '/workflows/Get Global Variable ID.rivet-project',
    title: 'Get Global Variable ID',
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const readerNode = editor.locator(`.node[data-nodeid="${reader.id}"]`);
  await expect(readerNode).toBeVisible({ timeout: 60_000 });
  await readerNode.hover();
  await readerNode.locator('.edit-button').click({ timeout: 10_000 });

  const variableId = editor.getByRole('combobox', { name: 'Variable ID' });
  await expect(variableId).toHaveCount(1);
  await expect(variableId).toHaveValue('originalId');
  await expect(editor.getByText('Search Global Variables', { exact: true })).toHaveCount(0);

  await variableId.fill('');
  await variableId.pressSequentially('known');
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toBeVisible();
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveAttribute('aria-selected', 'false');
  await variableId.press('Enter');
  await expect(variableId).toHaveValue('known');
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveCount(0);
  await variableId.press('ArrowDown');
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveAttribute('aria-selected', 'true');
  await variableId.press('Enter');
  await expect(variableId).toHaveValue('knownGlobalId');
  await variableId.fill('known');
  await editor.getByRole('option', { name: 'knownGlobalId' }).click({ timeout: 10_000 });
  await expect(variableId).toHaveValue('knownGlobalId');
  await variableId.fill('known');
  await variableId.press('ArrowUp');
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveAttribute('aria-selected', 'true');
  await variableId.press('Enter');
  await expect(variableId).toHaveValue('knownGlobalId');
  await variableId.fill('known');
  await variableId.press('ArrowDown');
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveAttribute('aria-selected', 'true');
  await variableId.click();
  await expect(editor.getByRole('option', { name: 'knownGlobalId' })).toHaveAttribute('aria-selected', 'false');
  await variableId.press('Enter');
  await expect(variableId).toHaveValue('known');
  await variableId.press('Tab');

  await variableId.fill('manuallyTypedId');
  await variableId.press('Tab');
  await editor.locator('.node-canvas').click({ position: { x: 500, y: 500 } });
  await readerNode.hover();
  await readerNode.locator('.edit-button').click({ timeout: 10_000 });
  await expect(variableId).toHaveValue('manuallyTypedId');

  await variableId.click();
  await expect(variableId).toHaveValue('manuallyTypedId');
  await variableId.press('End');
  await variableId.press('ArrowLeft');
  expect(await variableId.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe('manuallyTypedId'.length - 1);
  await variableId.press('X');
  await expect(variableId).toHaveValue('manuallyTypedIXd');
  expect(await variableId.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe('manuallyTypedIXd'.length - 1);

  await editor.getByRole('button', { name: 'Use an input port for Variable ID' }).click();
  await expect(readerNode.locator('.port-label', { hasText: /^Variable ID$/ })).toHaveCount(2);
  await expect(variableId).toHaveValue('manuallyTypedIXd');
});
