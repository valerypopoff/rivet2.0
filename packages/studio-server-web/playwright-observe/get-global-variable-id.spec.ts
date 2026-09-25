import { expect, test } from '@playwright/test';
import { GetGlobalNodeImpl, SetGlobalNodeImpl, type NodeConnection, type PortId } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('global output labels track IDs while Get Global remains searchable', async ({ page }) => {
  const writer = SetGlobalNodeImpl.create();
  writer.data.id = 'knownGlobalId';
  writer.visualData = { ...writer.visualData, x: 120, y: 150, width: 320 };
  const reader = GetGlobalNodeImpl.create();
  reader.data.id = 'originalId';
  reader.visualData = { ...reader.visualData, x: 530, y: 150, width: 320 };
  const existingConnection: NodeConnection = {
    outputNodeId: reader.id,
    outputId: 'value' as PortId,
    inputNodeId: writer.id,
    inputId: 'value' as PortId,
  };

  await seedHostedEditorProject(page, {
    graph: { nodes: [writer, reader], connections: [existingConnection] },
    graphId: 'get-global-variable-id-graph',
    loaded: true,
    projectId: 'get-global-variable-id-project',
    projectPath: '/workflows/Get Global Variable ID.rivet-project',
    title: 'Get Global Variable ID',
  });
  await mockHostedEditorBootstrap(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const writerNode = editor.locator(`.node[data-nodeid="${writer.id}"]`);
  await expect(writerNode.locator('.output-port[data-portid="saved-value"] + .port-label')).toHaveText('knownGlobalId');
  await expect(writerNode.locator('.output-port[data-portid="previous-value"] + .port-label')).toHaveText(
    'Prev value of: knownGlobalId',
  );
  const readerNode = editor.locator(`.node[data-nodeid="${reader.id}"]`);
  await expect(readerNode).toBeVisible({ timeout: 60_000 });
  const valuePort = readerNode.locator('.output-port[data-portid="value"]');
  const valueOutput = readerNode.locator('.output-port[data-portid="value"] + .port-label');
  await expect(valueOutput).toHaveText('originalId');
  await expect(valuePort.locator('..')).toHaveClass(/connected/);
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
  await expect(valueOutput).toHaveText('knownGlobalId');
  await expect(valuePort.locator('..')).toHaveClass(/connected/);
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
  await expect(valueOutput).toHaveText('manuallyTypedId');
  await expect(valuePort.locator('..')).toHaveClass(/connected/);
  await editor.locator('.node-canvas').click({ position: { x: 450, y: 600 } });
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
  await expect(valueOutput).toHaveText('Value');
  await expect(valuePort.locator('..')).toHaveClass(/connected/);
  await expect(variableId).toHaveValue('manuallyTypedIXd');

  await writerNode.hover();
  await writerNode.locator('.edit-button').click({ timeout: 10_000 });
  await editor.getByRole('button', { name: 'Use an input port for ID' }).click();
  await expect(writerNode).toContainText('(ID from input)');
  await expect(writerNode.locator('.output-port[data-portid="saved-value"] + .port-label')).toHaveText('Value');
  await expect(writerNode.locator('.output-port[data-portid="previous-value"] + .port-label')).toHaveText(
    'Previous Value',
  );
});

test('Get Global copies a known variable type once and keeps a later manual choice', async ({ page }) => {
  const reader = GetGlobalNodeImpl.create();
  reader.data.id = 'unknown';
  reader.visualData = { ...reader.visualData, x: 400, y: 180, width: 320 };
  const writer = SetGlobalNodeImpl.create();
  writer.data.id = 'typedGlobal';
  writer.data.dataType = 'string';
  writer.visualData = { ...writer.visualData, x: 60, y: 180, width: 320 };

  await seedHostedEditorProject(page, {
    graph: { nodes: [writer, reader] },
    graphId: 'get-global-type-graph',
    loaded: true,
    metadata: { globalVariables: { typedGlobal: { type: 'number', value: 3 } } },
    projectId: 'get-global-type-project',
    projectPath: '/workflows/Get Global Type.rivet-project',
    title: 'Get Global Type',
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const readerNode = editor.locator(`.node[data-nodeid="${reader.id}"]`);
  await readerNode.hover();
  await readerNode.locator('.edit-button').click();
  const variableId = editor.getByRole('combobox', { name: 'Variable ID' });
  const dataType = editor.locator('.data-type-selector');

  await variableId.fill('typedGlobal');
  await expect(dataType.getByText('Number', { exact: true })).toBeVisible();
  await expect(dataType.getByRole('status')).toContainText('Data type set to Number from variable "typedGlobal"');
  await expect(dataType.getByRole('status')).toContainText('Other declarations use String');
  await page.waitForTimeout(5_500);
  await expect(dataType.getByRole('status')).toBeVisible();

  await editor.locator('.node-canvas').click({ position: { x: 700, y: 650 } });
  await readerNode.hover();
  await readerNode.locator('.edit-button').click();
  await expect(dataType.getByRole('status')).toBeVisible();

  await dataType.getByRole('combobox').click();
  await editor.getByText('String', { exact: true }).click({ timeout: 10_000 });
  await expect(dataType.getByText('String', { exact: true })).toBeVisible();
  await expect(dataType.getByRole('status')).toHaveCount(0);

  await editor.locator('.node-canvas').click({ position: { x: 700, y: 650 } });
  await readerNode.hover();
  await readerNode.locator('.edit-button').click();
  await expect(variableId).toHaveValue('typedGlobal');
  await expect(dataType.getByText('String', { exact: true })).toBeVisible();
  await expect(dataType.getByRole('status')).toHaveCount(0);
});
