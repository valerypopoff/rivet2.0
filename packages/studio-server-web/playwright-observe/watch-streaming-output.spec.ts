import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject, type SeedHostedEditorProjectOptions } from './helpers/hostedEditorStorage';
import { createServer, type ServerResponse } from 'node:http';

type EditorRoot = Page | FrameLocator;

test.beforeEach(async ({ page }) => {
  await page.route('**/api/workflows/evaluation-runs/library', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        resourceVersions: { suites: {}, datasets: {} },
        library: {
          version: 1,
          data: { version: 1, suites: [], baselines: [] },
          datasets: [],
          migratedLegacyProjectIds: [],
        },
      },
    }),
  );
});

for (const scenario of [
  'text',
  'schema',
  'parallel-stop',
  'unmatched-stop',
  'abort',
  'nested-input',
  'deep-input',
  'nested-stop',
] as const) {
  test(`live preview and Watch share a stream: ${scenario}`, async ({ page }) => {
    const pageErrors: string[] = [];
    const hasStop = scenario === 'parallel-stop' || scenario === 'unmatched-stop' || scenario === 'nested-stop';
    const nestedInput = scenario === 'nested-input' || scenario === 'deep-input' || scenario === 'nested-stop';
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
      const seed: SeedHostedEditorProjectOptions = {
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
              type: scenario === 'unmatched-stop' ? 'if' : 'text',
              title: scenario === 'unmatched-stop' ? 'Never Stop' : 'Branch',
              // An unconnected If condition is false, so its True output is
              // excluded on every Watch iteration and Stop is never reached.
              data: scenario === 'unmatched-stop' ? {} : { text: '{{input}}' },
              visualData: { x: 1000, y: 500 },
            },
            ...(hasStop
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
            ...(scenario === 'unmatched-stop'
              ? [
                  {
                    id: 'after-stop-one',
                    type: 'text',
                    title: 'After Stop one',
                    data: { text: '{{input}}' },
                    visualData: { x: 1300, y: 800 },
                  },
                  {
                    id: 'after-stop-two',
                    type: 'text',
                    title: 'After Stop two',
                    data: { text: '{{input}}' },
                    visualData: { x: 1600, y: 800 },
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
            {
              outputNodeId: 'watch',
              outputId: 'value',
              inputNodeId: 'branch',
              inputId: scenario === 'unmatched-stop' ? 'value' : 'input',
            },
            ...(hasStop ? [{ outputNodeId: 'branch', outputId: 'output', inputNodeId: 'stop', inputId: 'value' }] : []),
            ...(scenario === 'unmatched-stop'
              ? [
                  { outputNodeId: 'stop', outputId: 'value', inputNodeId: 'after-stop-one', inputId: 'input' },
                  {
                    outputNodeId: 'after-stop-one',
                    outputId: 'output',
                    inputNodeId: 'after-stop-two',
                    inputId: 'input',
                  },
                ]
              : []),
          ],
        },
      };
      if (nestedInput) {
        const nodes = seed.graph!.nodes! as Array<{
          id: string;
          type: string;
          data: unknown;
          title: string;
          visualData: unknown;
        }>;
        const connections = seed.graph!.connections! as Array<{
          inputNodeId: string;
          inputId: string;
          outputNodeId: string;
          outputId: string;
        }>;
        const childNodes = nodes.filter((node) => ['consumer', 'watch', 'branch', 'stop'].includes(node.id));
        childNodes.push({
          id: 'stream-input',
          type: 'graphInput',
          title: 'Graph Input',
          data: { id: 'stream', dataType: 'string' },
          visualData: { x: 300, y: 100 },
        });
        seed.extraGraphs = [
          {
            id: 'watch-child',
            name: 'Watch child',
            nodes: childNodes,
            connections: connections
              .filter((edge) => ['consumer', 'watch', 'branch', 'stop'].includes(edge.inputNodeId))
              .map((edge) =>
                edge.outputNodeId === 'llm' ? { ...edge, outputNodeId: 'stream-input', outputId: 'data' } : edge,
              ),
          },
        ];
        seed.graph = {
          nodes: [
            ...nodes.filter((node) => ['prompt', 'llm'].includes(node.id)),
            {
              id: 'caller',
              type: 'subGraph',
              title: 'Watch child',
              data: { graphId: scenario === 'deep-input' ? 'middle' : 'watch-child' },
              visualData: { x: 650, y: 100 },
            },
          ],
          connections: [
            ...connections.filter((edge) => edge.inputNodeId === 'llm'),
            { outputNodeId: 'llm', outputId: 'response', inputNodeId: 'caller', inputId: 'stream' },
          ],
        };
        if (scenario === 'deep-input')
          seed.extraGraphs.push({
            id: 'middle',
            nodes: [
              {
                id: 'middle-input',
                type: 'graphInput',
                title: 'Graph Input',
                data: { id: 'stream', dataType: 'string' },
                visualData: { x: 300, y: 100 },
              },
              {
                id: 'inner-caller',
                type: 'subGraph',
                title: 'Watch child',
                data: { graphId: 'watch-child' },
                visualData: { x: 650, y: 100 },
              },
            ],
            connections: [
              { outputNodeId: 'middle-input', outputId: 'data', inputNodeId: 'inner-caller', inputId: 'stream' },
            ],
          });
      }
      await seedHostedEditorProject(page, seed);
      await page.addInitScript(
        (record) =>
          localStorage.setItem(
            'recoil-persist',
            JSON.stringify({
              defaultExecutor: 'browser',
              recordExecutions: record,
            }),
          ),
        nestedInput,
      );
      if (nestedInput)
        await page.addInitScript(() => {
          let recording = '';
          Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: async () => ({
              createWritable: async () => ({
                write: async (content: string) => {
                  recording = content;
                },
                close: async () => {},
              }),
            }),
          });
          Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: async () => [
              {
                name: 'nested-watch.rivet-recording',
                getFile: async () => new File([recording], 'nested-watch.rivet-recording'),
              },
            ],
          });
        });
      await page.route('**/api/**', (route) =>
        ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort(),
      );
      await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      const editor = await getEditorRoot(page);
      const consumer = editor.locator('.node[data-nodeid="consumer"]');
      await expect(editor.locator(`.node[data-nodeid="${nestedInput ? 'caller' : 'consumer'}"]`)).toBeVisible({
        timeout: 60_000,
      });
      await editor.locator('.run-button button').first().click();
      await expect.poll(() => Boolean(response), { timeout: 30_000 }).toBe(true);
      if (nestedInput) {
        await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
        if (scenario === 'deep-input')
          await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
        await expect(consumer).toBeVisible();
      }
      chunk(firstChunk);
      if (nestedInput) await expect(consumer.locator('.node-output')).toHaveCount(0);
      else await expect(consumer.locator('.live-streaming-input-preview')).toContainText('hello');
      await expect(consumer).not.toHaveClass(/success/);
      if (scenario !== 'unmatched-stop') {
        await expect(editor.locator('.node[data-nodeid="branch"] .node-output')).toContainText('hello');
      }
      if (scenario === 'parallel-stop' || scenario === 'nested-stop') {
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
      if (nestedInput && !hasStop) {
        const output = editor.locator('.node[data-nodeid="branch"] .node-output');
        await expect(output).toHaveClass(/multi/);
        await output.locator('.picker-right').click();
        await expect(output).toContainText('hello world');
      } else if (!nestedInput)
        await expect(consumer.locator('.live-streaming-input-preview')).toContainText('hello world');
      chunk('', true);
      response!.end('data: [DONE]\n\n');
      await expect(consumer).toHaveClass(/success/);
      await expect(consumer.locator('.live-streaming-input-preview')).toHaveCount(0);
      await expect(consumer.locator('.node-output')).toContainText('hello world');
      if (nestedInput && !hasStop) {
        const branchOutput = editor.locator('.node[data-nodeid="branch"] .node-output');
        await expect(branchOutput).toHaveClass(/multi/);
        await branchOutput.locator('.picker-right').click();
        await expect(branchOutput).toContainText('Terminal');
        await branchOutput.locator('.picker-left').click();
        await branchOutput.locator('.picker-left').click();
        await expect(branchOutput).toContainText('hello');
        await expect(branchOutput).not.toContainText('world');
        await branchOutput.locator('.picker-right').click();
        await branchOutput.locator('.picker-right').click();
        await branchOutput.hover();
        await branchOutput.locator('.expand-button').click();
        const fullscreen = editor.getByTestId('fullscreen-output-modal');
        await expect(fullscreen).toContainText('Terminal');
        await fullscreen.locator('.picker-left').click();
        await fullscreen.locator('.picker-left').click();
        await expect(fullscreen).toContainText('hello');
        await expect(fullscreen).not.toContainText('world');
        await page.keyboard.press('Escape');
        await expect(fullscreen).toHaveCount(0);
        await editor.getByRole('button', { name: 'Save Recording', exact: true }).click();
        await editor.locator('button.more-menu').click();
        await editor.getByRole('button', { name: 'Load Recording', exact: true }).click();
        await editor.getByRole('button', { name: 'Play Recording', exact: true }).click();
        await editor.getByRole('button', { name: 'Main Graph', exact: true }).click();
        await expect(editor.locator('.node[data-nodeid="caller"]')).toBeVisible();
        await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
        if (scenario === 'deep-input')
          await editor.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
        await expect(branchOutput).toHaveClass(/multi/);
        await expect(branchOutput).toContainText('hello');
        await branchOutput.locator('.picker-right').click();
        await branchOutput.locator('.picker-right').click();
        await expect(branchOutput).toContainText('Terminal');
        await expect(branchOutput).toContainText('hello world');
      }
      if (scenario === 'parallel-stop' || scenario === 'nested-stop') {
        // Stopping Watch must not abort the LLM or replace its winning output.
        await expect(editor.locator('.node[data-nodeid="stop"] .node-output')).not.toContainText('world');
        await expect(editor.locator('.node[data-nodeid="stop"] .node-output')).not.toHaveClass(/multi/);
      }
      if (scenario === 'unmatched-stop') {
        const stopOutput = editor.locator('.node[data-nodeid="stop"] .node-output');
        await expect(stopOutput).toContainText('Not ran');
        await expect(editor.locator('.node[data-nodeid="after-stop-one"] .node-output')).toContainText('Not ran');
        await expect(editor.locator('.node[data-nodeid="after-stop-two"] .node-output')).toContainText('Not ran');
        await stopOutput.hover();
        await stopOutput.locator('.expand-button').click();
        await expect(editor.getByTestId('fullscreen-output-modal')).toContainText('Not ran');
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
  await expect
    .poll(async () => (await editorFrame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
      message: 'Hosted editor mounts in iframe or direct mode',
      timeout: 60_000,
    })
    .toBe(true);
  return (await editorFrame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
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
  expect(markerAttributes.every(({ markerEnd }) => markerEnd?.startsWith('url(#wire-arrow-'))).toBe(true);
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
