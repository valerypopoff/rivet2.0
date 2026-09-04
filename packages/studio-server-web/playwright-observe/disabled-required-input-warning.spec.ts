import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

function createDisabledGraphInputFallbackProjectFile(projectName: string): string {
  const projectId = 'disabled-graph-input-project';
  const graphId = 'disabled-graph-input-graph';

  return [
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
    '        \'[disabled-source]:text "Disabled source"\':',
    '          disabled: true',
    '          data:',
    '            text: "Ignored"',
    '          outgoingConnections:',
    '            - output->"Graph Input" graph-input/default',
    '          visualData: 400/300/250/null//',
    '        \'[graph-input]:graphInput "Graph Input"\':',
    '          data:',
    '            dataType: string',
    '            id: input',
    '            defaultValue: "Fallback"',
    '            useDefaultValueInput: true',
    '          visualData: 760/300/250/null//',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

test('warns when a disabled source feeds a Graph Input Default Value', async ({ page }) => {
  const projectName = 'Disabled Graph Input default';
  const projectContents = createDisabledGraphInputFallbackProjectFile(projectName);
  const project: WorkflowProjectItem = {
    id: 'disabled-graph-input-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: `/workflows/${projectName}.rivet-project`,
    updatedAt: '2026-09-03T00:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };

  await page.route('**/api/workflows/tree', async (route) => {
    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      sync: { epoch: 'playwright-fixture', revision: 0 },
      folders: [],
      projects: [project],
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });
  await page.route('**/api/projects/load', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: projectContents,
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const projectRow = page.locator('.project-row', { hasText: projectName });
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.dblclick();

  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const graphInputNode = frame.locator('.node[data-nodeid="graph-input"]');
  const warning = graphInputNode.locator('.node-header-warning');

  await expect(graphInputNode).toBeVisible({ timeout: 60_000 });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute(
    'aria-label',
    'Input "Default Value" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
});
