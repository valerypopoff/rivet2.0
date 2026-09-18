import { expect, test, type Page, type Request } from '@playwright/test';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import {
  createBuiltInRegistry,
  ExecutionRecorder,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createProcessor } from '../../node/src/api.js';
import { startDebuggerServer } from '../../node/src/debugger.js';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';

const transientWindowsBootstrapFailures = new Set(['net::ERR_NO_BUFFER_SPACE', 'net::ERR_INSUFFICIENT_RESOURCES']);

function isTransientWindowsBootstrapError(error: unknown) {
  return (
    error instanceof Error && [...transientWindowsBootstrapFailures].some((failure) => error.message.includes(failure))
  );
}

async function openHostedEditor(page: Page) {
  const baseOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8080').origin;
  const bootstrapFailures: string[] = [];
  const recordBootstrapFailure = (request: Request) => {
    const failure = request.failure()?.errorText;
    if (
      failure &&
      transientWindowsBootstrapFailures.has(failure) &&
      new URL(request.url()).origin === baseOrigin &&
      request.resourceType() === 'script'
    ) {
      bootstrapFailures.push(`${failure}: ${request.url()}`);
    }
  };
  const editorMounted = async () =>
    (await page.locator('iframe.dashboard-editor-frame').count()) > 0 ||
    (await page.locator('.node-canvas').first().isVisible());

  page.on('requestfailed', recordBootstrapFailure);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      bootstrapFailures.length = 0;
      try {
        await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
        await authenticateIfNeeded(page);
      } catch (error) {
        if (!isTransientWindowsBootstrapError(error) || attempt === 2) throw error;
        await page.waitForTimeout(250);
        continue;
      }

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await editorMounted()) return;
        if (bootstrapFailures.length > 0) break;
        await page.waitForTimeout(100);
      }

      if (bootstrapFailures.length === 0) {
        throw new Error('Hosted editor did not mount within 60 seconds');
      }
      if (attempt === 2) {
        throw new Error(`Hosted editor bootstrap repeatedly exhausted local sockets:\n${bootstrapFailures.join('\n')}`);
      }

      await page.waitForTimeout(250);
    }
  } finally {
    page.off('requestfailed', recordBootstrapFailure);
  }
}

test('remote conditional producer keeps independent nested Watch pages for two field callers', async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  let response: ServerResponse | undefined;
  const server = createServer((request, reply) => {
    request.resume();
    reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.flushHeaders();
    response = reply;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stream fixture address');
  const debuggerServer = startDebuggerServer({ port: 0, host: '127.0.0.1', heartbeatIntervalMs: 0 });
  await once(debuggerServer.webSocketServer, 'listening');
  const debuggerAddress = debuggerServer.webSocketServer.address();
  if (typeof debuggerAddress === 'string') throw new Error('Missing debugger fixture address');
  const registry = createBuiltInRegistry();
  const node = (id: string, type: string, data: object, x: number, y: number): ChartNode => {
    const created = registry.createDynamic(type);
    return {
      ...created,
      id: id as NodeId,
      title: id,
      data: { ...(created.data as object), ...data },
      visualData: { x, y, width: 240 },
    };
  };
  const edge = (from: string, output: string, to: string, input: string): NodeConnection => ({
    outputNodeId: from as NodeId,
    outputId: output as PortId,
    inputNodeId: to as NodeId,
    inputId: input as PortId,
  });
  const graph = (id: string, nodes: ChartNode[], connections: NodeConnection[]): NodeGraph => ({
    metadata: { id: id as GraphId, name: id === 'main' ? 'Main Graph' : id, description: '' },
    nodes,
    connections,
  });
  const producer = graph(
    'producer',
    [
      node('prompt', 'text', { text: 'fixture' }, 0, 0),
      node(
        'llm',
        'llmChatV2',
        {
          configurationMode: 'inline',
          provider: 'custom',
          customProviderApi: 'completions',
          customProviderBaseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKeySource: 'input',
          model: 'fixture',
          useAsGraphPartialOutput: true,
          useToolCalling: false,
          responseFormat: 'text',
        },
        300,
        0,
      ),
      node('producer-output', 'graphOutput', { id: 'stream', dataType: 'string' }, 600, 0),
    ],
    [
      edge('prompt', 'output', 'llm', 'prompt'),
      edge('prompt', 'output', 'llm', 'apiKey'),
      edge('llm', 'response', 'producer-output', 'value'),
    ],
  );
  const child = graph(
    'extract',
    [
      node('stream', 'graphInput', { id: 'stream', dataType: 'string' }, 0, 100),
      node(
        'watch',
        'watchStreamingOutput',
        { executionMode: 'parallel', maxParallelRuns: 25, triggerMode: 'every-update' },
        300,
        100,
      ),
      node('did-run', 'didRun', {}, 300, 330),
      { ...node('field', 'graphInput', { id: 'fieldName', dataType: 'string' }, 600, 330), isConditional: true },
      node('join', 'expression', { expression: '{{chunks}}.join("")' }, 600, 100),
      node('branch', 'text', { text: '{{fieldName}}:{{input}}' }, 900, 100),
      node(
        'ready',
        'expression',
        { expression: '{{value}}.includes({{fieldName}} === "alpha" ? "four" : "five")' },
        900,
        400,
      ),
      { ...node('stop', 'stopWatchingStreamingOutput', {}, 1200, 100), isConditional: true },
      node('result', 'graphOutput', { id: 'value', dataType: 'string' }, 1500, 100),
      node('ordinary', 'text', { text: '{{input}}' }, 0, 450),
    ],
    [
      edge('stream', 'data', 'watch', 'stream'),
      edge('stream', 'data', 'ordinary', 'input'),
      edge('watch', 'allStreamedOutput', 'did-run', 'input1'),
      edge('did-run', 'ran', 'field', '$if'),
      edge('watch', 'allStreamedOutput', 'join', 'chunks'),
      edge('join', 'output', 'branch', 'input'),
      edge('field', 'data', 'branch', 'fieldName'),
      edge('branch', 'output', 'ready', 'value'),
      edge('field', 'data', 'ready', 'fieldName'),
      edge('ready', 'output', 'stop', '$if'),
      edge('branch', 'output', 'stop', 'value'),
      edge('stop', 'value', 'result', 'value'),
    ],
  );
  const main = graph(
    'main',
    [
      node('condition', 'boolean', { value: true }, 0, 100),
      { ...node('producer-call', 'subGraph', { graphId: 'producer' }, 300, 100), isConditional: true },
      ...['alpha', 'beta'].map((name, index) =>
        node(
          name,
          'subGraph',
          { graphId: 'extract', inputData: { fieldName: { type: 'string', value: name } } },
          650,
          100 + index * 260,
        ),
      ),
    ],
    [
      edge('condition', 'value', 'producer-call', '$if'),
      ...['alpha', 'beta'].map((name) => edge('producer-call', 'stream', name, 'stream')),
    ],
  );
  const project: Project = {
    metadata: {
      id: 'remote-watch-project' as ProjectId,
      title: 'Remote Watch',
      description: '',
      mainGraphId: 'main' as GraphId,
    },
    graphs: { main, producer, extract: child },
    plugins: [],
  };
  const runner = createProcessor(project, { graph: 'main', remoteDebugger: debuggerServer });
  const recorder = new ExecutionRecorder();
  const recordingFinished = recorder.once('finish');
  recorder.record(runner.processor);
  let run: ReturnType<typeof runner.run> | undefined;
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seedHostedEditorProject(page, {
      projectId: project.metadata.id,
      graphId: 'main',
      title: 'Remote Watch',
      projectPath: '/workflows/Remote Watch.rivet-project',
      loaded: true,
      graph: main,
      extraGraphs: [producer, child].map((item) => ({
        id: item.metadata!.id!,
        name: item.metadata!.name,
        nodes: item.nodes,
        connections: item.connections,
      })),
    });
    await page.addInitScript(() => {
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: true }));
    });
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
    await openHostedEditor(page);
    const editor = (await page.locator('iframe.dashboard-editor-frame').count())
      ? page.frameLocator('iframe.dashboard-editor-frame')
      : page;
    await expect(editor.locator('.node[data-nodeid="alpha"]')).toBeVisible();
    await editor.locator('button.more-menu').click();
    await editor.getByRole('button', { name: 'Remote Debugger', exact: true }).click();
    await editor.getByPlaceholder('(Default)').fill(`ws://127.0.0.1:${debuggerAddress.port}`);
    await editor.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(editor.getByText('Stop Remote Debugger', { exact: true })).toBeVisible();
    run = runner.run();
    // Attach rejection immediately; cleanup awaits and surfaces it below.
    void run.catch(() => {});
    await expect.poll(() => Boolean(response), { timeout: 30_000 }).toBe(true);
    const openCaller = async (name: string) => {
      await editor.getByRole('button', { name: /^(Graph running )?Main Graph$/ }).click();
      await editor
        .locator(`.node[data-nodeid="${name}"]`)
        .getByRole('button', { name: 'Go to subgraph', exact: true })
        .click();
      await expect(editor.locator('.node[data-nodeid="branch"]')).toBeVisible();
    };
    await openCaller('alpha');
    const output = editor.locator('.node[data-nodeid="branch"] .node-output');
    for (const text of ['one', ' two', ' three', ' four', ' five']) {
      response!.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      );
      // First three retained iterations arrive before the remote producer finishes.
      if (['one', ' two', ' three'].includes(text)) {
        if (text !== 'one') {
          await expect(output).toHaveClass(/multi/);
          await output.locator('.picker-right').click();
        }
        await expect(output).toContainText(text.trim());
        await expect(editor.locator('.node[data-nodeid="ordinary"] .node-output')).toHaveCount(0);
      } else {
        // Later evidence is deliberately buffered until Watch settles.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    response!.end('data: [DONE]\n\n');
    await run;
    const verifyPages = async (name: string, finalWord: string) => {
      await openCaller(name);
      await expect(output).toHaveClass(/multi/);
      for (let index = 0; index < 3; index++) await output.locator('.picker-left').click();
      await expect(output).toContainText(`${name}:one`);
      await expect(output).not.toContainText('two');
      await expect(output.locator('.picker-page')).toHaveText('1');
      for (const [index, word] of ['two', 'three', finalWord].entries()) {
        await output.locator('.picker-right').click();
        await expect(output.locator('.picker-page')).toHaveText(index === 2 ? 'Terminal' : String(index + 2));
        await expect(output).toContainText(`${name}:one`);
        await expect(output).toContainText(word);
      }
      if (name === 'alpha') await expect(output).not.toContainText('five');
      await expect(output).toContainText('Terminal');
      const stop = editor.locator('.node[data-nodeid="stop"] .node-output');
      await expect(stop).toContainText(`${name}:one`);
      await expect(stop).toContainText(finalWord);
      await expect(stop).not.toHaveClass(/multi/);
      const ordinary = editor.locator('.node[data-nodeid="ordinary"] .node-output');
      await expect(ordinary).toContainText('one two three four five');
      await expect(ordinary).not.toHaveClass(/multi/);
      await output.hover();
      await output.locator('.expand-button').click();
      const fullscreen = editor.getByTestId('fullscreen-output-modal');
      await expect(fullscreen).toContainText('Terminal');
      await expect(fullscreen).toContainText(`${name}:one`);
      await page.keyboard.press('Escape');
    };
    await verifyPages('alpha', 'four');
    await verifyPages('beta', 'five');
    // External debugger runs are recorded by their host, not by the editor's Run button.
    await recordingFinished;
    for (const frame of page.frames()) {
      await frame.evaluate((recording) => {
        Object.defineProperty(window, 'showOpenFilePicker', {
          configurable: true,
          value: async () => [
            {
              name: 'watch.rivet-recording',
              getFile: async () => new File([recording], 'watch.rivet-recording'),
            },
          ],
        });
      }, recorder.serialize());
    }
    await editor.locator('button.more-menu').click();
    await editor.getByRole('button', { name: 'Load Recording', exact: true }).click();
    await editor.getByRole('button', { name: 'Play Recording', exact: true }).click();
    await verifyPages('alpha', 'four');
    await verifyPages('beta', 'five');
  } finally {
    response?.end();
    if (run) {
      await runner.processor.abort();
      await run.catch(() => {});
    }
    runner.dispose();
    for (const client of debuggerServer.webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => debuggerServer.webSocketServer.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
