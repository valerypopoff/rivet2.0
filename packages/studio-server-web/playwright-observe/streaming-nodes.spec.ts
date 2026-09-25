import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Streaming nodes show header icons and Catch streaming chunks has a once-only count', async ({ page }) => {
  await seedHostedEditorProject(page, {
    graph: {
      nodes: [
        { id: 'early-value', type: 'streamValue', title: 'Stream value', data: {}, visualData: { x: 50, y: 300 } },
        { id: 'first-chunk', type: 'catchStreamingChunks', title: 'Catch streaming chunks', data: { count: 1 }, visualData: { x: 450, y: 300 } },
        { id: 'watch', type: 'watchStreamingOutput', title: 'Watch Streaming Output', data: {}, visualData: { x: 50, y: 600 } },
        { id: 'stop', type: 'stopWatchingStreamingOutput', title: 'Stop Watching Streaming Output', data: {}, visualData: { x: 450, y: 600 } },
      ],
      connections: [
        { inputId: 'stream', inputNodeId: 'first-chunk', outputId: 'value', outputNodeId: 'early-value' },
      ],
    },
    graphId: 'catch-streaming-chunks-graph',
    loaded: true,
    projectId: 'catch-streaming-chunks-project',
    projectPath: '/workflows/Catch streaming chunks.rivet-project',
    title: 'Catch streaming chunks',
  });
  await mockHostedEditorBootstrap(page);

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  const frame = page.locator('iframe.dashboard-editor-frame');
  await expect.poll(async () => (await frame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
    timeout: 60_000,
  }).toBe(true);
  const editor = (await frame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
  const emitter = editor.locator('.node[data-nodeid="early-value"]');
  const take = editor.locator('.node[data-nodeid="first-chunk"]');
  await expect(emitter).toBeVisible({ timeout: 60_000 });
  await expect(emitter.locator('.output-port[data-portid="value"]')).toBeVisible();
  await expect(take.locator('.input-port[data-portid="stream"]')).toBeVisible();
  await expect(take.locator('.output-port[data-portid="value"]')).toBeVisible();
  for (const id of ['early-value', 'first-chunk', 'watch', 'stop']) {
    await expect(editor.locator(`.node[data-nodeid="${id}"] .streaming-node-title-icon`)).toBeVisible();
  }
  await take.hover();
  await take.locator('.edit-button').click();
  await expect(editor.getByLabel('Number of chunks')).toBeVisible();
  await expect(editor.getByLabel('Number of chunks')).toHaveValue('1');
  await expect(editor.getByText('Many parallel runs', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('Many sequential runs', { exact: true })).toHaveCount(0);
});

test('Streaming menu uses the requested order and creates a Watch streaming node', async ({ page }) => {
  await seedHostedEditorProject(page, {
    graphId: 'streaming-menu-graph',
    loaded: true,
    projectId: 'streaming-menu-project',
    projectPath: '/workflows/Streaming menu.rivet-project',
    title: 'Streaming menu',
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  const frame = page.locator('iframe.dashboard-editor-frame');
  await expect.poll(async () => (await frame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
    timeout: 60_000,
  }).toBe(true);
  const editor = (await frame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
  await editor.locator('.node-canvas').click({ button: 'right', position: { x: 500, y: 350 } });
  await editor.locator('.context-menu-label-text', { hasText: /^Add node$/ }).hover();
  await editor.locator('.context-menu-label-text', { hasText: /^Streaming$/ }).hover();
  const labels = editor.locator('.context-menu-items .context-menu-label-text').filter({
    hasText: /^(Stream value|Catch streaming chunks|Watch streaming|Stop watching streaming)$/,
  });
  await expect(labels).toHaveText([
    'Stream value',
    'Catch streaming chunks',
    'Watch streaming',
    'Stop watching streaming',
  ]);
  await editor.locator('.context-menu-label-text', { hasText: /^Watch streaming$/ }).click();
  await expect(editor.locator('.node-title', { hasText: /^Watch streaming$/ })).toBeVisible();
});

for (const streamable of [true, false]) {
  test(`cross-project Subgraph wire ${streamable ? 'shows' : 'omits'} arrows for a ${streamable ? 'streamable' : 'plain'} output`, async ({ page }) => {
    await seedHostedEditorProject(page, {
      graph: {
        nodes: [
          {
            id: 'external-caller',
            type: 'subGraph',
            title: 'Other project',
            data: {
              graphId: 'child',
              targetScope: 'other-projects',
              targetProjectId: 'external-project',
              targetVersion: 'latest',
              targetBoundary: {
                inputs: [],
                outputs: [{ dataType: 'string', id: 'answer', nodeId: 'child-out', portId: 'answer' }],
              },
            },
            visualData: { x: 50, y: 250 },
          },
          { id: 'watch', type: 'watchStreamingOutput', title: 'Watch', data: {}, visualData: { x: 550, y: 250 } },
        ],
        connections: [
          { outputNodeId: 'external-caller', outputId: 'answer', inputNodeId: 'watch', inputId: 'stream' },
        ],
      },
      graphId: 'root',
      loaded: true,
      projectId: 'caller-project',
      projectPath: '/workflows/Caller.rivet-project',
      title: 'Caller',
    });
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', async (route) => {
      await route.fulfill({ json: {
        root: '/workflows',
        folders: [],
        projects: [{
          id: 'external-project',
          name: 'External',
          relativePath: 'External.rivet-project',
          settings: { status: 'unpublished' },
        }],
      } });
    });
    await page.route('**/api/workflows/subgraph-projects/external-project/preview?version=latest', async (route) => {
      await route.fulfill({ json: {
        revisionKey: 'test-revision',
        streamingOutputNodeIdsByGraph: { child: streamable ? ['child-out'] : [] },
        project: {
          metadata: { id: 'external-project', title: 'External', mainGraphId: 'child' },
          graphs: {
            child: {
              metadata: { id: 'child', name: 'Main Graph' },
              nodes: [{ id: 'child-out', type: 'graphOutput', data: { id: 'answer', dataType: 'string' } }],
              connections: [],
            },
          },
        },
      } });
    });

    await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    const frame = page.locator('iframe.dashboard-editor-frame');
    await expect.poll(async () => (await frame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
      timeout: 60_000,
    }).toBe(true);
    const editor = (await frame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
    await expect(editor.locator('.node[data-nodeid="external-caller"]')).toBeVisible({ timeout: 60_000 });
    await expect(editor.locator('.node[data-nodeid="watch"]')).toBeVisible();
    const markers = editor.locator('.streaming-output-watch-marker-path');
    if (streamable) {
      await expect(markers.first()).toBeVisible();
    } else {
      await expect(markers).toHaveCount(0);
    }
  });
}
