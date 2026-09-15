import { expect, test } from '@playwright/test';
import { deserializeProject, serializeProject, type ChartNode, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('copies a graph and folder across hosted projects, saves them, and reopens the destination', async ({ page }) => {
  const sourceId = 'graph-copy-source' as ProjectId;
  const destinationId = 'graph-copy-destination' as ProjectId;
  const sourcePath = '/workflows/Graph Copy Source.rivet-project';
  const destinationPath = '/workflows/Graph Copy Destination.rivet-project';
  const sourceGraphId = 'graph-copy-source-graph' as GraphId;
  const copiedGraphId = 'graph-copy-selected-graph' as GraphId;
  const nestedGraphId = 'graph-copy-nested-graph' as GraphId;
  const destinationGraphId = 'graph-copy-destination-graph' as GraphId;
  const destinationExistingId = 'graph-copy-destination-existing' as GraphId;
  const sourceNode = {
    id: 'graph-copy-input',
    type: 'graphInput',
    title: 'Graph Input',
    visualData: { x: 700, y: 250, width: 300 },
    data: { id: 'input', dataType: 'string', useDefaultValueInput: false },
  } as ChartNode;
  const source: Project = {
    metadata: { id: sourceId, title: 'Graph Copy Source', mainGraphId: sourceGraphId },
    graphs: {
      [sourceGraphId]: { metadata: { id: sourceGraphId, name: 'Main Graph' }, nodes: [sourceNode], connections: [] },
      [copiedGraphId]: { metadata: { id: copiedGraphId, name: 'Source/Item' }, nodes: [], connections: [] },
      [nestedGraphId]: { metadata: { id: nestedGraphId, name: 'Source/Nested/Deep' }, nodes: [], connections: [] },
    },
    plugins: [],
  } as Project;
  const destination: Project = {
    metadata: { id: destinationId, title: 'Graph Copy Destination', mainGraphId: destinationGraphId },
    graphs: {
      [destinationGraphId]: { metadata: { id: destinationGraphId, name: 'Main Graph' }, nodes: [], connections: [] },
      [destinationExistingId]: { metadata: { id: destinationExistingId, name: 'Target/Existing' }, nodes: [], connections: [] },
    },
    plugins: [],
  } as Project;
  const contents = new Map([
    [sourcePath, serializeProject(source) as string],
    [destinationPath, serializeProject(destination) as string],
  ]);
  const revisions = new Map([[sourcePath, 'graph-copy-fixture'], [destinationPath, 'graph-copy-fixture']]);
  let saveSequence = 0;
  let savedDestination: Project | undefined;

  await seedHostedEditorProject(page, {
    extraOpenedProjects: [{ graphId: destinationGraphId, projectId: destinationId, projectPath: destinationPath, title: 'Graph Copy Destination' }],
    extraGraphs: [{ id: copiedGraphId, name: 'Source/Item' }, { id: nestedGraphId, name: 'Source/Nested/Deep' }],
    graph: { nodes: [sourceNode] },
    graphId: sourceGraphId,
    loaded: true,
    projectId: sourceId,
    projectPath: sourcePath,
    title: 'Graph Copy Source',
  });

  await page.route('**/api/workflows/tree', (route) => route.fulfill({
    json: {
      folders: [],
      projects: [
        { id: sourceId, projectMetadataId: sourceId, name: 'Graph Copy Source', fileName: 'Graph Copy Source.rivet-project', relativePath: 'Graph Copy Source.rivet-project', absolutePath: sourcePath, updatedAt: '2026-09-15T00:00:00.000Z', settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] } },
        { id: destinationId, projectMetadataId: destinationId, name: 'Graph Copy Destination', fileName: 'Graph Copy Destination.rivet-project', relativePath: 'Graph Copy Destination.rivet-project', absolutePath: destinationPath, updatedAt: '2026-09-15T00:00:00.000Z', settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] } },
      ],
      root: '/workflows',
      sync: { epoch: 'graph-copy-fixture', revision: 0 },
    },
  }));
  await page.route('**/api/projects/load', async (route) => {
    const body = route.request().postDataJSON() as { path: string };
    expect(contents.has(body.path)).toBe(true);
    await route.fulfill({
      json: { contents: contents.get(body.path), datasetsContents: null, revisionId: revisions.get(body.path) },
    });
  });
  await page.route('**/api/projects/save', async (route) => {
    const body = route.request().postDataJSON() as { path: string; contents: string; projectId: string };
    expect(body.projectId).toBe(destinationId);
    expect(body.path).toBe(destinationPath);
    contents.set(body.path, body.contents);
    [savedDestination] = deserializeProject(body.contents, destinationPath);
    const revisionId = `graph-copy-saved-${++saveSequence}`;
    revisions.set(body.path, revisionId);
    await route.fulfill({ json: { path: body.path, revisionId } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvasNodes = editor.locator('.node');
  await expect(canvasNodes).toHaveCount(1);
  await canvasNodes.first().click();
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+V');
  await expect(canvasNodes).toHaveCount(2);
  await editor.locator('.graph-list-spacer').click({ button: 'right' });
  await expect(editor.locator('.graph-list-context-menu').getByRole('button', { name: 'Paste graphs' })).toHaveCount(0);
  const sourceGraph = editor.locator(`[data-graphid="${copiedGraphId}"]`);
  await expect(sourceGraph).toBeVisible({ timeout: 120_000 });
  await sourceGraph.click({ button: 'right' });
  await editor.locator('.graph-item-context-menu').getByRole('button', { name: 'Copy graph' }).click();

  await editor.locator('.node-canvas').click({ button: 'right', position: { x: 500, y: 200 } });
  await expect(editor.getByRole('button', { name: /^Paste$/ })).toHaveCount(0);
  await editor.locator('.node-canvas').click({ position: { x: 500, y: 200 } });
  await editor.locator('.node-canvas').press('Control+V');
  await expect(canvasNodes).toHaveCount(2);
  await editor.locator('.projects-container .project').filter({ hasText: 'Graph Copy Destination' }).click();
  await expect(editor.locator('.project-tree-header-title')).toHaveText('Graph Copy Destination');
  await editor.locator('.graph-list-spacer').click({ button: 'right' });
  await editor.locator('.graph-list-context-menu').getByRole('button', { name: 'Paste graphs' }).click();
  await expect(editor.locator('.graph-item').filter({ hasText: 'Item' })).toBeVisible();

  await editor.locator('.node-canvas').click({ position: { x: 500, y: 200 } });
  await editor.locator('.node-canvas').press('Control+S');
  await expect.poll(() => savedDestination?.graphs && Object.values(savedDestination.graphs).length).toBe(3);
  expect(savedDestination?.metadata.mainGraphId).toBe(destinationGraphId);
  const pasted = Object.values(savedDestination!.graphs).find((graph) => graph.metadata?.name === 'Item');
  expect(pasted?.metadata?.id).not.toBe(copiedGraphId);

  await editor.locator('.projects-container .project').filter({ hasText: 'Graph Copy Source' }).click();
  await expect(editor.locator('.project-tree-header-title')).toHaveText('Graph Copy Source');
  const sourceFolder = editor.locator('[data-folderpath="Source"]').first();
  await sourceFolder.click({ button: 'right' });
  await editor.locator('.graph-item-context-menu').getByRole('button', { name: 'Copy folder' }).click();
  await editor.locator('.projects-container .project').filter({ hasText: 'Graph Copy Destination' }).click();
  const targetFolder = editor.locator('[data-folderpath="Target"]').first();
  await targetFolder.click({ button: 'right' });
  await editor.locator('.graph-item-context-menu').getByRole('button', { name: 'Paste graphs' }).click();
  await expect(editor.locator('[data-folderpath="Target/Source"]')).toBeVisible();
  await editor.locator('.node-canvas').click({ position: { x: 500, y: 200 } });
  await editor.locator('.node-canvas').press('Control+S');
  await expect.poll(() => savedDestination?.graphs && Object.values(savedDestination.graphs).length).toBe(5);
  expect(Object.values(savedDestination!.graphs).map((graph) => graph.metadata?.name)).toEqual(expect.arrayContaining([
    'Target/Source/Item',
    'Target/Source/Nested/Deep',
  ]));
  const destinationTab = editor.locator('.projects-container .project').filter({ hasText: 'Graph Copy Destination' });
  await destinationTab.hover();
  await destinationTab.locator('.close-project').click();
  await expect(editor.locator('.projects-container .project').filter({ hasText: 'Graph Copy Destination' })).toHaveCount(0);
  await page.locator('.project-row', { hasText: 'Graph Copy Destination' }).dblclick();
  await expect(editor.locator('.project-tree-header-title')).toHaveText('Graph Copy Destination');
  await expect(editor.locator('[data-folderpath="Target/Source"]')).toBeVisible();
  await expect(editor.locator('.graph-item[data-folderpath="Item"]')).toBeVisible();
});
