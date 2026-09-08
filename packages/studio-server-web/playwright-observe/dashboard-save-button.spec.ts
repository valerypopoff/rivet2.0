import { expect, test, type Page } from '@playwright/test';

import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const projectName = 'Dashboard Save Button';
const projectId = 'dashboard-save-button-project';
const graphId = 'dashboard-save-button-graph';
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
  '      nodes:',
  '        \'[dashboard-save-node]:text "Dashboard Save Node"\':',
  '          visualData: 520/300/260/null//',
  '          data:',
  '            text: Save button regression fixture',
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
  updatedAt: '2026-09-08T00:00:00.000Z',
  settings: {
    status: 'unpublished',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [],
  },
};

async function dragNode(page: Page, deltaX: number): Promise<void> {
  const nodeTitle = page
    .frameLocator('iframe.dashboard-editor-frame')
    .locator('.node[data-nodeid="dashboard-save-node"] .node-title');
  await expect(nodeTitle).toBeVisible({ timeout: 90_000 });

  const before = await nodeTitle.boundingBox();
  if (!before) {
    throw new Error('Dashboard Save fixture node has no bounding box.');
  }

  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await nodeTitle.boundingBox())?.x).not.toBe(before.x);
}

test('dashboard Save sends a data-only command and remains explicit in Evaluations', async ({ page }) => {
  test.slow();

  const pageErrors: string[] = [];
  const savedPaths: string[] = [];
  let savedContents = projectContents;
  let saveSequence = 0;

  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/workflows/tree', async (route) => {
    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      sync: { epoch: 'dashboard-save-button', revision: 0 },
      folders: [],
      projects: [project],
    };
    await route.fulfill({ json: tree });
  });

  await page.route('**/api/projects/load', async (route) => {
    await route.fulfill({
      json: {
        contents: savedContents,
        datasetsContents: null,
        revisionId: saveSequence === 0 ? null : `dashboard-save-${saveSequence}`,
      },
    });
  });

  await page.route('**/api/projects/save', async (route) => {
    const body = route.request().postDataJSON() as { contents?: string; path?: string };
    expect(body.path).toBe(projectPath);
    expect(typeof body.contents).toBe('string');
    savedContents = body.contents ?? '';
    savedPaths.push(body.path ?? '');
    saveSequence += 1;
    await route.fulfill({
      json: {
        path: projectPath,
        revisionId: `dashboard-save-${saveSequence}`,
      },
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: projectName }).dblclick();

  const saveButton = page.locator('.active-project-save-button');
  await dragNode(page, 40);
  await expect(saveButton).toBeVisible({ timeout: 30_000 });
  await saveButton.click();

  await expect.poll(() => savedPaths).toEqual([projectPath]);
  await expect(saveButton).toHaveCount(0);
  expect(pageErrors).toEqual([]);

  await dragNode(page, 30);
  await expect(saveButton).toBeVisible({ timeout: 30_000 });
  const evaluationsTab = page
    .frameLocator('iframe.dashboard-editor-frame')
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Evaluations' });
  await evaluationsTab.click();
  await expect(evaluationsTab).toHaveAttribute('aria-pressed', 'true');
  await saveButton.click();

  await expect.poll(() => savedPaths).toEqual([projectPath, projectPath]);
  await expect(saveButton).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
