import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

type EditorRoot = Page | FrameLocator;

async function getEditorRoot(page: Page): Promise<EditorRoot> {
  const editorFrame = page.locator('iframe.dashboard-editor-frame');
  const timeoutAt = Date.now() + 20_000;

  while (Date.now() < timeoutAt) {
    if ((await editorFrame.count()) > 0) {
      return page.frameLocator('iframe.dashboard-editor-frame');
    }

    if (
      await page
        .locator('.node-canvas')
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return page;
    }

    await page.waitForTimeout(100);
  }

  throw new Error('Hosted editor did not mount in iframe or direct mode.');
}

test('Watch Streaming Output exposes its chunk outputs', async ({ page }) => {
  const graphId = 'watch-streaming-output-graph';

  await seedHostedEditorProject(page, {
    graph: {
      nodes: [
        {
          data: {
            useAsGraphPartialOutput: true,
          },
          id: 'streaming-llm',
          title: 'LLM Chat',
          type: 'llmChatV2',
          visualData: { width: 260, x: 50, y: 300 },
        },
        {
          data: {
            executionMode: 'sequential',
            intervalMs: 1_000,
            maxParallelRuns: 4,
            maxQueuedUpdates: 32,
            triggerMode: 'every-update',
          },
          id: 'watch-streaming-output',
          title: 'Watch Streaming Output',
          type: 'watchStreamingOutput',
          visualData: { width: 230, x: 450, y: 300 },
        },
        {
          data: {},
          id: 'stop-watching-streaming-output',
          title: 'Stop Watching Streaming Output',
          type: 'stopWatchingStreamingOutput',
          visualData: { width: 230, x: 450, y: 600 },
        },
      ],
      connections: [
        {
          inputId: 'stream',
          inputNodeId: 'watch-streaming-output',
          outputId: 'response',
          outputNodeId: 'streaming-llm',
        },
      ],
    },
    graphId,
    loaded: true,
    projectId: 'watch-streaming-output-project',
    projectPath: '/workflows/Watch Streaming Output.rivet-project',
    title: 'Watch Streaming Output',
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editor = await getEditorRoot(page);
  const watch = editor.locator('.node[data-nodeid="watch-streaming-output"]');
  const chunkOutput = watch.locator('.output-port[data-portid="value"]');
  const allChunksOutput = watch.locator('.output-port[data-portid="allStreamedOutput"]');
  const chunkIndexOutput = watch.locator('.output-port[data-portid="updateIndex"]');

  await expect(watch).toBeVisible({ timeout: 60_000 });
  await expect(editor.locator('.node[data-nodeid="stop-watching-streaming-output"]')).toContainText(
    'First completed Stop continues',
  );
  await expect(chunkOutput).toBeVisible();
  await expect(chunkOutput.locator('..')).toContainText('Chunk');
  await expect(allChunksOutput).toBeVisible();
  await expect(allChunksOutput.locator('..')).toContainText('All Chunks');
  await expect(chunkIndexOutput).toBeVisible();
  await expect(chunkIndexOutput.locator('..')).toContainText('Chunk Index');

  const streamingWatchMarkers = editor.locator('svg .streaming-output-watch-marker-path');
  await expect.poll(async () => streamingWatchMarkers.count()).toBeGreaterThan(1);
  const markerAttributes = await streamingWatchMarkers.evaluateAll((paths) =>
    paths.map((path) => ({
      markerEnd: path.getAttribute('marker-end'),
      markerStart: path.getAttribute('marker-start'),
    })),
  );
  expect(markerAttributes.every(({ markerEnd }) => markerEnd?.startsWith('url(#tool-continuation-'))).toBe(true);
  expect(markerAttributes.every(({ markerStart }) => markerStart == null)).toBe(true);

  await watch.hover();
  await watch.locator('.edit-button').click();

  await expect(editor.getByLabel('Interval (ms)')).toHaveCount(0);
  await expect(editor.getByLabel('Maximum parallel runs')).toHaveCount(0);
  await expect(editor.getByLabel('On queue overflow')).toBeVisible();
  await expect(editor.getByText('Fail run', { exact: true })).toBeVisible();

  await editor.getByLabel('On queue overflow').click();
  await editor.getByText('Drop new update', { exact: true }).click();
  await expect(editor.getByText('Drop new update', { exact: true })).toBeVisible();

  await editor.getByLabel('Trigger').click();
  await editor.getByText('Every N milliseconds', { exact: true }).click();
  await expect(editor.getByLabel('Interval (ms)')).toBeVisible();

  await editor.getByLabel('Branch execution').click();
  await editor.getByText('Parallel', { exact: true }).click();
  await expect(editor.getByLabel('Maximum parallel runs')).toBeVisible();
});
