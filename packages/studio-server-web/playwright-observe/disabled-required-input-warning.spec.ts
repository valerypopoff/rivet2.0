import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

function createDisabledRequiredInputProjectFile(projectName: string): string {
  const projectId = 'disabled-required-input-project';
  const graphId = 'disabled-required-input-graph';

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
    '            text: "{\\\"name\\\":\\\"Ada\\\"}"',
    '          outgoingConnections:',
    '            - output->"Required target" required-target/object',
    '          visualData: 400/300/250/null//',
    '        \'[required-target]:destructure "Required target"\':',
    '          data:',
    '            paths:',
    '              - $.name',
    '          visualData: 760/300/250/null//',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

test('shows the standard header warning when a required input is fed by a disabled node', async ({ page }) => {
  const projectName = 'Disabled required input';
  const projectContents = createDisabledRequiredInputProjectFile(projectName);
  const project: WorkflowProjectItem = {
    id: 'disabled-required-input-project',
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
  const targetNode = frame.locator('.node[data-nodeid="required-target"]');
  const warning = targetNode.locator('.node-header-warning');

  await expect(targetNode).toBeVisible({ timeout: 60_000 });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute(
    'aria-label',
    'Required input "Object" is connected to disabled node "Disabled source". It will not provide a value, so this node is marked Not Ran. Enable the source or remove or replace the connection.',
  );
});