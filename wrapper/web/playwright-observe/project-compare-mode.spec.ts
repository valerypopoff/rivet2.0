import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

function createCompareProjectItem(name: string): WorkflowProjectItem {
  return {
    id: `compare-${name}-project-id`,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-06-12T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
    },
  };
}

function createCompareProjectFile(options: {
  graphId: string;
  nodeText: string;
  projectId: string;
  secondNode?: boolean;
  title: string;
}): string {
  const secondNodeBlock = options.secondNode
    ? [
        '        \'[compare-node-2]:text "Added Node"\':',
        '          visualData: 860/320/260/null//',
        '          data:',
        '            text: added',
      ]
    : [];

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(options.projectId)}`,
    `    title: ${JSON.stringify(options.title)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(options.graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(options.graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(options.graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    '        \'[compare-node-1]:text "Compared Node"\':',
    '          visualData: 520/320/260/null//',
    '          data:',
    `            text: ${options.nodeText}`,
    ...secondNodeBlock,
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function installCompareModeRoutes(
  page: Page,
  projects: WorkflowProjectItem[],
  projectContentsByPath: Map<string, string>,
): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      folders: [],
      projects,
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });

  await page.route('**/api/projects/load', async (route) => {
    const requestBody = route.request().postDataJSON() as { path?: string };
    const contents = requestBody.path ? projectContentsByPath.get(requestBody.path) : null;

    if (!contents) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Unknown project path: ${requestBody.path ?? ''}` }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents,
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.route('**/api/projects/save', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Project compare mode spec should not save projects.' }),
    });
  });
}

test.describe('Project compare mode', () => {
  test('starts compare mode from another project row context menu', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-current');
    const referenceProject = createCompareProjectItem('codex-compare-reference');
    const projectContentsByPath = new Map<string, string>([
      [currentProject.absolutePath, createCompareProjectFile({
        graphId: 'compare-current-graph',
        nodeText: 'current',
        projectId: currentProject.id,
        secondNode: true,
        title: currentProject.name,
      })],
      [referenceProject.absolutePath, createCompareProjectFile({
        graphId: 'compare-current-graph',
        nodeText: 'reference',
        projectId: referenceProject.id,
        title: referenceProject.name,
      })],
    ]);

    await installCompareModeRoutes(page, [currentProject, referenceProject], projectContentsByPath);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const referenceRow = page.locator('.project-row', { hasText: referenceProject.name });
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await currentRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Compare opened project with this one' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await referenceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();

    await expect(editorFrame.getByText('Compare mode against')).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(referenceProject.fileName)).toBeVisible({ timeout: 30_000 });
  });
});
