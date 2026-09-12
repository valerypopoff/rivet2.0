import { expect, test } from '@playwright/test';

import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const projectName = 'Dashboard Graph Deletion';
const projectId = 'dashboard-graph-deletion-project';
const graphId = 'dashboard-graph-deletion-graph';
const projectPath = `/workflows/${projectName}.rivet-project`;

const projectContents = [
  'version: 4',
  'data:',
  '  metadata:',
  `    id: ${JSON.stringify(projectId)}`,
  `    title: ${JSON.stringify(projectName)}`,
  '    description: ""',
  `    mainGraphId: ${JSON.stringify(graphId)}`,
  '  graphs:',
  `    ${JSON.stringify(graphId)}:`,
  '      metadata:',
  `        id: ${JSON.stringify(graphId)}`,
  '        name: "Main Graph"',
  '        description: ""',
  '      nodes: {}',
  '      connections: []',
  '  plugins: []',
  '  references: []',
  '',
].join('\n');

const project: WorkflowProjectItem = {
  id: projectId,
  name: projectName,
  fileName: `${projectName}.rivet-project`,
  relativePath: `${projectName}.rivet-project`,
  absolutePath: projectPath,
  updatedAt: '2026-09-11T00:00:00.000Z',
  settings: {
    status: 'unpublished',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [],
  },
};

test('dashboard Save persists deleting the final active graph', async ({ page }) => {
  const pageErrors: string[] = [];
  const savedPaths: string[] = [];
  let savedContents = projectContents;

  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/workflows/tree', async (route) => {
    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      sync: { epoch: 'dashboard-graph-deletion', revision: 0 },
      folders: [],
      projects: [project],
    };
    await route.fulfill({ json: tree });
  });
  await page.route('**/api/projects/load', async (route) => {
    await route.fulfill({ json: { contents: savedContents, datasetsContents: null, revisionId: null } });
  });
  await page.route('**/api/projects/save', async (route) => {
    const body = route.request().postDataJSON() as { contents?: string; path?: string };
    expect(body.path).toBe(projectPath);
    expect(typeof body.contents).toBe('string');
    savedContents = body.contents ?? '';
    savedPaths.push(body.path ?? '');
    await route.fulfill({ json: { path: projectPath, revisionId: 'dashboard-graph-deletion-save' } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: projectName }).dblclick();

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const graphRow = editor.locator(`.graph-item[data-graphid="${graphId}"]`);
  await expect(graphRow).toBeVisible({ timeout: 30_000 });
  await graphRow.click({ button: 'right' });
  await editor.locator('.graph-item-context-menu').getByRole('button', { name: 'Delete' }).click();
  await editor.getByRole('dialog', { name: 'Delete Graph?' }).getByRole('button', { name: 'Delete' }).click();

  const saveButton = page.locator('.active-project-save-button');
  await expect(saveButton).toBeVisible({ timeout: 30_000 });
  await saveButton.click();

  await expect.poll(() => savedPaths).toEqual([projectPath]);
  expect(savedContents).not.toContain(graphId);
  await expect(saveButton).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
