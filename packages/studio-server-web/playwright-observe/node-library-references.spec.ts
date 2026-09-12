import { expect, test } from '@playwright/test';
import { serializeProject, type Project } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('library references count instances and navigate to the chosen graph node', async ({ page }, testInfo) => {
  const source = {
    id: 'source',
    type: 'text',
    title: 'Reusable text',
    data: { text: 'Hello' },
    visualData: { x: 0, y: 0, width: 300 },
  };
  const project = {
    metadata: { id: 'library-reference-project', title: 'Library references', description: '', mainGraphId: 'graph-a' },
    graphs: {
      'graph-a': {
        metadata: { id: 'graph-a', name: 'Graph A', description: '' },
        nodes: ['first', 'second'].map((id, index) => ({
          id,
          type: 'nodePrefabInstance',
          title: 'Linked text',
          data: { prefabId: 'prefab' },
          visualData: { x: index * 400, y: 0, width: 300 },
        })),
        connections: [],
      },
      'graph-b': {
        metadata: { id: 'graph-b', name: 'Graph B', description: '' },
        nodes: [
          {
            id: 'third',
            type: 'nodePrefabInstance',
            title: 'Linked text',
            data: { prefabId: 'prefab' },
            visualData: { x: 0, y: 0, width: 300 },
          },
        ],
        connections: [],
      },
    },
    nodePrefabs: { prefab: { id: 'prefab', sourceNode: source } },
    plugins: [],
    references: [],
  } as unknown as Project;
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        projects: [
          {
            id: 'Library references.rivet-project',
            projectMetadataId: project.metadata.id,
            name: 'Library references',
            fileName: 'Library references.rivet-project',
            relativePath: 'Library references.rivet-project',
            absolutePath: '/workflows/Library references.rivet-project',
            updatedAt: '2026-09-11T00:00:00Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
      },
    }),
  );
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: {
        contents: serializeProject(project),
        datasetsContents: null,
        revisionId: null,
      },
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'Library references' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.getByText('Node library', { exact: true }).click();
  const references = editor.locator('.node-library-references');
  await expect(references).toHaveCount(1);
  const sourceNode = editor.locator('.node[data-nodeid="source"]');
  const collapsedNodeBounds = await sourceNode.boundingBox();
  await references.locator('summary').click();
  await expect(references.locator('summary')).toHaveText('3 references');
  await expect(references.getByRole('button')).toHaveCount(3);
  const annotationColor = await references.evaluate((element) => getComputedStyle(element).color);
  const linkColor = await references.getByRole('button').first().evaluate((element) => getComputedStyle(element).color);
  expect(linkColor).toBe(annotationColor);
  const expandedNodeBounds = await sourceNode.boundingBox();
  const referenceBounds = await references.boundingBox();
  expect(collapsedNodeBounds).not.toBeNull();
  expect(expandedNodeBounds).not.toBeNull();
  expect(referenceBounds).not.toBeNull();
  expect(expandedNodeBounds!.height).toBe(collapsedNodeBounds!.height);
  expect(expandedNodeBounds!.width).toBe(collapsedNodeBounds!.width);
  expect(referenceBounds!.y).toBeGreaterThan(expandedNodeBounds!.y + expandedNodeBounds!.height);
  await references.hover();
  await expect(sourceNode).not.toHaveClass(/hovered/);
  await page.screenshot({ path: testInfo.outputPath('node-library-references.png') });
  await references.getByRole('button', { name: 'Graph B · third' }).click();
  await expect(editor.locator('.node.selected[data-nodeid="third"]')).toBeVisible();
  await expect(editor.locator('.node-library-references')).toHaveCount(0);
});
