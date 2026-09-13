import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { createServer, type ServerResponse } from 'node:http';

type EditorRoot = Page | FrameLocator;

for (const scenario of ['text', 'schema', 'parallel-stop', 'abort'] as const) {
  test(`live preview and Watch share a stream: ${scenario}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const firstChunk = scenario === 'schema' ? '{"message":"hello' : 'hello';
    const lastChunk = scenario === 'schema' ? ' world"}' : ' world';
    let response: ServerResponse | undefined;
    const server = createServer((request, reply) => {
      request.resume();
      reply.setHeader('Access-Control-Allow-Origin', '*');
      reply.setHeader('Access-Control-Allow-Headers', '*');
      if (request.method === 'OPTIONS') {
        reply.end();
        return;
      }
      reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.flushHeaders();
      response = reply;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const chunk = (text: string, finish = false) =>
      response!.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: { content: text }, finish_reason: finish ? 'stop' : null }],
          }) +
          '\n\n',
      );
    try {
      await seedHostedEditorProject(page, {
        graphId: 'live-preview',
        projectId: 'live-preview-project',
        title: 'Live preview',
        projectPath: '/workflows/Live preview.rivet-project',
        loaded: true,
        graph: {
          nodes: [
            { id: 'prompt', type: 'text', title: 'Prompt', data: { text: 'fixture' }, visualData: { x: 0, y: 100 } },
            ...(scenario === 'schema'
              ? [
                  {
                    id: 'schema',
                    type: 'object',
                    title: 'Schema',
                    data: {
                      jsonTemplate: JSON.stringify({
                        type: 'object',
                        properties: { message: { type: 'string' } },
                        required: ['message'],
                        additionalProperties: false,
                      }),
                    },
                    visualData: { x: 0, y: 400 },
                  },
                ]
              : []),
            {
              id: 'llm',
              type: 'llmChatV2',
              title: 'LLM',
              data: {
                configurationMode: 'inline',
                provider: 'custom',
                customProviderApi: 'completions',
                customProviderBaseURL: 'http://127.0.0.1:' + address.port + '/v1',
                apiKeySource: 'input',
                model: 'fixture',
                useAsGraphPartialOutput: true,
                useToolCalling: false,
                responseFormat: scenario === 'schema' ? 'json_schema' : 'text',
              },
              visualData: { x: 300, y: 100, width: 260 },
            },
            {
              id: 'consumer',
              type: 'text',
              title: 'Consumer',
              data: { text: '{{input}}' },
              visualData: { x: 650, y: 100, width: 280 },
            },
            {
              id: 'watch',
              type: 'watchStreamingOutput',
              title: 'Watch',
              data: {
                triggerMode: 'every-update',
                executionMode: scenario === 'parallel-stop' ? 'parallel' : 'sequential',
                maxParallelRuns: 2,
                maxQueuedUpdates: 32,
              },
              visualData: { x: 650, y: 500 },
            },
            {
              id: 'branch',
              type: 'text',
              title: 'Branch',
              data: { text: '{{input}}' },
              visualData: { x: 1000, y: 500 },
            },
            ...(scenario === 'parallel-stop'
              ? [
                  {
                    id: 'stop',
                    type: 'stopWatchingStreamingOutput',
                    title: 'Stop',
                    data: {},
                    visualData: { x: 1000, y: 800 },
                  },
                ]
              : []),
          ],
          connections: [
            { outputNodeId: 'prompt', outputId: 'output', inputNodeId: 'llm', inputId: 'prompt' },
            { outputNodeId: 'prompt', outputId: 'output', inputNodeId: 'llm', inputId: 'apiKey' },
            ...(scenario === 'schema'
              ? [{ outputNodeId: 'schema', outputId: 'output', inputNodeId: 'llm', inputId: 'responseSchema' }]
              : []),
            { outputNodeId: 'llm', outputId: 'response', inputNodeId: 'consumer', inputId: 'input' },
            { outputNodeId: 'llm', outputId: 'response', inputNodeId: 'watch', inputId: 'stream' },
            { outputNodeId: 'watch', outputId: 'value', inputNodeId: 'branch', inputId: 'input' },
            ...(scenario === 'parallel-stop'
              ? [{ outputNodeId: 'branch', outputId: 'output', inputNodeId: 'stop', inputId: 'value' }]
              : []),
          ],
        },
      });
      await page.addInitScript(() =>
        localStorage.setItem(
          'recoil-persist',
          JSON.stringify({
            defaultExecutor: 'browser',
            recordExecutions: false,
          }),
        ),
      );
      await page.route('**/api/**', (route) =>
        ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort(),
      );
      await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      const editor = await getEditorRoot(page);
      const consumer = editor.locator('.node[data-nodeid="consumer"]');
      await expect(consumer).toBeVisible({ timeout: 60_000 });
      await editor.locator('.run-button button').first().click();
      await expect.poll(() => Boolean(response), { timeout: 30_000 }).toBe(true);
      chunk(firstChunk);
      await expect(consumer.locator('.live-streaming-input-preview')).toContainText('hello');
      await expect(consumer).not.toHaveClass(/success/);
      await expect(editor.locator('.node[data-nodeid="branch"] .node-output')).toContainText('hello');
      if (scenario === 'parallel-stop') {
        await expect(editor.locator('.node[data-nodeid="stop"] .node-output')).toContainText('hello');
        await expect(editor.locator('.node[data-nodeid="stop"]')).toHaveClass(/success/);
      }
      if (scenario === 'abort') {
        await editor.locator('.run-button button').first().click();
        await expect(consumer.locator('.live-streaming-input-preview')).toHaveCount(0);
        await expect(consumer).not.toHaveClass(/success/);
        expect(pageErrors).toEqual([]);
        return;
      }
      chunk(lastChunk);
      await expect(consumer.locator('.live-streaming-input-preview')).toContainText('hello world');
      chunk('', true);
      response!.end('data: [DONE]\n\n');
      await expect(consumer).toHaveClass(/success/);
      await expect(consumer.locator('.live-streaming-input-preview')).toHaveCount(0);
      await expect(consumer.locator('.node-output')).toContainText('hello world');
      if (scenario === 'parallel-stop') {
        // Stopping Watch must not abort the LLM or replace its winning output.
        await expect(editor.locator('.node[data-nodeid="stop"] .node-output')).not.toContainText('world');
      }
      expect(pageErrors).toEqual([]);
    } finally {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

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

test('Watch Streaming Output accepts a named Subgraph streaming output', async ({ page }) => {
  const graphId = 'watch-subgraph-streaming-output-graph';
  const childGraphId = 'streaming-child-graph';

  await seedHostedEditorProject(page, {
    graph: {
      nodes: [
        {
          data: { graphId: childGraphId },
          id: 'streaming-subgraph',
          title: 'Streaming child',
          type: 'subGraph',
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
          id: 'watch-subgraph-output',
          title: 'Watch Streaming Output',
          type: 'watchStreamingOutput',
          visualData: { width: 230, x: 450, y: 300 },
        },
      ],
      connections: [
        {
          inputId: 'stream',
          inputNodeId: 'watch-subgraph-output',
          outputId: 'response',
          outputNodeId: 'streaming-subgraph',
        },
      ],
    },
    extraGraphs: [
      {
        id: childGraphId,
        name: 'Streaming child',
        nodes: [
          {
            data: {},
            id: 'child-llm',
            title: 'LLM Chat',
            type: 'llmChatV2',
            visualData: { width: 260, x: 50, y: 300 },
          },
          {
            data: { dataType: 'string', id: 'response' },
            id: 'child-response-output',
            title: 'Graph Output',
            type: 'graphOutput',
            visualData: { width: 220, x: 400, y: 300 },
          },
        ],
        connections: [
          {
            inputId: 'value',
            inputNodeId: 'child-response-output',
            outputId: 'response',
            outputNodeId: 'child-llm',
          },
        ],
      },
    ],
    graphId,
    loaded: true,
    projectId: 'watch-subgraph-streaming-output-project',
    projectPath: '/workflows/Watch Subgraph Streaming Output.rivet-project',
    title: 'Watch Subgraph Streaming Output',
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editor = await getEditorRoot(page);
  const subgraph = editor.locator('.node[data-nodeid="streaming-subgraph"]');
  const watch = editor.locator('.node[data-nodeid="watch-subgraph-output"]');
  await expect(subgraph).toBeVisible({ timeout: 60_000 });
  await expect(subgraph.locator('.output-port[data-portid="response"]')).toBeVisible();
  await expect(watch.locator('.input-port[data-portid="stream"]')).toBeVisible();

  const streamingWatchMarkers = editor.locator('svg .streaming-output-watch-marker-path');
  await expect.poll(async () => streamingWatchMarkers.count()).toBeGreaterThan(1);
});
