import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { marked } from 'marked';
import { JSDOM, ResourceLoader } from 'jsdom';
import {
  createRivetWebAppHandler,
  getRivetWebAppAssetManifest,
  getUiGraphChatMessagesStateKey,
  type DataValue,
  type GraphId,
  type NodeGraph,
  type Project,
  RIVET_WEB_APP_DOCUMENT_CSS,
  RIVET_WEB_APP_ASSET_CACHE_CONTROL,
  RIVET_WEB_APP_ASSET_ROUTE,
  RIVET_WEB_APP_RENDERER_CSS,
  RivetWebAppActionHttpError,
  type UiGraphComponent,
  type UiGraphId,
  renderRivetWebAppHtml,
  prepareRivetWebAppAction,
  runRivetWebAppAction,
} from '../src/index.js';

const graphId = 'main-graph' as GraphId;
const ACTION_LOADING_PRESENTATION_WAIT_MS = 350;

function waitForActionLoadingPresentation(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ACTION_LOADING_PRESENTATION_WAIT_MS));
}

function makeProject(): Project {
  const graph: NodeGraph = {
    metadata: {
      description: '',
      id: graphId,
      name: 'Main Graph',
    },
    nodes: [
      {
        id: 'input-node' as any,
        type: 'graphInput',
        title: 'Input',
        visualData: { x: 0, y: 0 },
        data: { dataType: 'string', id: 'input' },
      },
      {
        id: 'output-node' as any,
        type: 'graphOutput',
        title: 'Output',
        visualData: { x: 300, y: 0 },
        data: { dataType: 'string', id: 'value' },
      },
    ],
    connections: [
      {
        inputId: 'value' as any,
        inputNodeId: 'output-node' as any,
        outputId: 'data' as any,
        outputNodeId: 'input-node' as any,
      },
    ],
  };

  return {
    graphs: { [graphId]: graph },
    metadata: {
      description: '',
      id: 'project' as any,
      mainGraphId: graphId,
      title: 'Project',
    },
    uiGraphs: {
      'ui-graph': {
        id: 'ui-graph' as any,
        name: 'Test App',
        components: [
          {
            id: 'run-button' as any,
            type: 'button',
            label: 'Run',
            action: {
              type: 'runGraph',
              graphId,
              inputs: {
                input: { type: 'state', key: 'prompt' },
              },
              outputKey: 'value',
              outputStateKey: 'result',
            },
          },
        ],
      },
    },
  } as Project;
}

function makeExternalStatusProject(): Project {
  const project = makeProject();
  project.graphs[graphId]!.nodes = [
    {
      data: { dataType: 'string', id: 'input' },
      id: 'input-node',
      title: 'Input',
      type: 'graphInput',
      visualData: { x: 0, y: 0 },
    },
    {
      data: { functionName: 'setWebAppStatus', useErrorOutput: false, useFunctionNameInput: false },
      id: 'status-node',
      title: 'Set web app status',
      type: 'externalCall',
      visualData: { x: 200, y: 0 },
    },
    {
      data: { dataType: 'string', id: 'value' },
      id: 'output-node',
      title: 'Output',
      type: 'graphOutput',
      visualData: { x: 400, y: 0 },
    },
  ];
  project.graphs[graphId]!.connections = [
    { inputId: 'arguments', inputNodeId: 'status-node', outputId: 'data', outputNodeId: 'input-node' },
    { inputId: 'value', inputNodeId: 'output-node', outputId: 'result', outputNodeId: 'status-node' },
  ];
  return project;
}

void describe('createRivetWebAppHandler', () => {
  void it('rejects malformed UI graphs before serving requests', () => {
    const project = makeProject();
    project.uiGraphs!['ui-graph' as UiGraphId]!.components = [
      { id: 'broken' as any, label: 'Run', type: 'button' } as UiGraphComponent,
    ];

    assert.throws(
      () => createRivetWebAppHandler(project, { basePath: '/app', uiGraphId: 'ui-graph' }),
      /UI graph "ui-graph" component at index 0\.action/,
    );
  });

  void it('rejects malformed UI graphs passed directly to the HTML renderer', () => {
    const uiGraph = makeProject().uiGraphs!['ui-graph' as UiGraphId]!;
    uiGraph.components = [{ id: 'broken' as any, renderAs: 'html', stateKey: 'result', type: 'output' } as never];

    assert.throws(
      () => renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }),
      /UI graph "ui-graph" component at index 0\.renderAs/,
    );
  });

  void it('rejects malformed or empty action transports at the HTML boundary', () => {
    const uiGraph = makeProject().uiGraphs!['ui-graph' as UiGraphId]!;

    assert.throws(
      () => renderRivetWebAppHtml(uiGraph, { actionTransport: { type: 'http', actionPath: '  ' } }),
      /valid HTTP actionPath or HTTP\/WebSocket socketPath/,
    );
    assert.throws(
      () => renderRivetWebAppHtml(uiGraph, { actionTransport: { type: 'websocket', socketPath: '' } }),
      /valid HTTP actionPath or HTTP\/WebSocket socketPath/,
    );
    assert.throws(
      () => renderRivetWebAppHtml(uiGraph, { actionTransport: { type: 'unknown' } as never }),
      /valid HTTP actionPath or HTTP\/WebSocket socketPath/,
    );
    assert.throws(
      () =>
        renderRivetWebAppHtml(uiGraph, {
          actionTransport: { type: 'websocket', socketPath: 'ftp://example.test/actions' },
        }),
      /valid HTTP actionPath or HTTP\/WebSocket socketPath/,
    );
  });

  void it('rejects malformed UI graphs passed directly to the action runner', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs!['ui-graph' as UiGraphId]!;
    uiGraph.components = [{ id: 'broken' as any, label: 'Run', type: 'button' } as UiGraphComponent];

    await assert.rejects(
      runRivetWebAppAction(project, { componentId: 'broken', uiGraph }),
      /UI graph "ui-graph" component at index 0\.action/,
    );
  });

  void it('serves the UI graph HTML', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(new Request('https://example.test/app'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Test App/);
    assert.match(html, /\/app\/actions\/run/);
  });

  void it('serves content-addressed external assets without inline scripts or styles', async () => {
    const nonce = 'request-nonce';
    const handler = createRivetWebAppHandler(makeProject(), {
      assetMode: 'external',
      basePath: '/app',
      resolveCspNonce: (request) => {
        assert.equal(request.url, 'https://example.test/app');
        return nonce;
      },
      uiGraphId: 'ui-graph',
    });
    const htmlResponse = await handler.handleRequest(new Request('https://example.test/app'));
    const html = await htmlResponse.text();
    const dom = new JSDOM(html);
    const manifest = getRivetWebAppAssetManifest();

    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.values(manifest).every(Object.isFrozen), true);
    assert.equal(dom.window.document.querySelectorAll('style').length, 0);
    assert.equal(dom.window.document.querySelectorAll('link[rel="stylesheet"]').length, 1);
    assert.equal(dom.window.document.querySelectorAll('script').length, 3);
    assert.deepEqual(
      [...dom.window.document.querySelectorAll('script')].map((script) => script.getAttribute('src')),
      [manifest.marked, manifest.domPurify, manifest.client].map(
        (asset) => `/app${RIVET_WEB_APP_ASSET_ROUTE}/${asset.fileName}`,
      ),
    );
    assert.equal(
      [...dom.window.document.querySelectorAll('script')].every(
        (script) => script.getAttribute('src') && script.textContent === '' && script.getAttribute('nonce') === nonce,
      ),
      true,
    );
    assert.equal(html.includes('window.__RIVET_WEB_APP__'), false);

    const embeddedConfig = JSON.parse(
      dom.window.document.getElementById('app')!.getAttribute('data-rivet-web-app-config')!,
    ) as { actionPath: string; initialState: Record<string, unknown>; uiGraph: { name: string } };
    assert.equal(embeddedConfig.actionPath, '/app/actions/run');
    assert.deepEqual(embeddedConfig.initialState, {});
    assert.equal(embeddedConfig.uiGraph.name, 'Test App');

    for (const asset of [manifest.marked, manifest.domPurify, manifest.client]) {
      assert.doesNotMatch(asset.content, /\b(?:eval|Function)\s*\(/);
    }

    for (const asset of Object.values(manifest)) {
      assert.equal(asset.fileName.includes(asset.hash.slice(0, 20)), true);
      assert.match(asset.integrity, /^sha256-/);
      assert.equal(html.includes(`${RIVET_WEB_APP_ASSET_ROUTE}/${asset.fileName}`), true);
      assert.equal(html.includes(`integrity="${asset.integrity}"`), true);

      const assetUrl = `https://example.test/app${RIVET_WEB_APP_ASSET_ROUTE}/${asset.fileName}`;
      const assetResponse = await handler.handleRequest(new Request(assetUrl));
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get('cache-control'), RIVET_WEB_APP_ASSET_CACHE_CONTROL);
      assert.equal(assetResponse.headers.get('content-type'), asset.contentType);
      assert.equal(assetResponse.headers.get('etag'), asset.etag);
      assert.equal(assetResponse.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await assetResponse.text(), asset.content);

      const headResponse = await handler.handleRequest(new Request(assetUrl, { method: 'HEAD' }));
      assert.equal(headResponse.status, 200);
      assert.equal(await headResponse.text(), '');

      const cachedResponse = await handler.handleRequest(
        new Request(assetUrl, { headers: { 'if-none-match': asset.etag } }),
      );
      assert.equal(cachedResponse.status, 304);
      assert.equal(await cachedResponse.text(), '');

      const weakCachedResponse = await handler.handleRequest(
        new Request(assetUrl, { headers: { 'if-none-match': `W/${asset.etag}` } }),
      );
      assert.equal(weakCachedResponse.status, 304);
    }

    const missingAssetResponse = await handler.handleRequest(
      new Request(`https://example.test/app${RIVET_WEB_APP_ASSET_ROUTE}/missing.js`),
    );
    assert.equal(missingAssetResponse.status, 404);
    assert.deepEqual(await missingAssetResponse.json(), { error: 'Not found' });

    const missingHeadResponse = await handler.handleRequest(
      new Request(`https://example.test/app${RIVET_WEB_APP_ASSET_ROUTE}/missing.js`, { method: 'HEAD' }),
    );
    assert.equal(missingHeadResponse.status, 404);
    assert.equal(await missingHeadResponse.text(), '');
    dom.window.close();
  });

  void it('adds a CSP nonce to every inline style and script while keeping bootstrap data non-executable', () => {
    const uiGraph = makeProject().uiGraphs!['ui-graph' as UiGraphId]!;
    uiGraph.name = '</div><script>unsafe()</script>';
    const html = renderRivetWebAppHtml(uiGraph, {
      actionPath: '/app/actions/run',
      cspNonce: 'nonce-value',
    });
    const dom = new JSDOM(html);

    assert.equal(
      [...dom.window.document.querySelectorAll('style, script')].every(
        (element) => element.getAttribute('nonce') === 'nonce-value',
      ),
      true,
    );
    assert.equal(dom.window.document.querySelectorAll('script').length, 3);
    assert.equal(dom.window.document.querySelectorAll('script[src]').length, 0);
    const embeddedConfig = JSON.parse(
      dom.window.document.getElementById('app')!.getAttribute('data-rivet-web-app-config')!,
    ) as { uiGraph: { name: string } };
    assert.equal(embeddedConfig.uiGraph.name, '</div><script>unsafe()</script>');
    dom.window.close();
  });

  void it('renders external assets from an absolute CDN base URL', () => {
    const uiGraph = makeProject().uiGraphs!['ui-graph' as UiGraphId]!;
    const html = renderRivetWebAppHtml(uiGraph, {
      actionPath: '/apps/test/actions/run',
      assetBasePath: 'https://cdn.example.test/rivet-assets/',
      assetMode: 'external',
    });

    for (const asset of Object.values(getRivetWebAppAssetManifest())) {
      assert.equal(html.includes(`="https://cdn.example.test/rivet-assets/${asset.fileName}"`), true);
    }
  });

  void it('boots the generated client from external assets', { timeout: 5_000 }, async () => {
    const uiGraph = makeProject().uiGraphs!['ui-graph' as UiGraphId]!;
    uiGraph.components.unshift({
      id: 'markdown' as any,
      markdown: '**Loaded externally**',
      type: 'markdown',
    });
    const manifest = getRivetWebAppAssetManifest();
    const fetchedAssets = new Set<string>();
    const resourceLoader = new (class extends ResourceLoader {
      override fetch(url: string): Promise<Buffer<ArrayBuffer>> | null {
        const asset = Object.values(manifest).find((candidate) => url.endsWith(`/${candidate.fileName}`));
        if (!asset) {
          return null;
        }
        fetchedAssets.add(asset.fileName);
        return Promise.resolve(Buffer.from(asset.content));
      }
    })();
    const html = renderRivetWebAppHtml(uiGraph, {
      actionPath: '/apps/test/actions/run',
      assetBasePath: 'https://cdn.example.test/rivet-assets',
      assetMode: 'external',
    });
    const dom = new JSDOM(html, {
      resources: resourceLoader,
      runScripts: 'dangerously',
      url: 'https://app.example.test/apps/test',
    });

    try {
      await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve(), { once: true }));

      assert.deepEqual(fetchedAssets, new Set(Object.values(manifest).map((asset) => asset.fileName)));
      assert.equal(
        dom.window.document.querySelector('.rivet-web-app-markdown strong')?.textContent,
        'Loaded externally',
      );
      assert.equal(dom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.textContent, 'Run');
    } finally {
      dom.window.close();
    }
  });

  void it('emits syntactically valid inline client JavaScript', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const html = renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    const markedScript = scripts.at(-3);
    const domPurifyScript = scripts.at(-2);
    const clientScript = scripts.at(-1);

    assert.ok(markedScript);
    assert.ok(domPurifyScript);
    assert.ok(clientScript);
    assert.match(markedScript, /marked v\d+\.\d+\.\d+/);
    assert.match(domPurifyScript, /DOMPurify/);
    assert.match(clientScript, /browserGlobals\.marked\?\.parse/);
    assert.match(clientScript, /browserGlobals\.DOMPurify\?\.sanitize/);
    assert.match(clientScript, /ALLOWED_URI_REGEXP/);
    assert.match(clientScript, /createSafeMarkdownRenderer/);
    assert.match(clientScript, /getUiGraphComponentRenderModel/);
    assert.match(clientScript, /applyUiGraphStatePatch/);
    assert.doesNotMatch(clientScript, /JSON\.stringify\(value \?\? null/);
    assert.doesNotMatch(clientScript, /renderInlineMarkdown/);
    assert.doesNotThrow(() => new Function(markedScript));
    assert.doesNotThrow(() => new Function(clientScript));

    const browserContext = {};
    runInNewContext(markedScript, browserContext);
    assert.equal(typeof (browserContext as { marked?: { Renderer?: unknown } }).marked?.Renderer, 'function');
  });

  void it('uses the same marked markdown engine as app preview', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const html = renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    const clientScript = scripts.at(-1);
    const converted = marked('# Hello\n\n- **one**\n- two');

    assert.match(converted, /<h1>Hello<\/h1>/);
    assert.match(converted, /<li><strong>one<\/strong><\/li>/);
    assert.match(clientScript ?? '', /browserGlobals\.marked\?\.parse/);
    assert.match(clientScript ?? '', /browserGlobals\.DOMPurify\?\.sanitize/);
  });

  void it("posts only a button's input-bound state from the generated client", async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const button = uiGraph.components[0] as Extract<UiGraphComponent, { type: 'button' }>;
    button.action = {
      graphId,
      inputMappings: [
        { inputKey: 'question', stateKey: 'prompt' },
        { inputKey: 'category', stateKey: 'genre' },
      ],
      type: 'runGraph',
    };
    uiGraph.components = [
      { defaultValue: 'hello', id: 'prompt-field' as any, label: 'Prompt', stateKey: 'prompt', type: 'input' },
      { defaultValue: 'internal', id: 'other-field' as any, label: 'Other', stateKey: 'other', type: 'input' },
      { defaultValue: 'fiction', id: 'genre-field' as any, label: 'Genre', stateKey: 'genre', type: 'input' },
      button,
    ];
    const requests: Record<string, unknown>[] = [];
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      beforeParse(window) {
        window.fetch = async (_input, init) => {
          requests.push(JSON.parse(`${init?.body ?? '{}'}`) as Record<string, unknown>);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ outputs: {}, statePatch: {} }),
          } as Response;
        };
      },
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();

    assert.deepEqual(requests, [{ componentId: 'run-button', state: { prompt: 'hello', genre: 'fiction' } }]);
  });

  void it('repairs duplicate button IDs before scoping hosted loading state', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const firstButton = uiGraph.components[0] as Extract<UiGraphComponent, { type: 'button' }>;
    uiGraph.components = [
      firstButton,
      {
        id: firstButton.id,
        type: 'button',
        label: 'Second',
        action: firstButton.action,
      },
    ];

    const requests: Record<string, unknown>[] = [];
    let resolveAction!: (response: Response) => void;
    const actionResponse = new Promise<Response>((resolve) => {
      resolveAction = resolve;
    });
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      beforeParse(window) {
        window.fetch = async (_input, init) => {
          requests.push(JSON.parse(`${init?.body ?? '{}'}`) as Record<string, unknown>);
          return await actionResponse;
        };
      },
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button')[1]?.click();
    await waitForActionLoadingPresentation();
    const buttons = [...dom.window.document.querySelectorAll('.rivet-web-app-button')] as HTMLButtonElement[];

    assert.deepEqual(requests, [{ componentId: 'ui-graph-component-2', state: {} }]);
    assert.equal(buttons[0]?.textContent, 'Run');
    assert.equal(buttons[0]?.disabled, false);
    assert.equal(buttons[1]?.textContent, 'Second');
    assert.ok(buttons[1]?.querySelector('.rivet-web-app-running-indicator'));
    assert.equal(buttons[1]?.disabled, true);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-abort-button')?.textContent, 'Abort');

    resolveAction({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ outputs: {}, statePatch: {} }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
  });

  void it('keeps concurrent button loading independent and ignores stale overlapping state patches', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const action = {
      graphId,
      outputs: [{ outputKey: 'value', stateKey: 'result' }],
      type: 'runGraph' as const,
    };
    uiGraph.components = [
      { action, id: 'first-button' as any, label: 'First', type: 'button' },
      { action, id: 'second-button' as any, label: 'Second', type: 'button' },
      { id: 'result-output' as any, label: 'Result', stateKey: 'result', type: 'output' },
    ];
    const resolveAction = new Map<string, (response: Response) => void>();
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      beforeParse(window) {
        window.fetch = async (_input, init) => {
          const body = JSON.parse(`${init?.body ?? '{}'}`) as { componentId: string };
          return await new Promise<Response>((resolve) => resolveAction.set(body.componentId, resolve));
        };
      },
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelectorAll('.rivet-web-app-action-stack > .rivet-web-app-button')[0]?.click();
    dom.window.document.querySelectorAll('.rivet-web-app-action-stack > .rivet-web-app-button')[1]?.click();
    await waitForActionLoadingPresentation();

    let buttons = [
      ...dom.window.document.querySelectorAll('.rivet-web-app-action-stack > .rivet-web-app-button'),
    ] as HTMLButtonElement[];
    assert.equal(buttons[0]?.textContent, 'First');
    assert.ok(buttons[0]?.querySelector('.rivet-web-app-running-indicator'));
    assert.equal(buttons[0]?.disabled, true);
    assert.equal(buttons[1]?.textContent, 'Second');
    assert.ok(buttons[1]?.querySelector('.rivet-web-app-running-indicator'));
    assert.equal(buttons[1]?.disabled, true);

    resolveAction.get('first-button')?.({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ outputs: {}, statePatch: { result: 'stale' } }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));

    buttons = [
      ...dom.window.document.querySelectorAll('.rivet-web-app-action-stack > .rivet-web-app-button'),
    ] as HTMLButtonElement[];
    assert.equal(buttons[0]?.textContent, 'First');
    assert.equal(buttons[0]?.disabled, false);
    assert.equal(buttons[1]?.textContent, 'Second');
    assert.ok(buttons[1]?.querySelector('.rivet-web-app-running-indicator'));
    assert.equal(buttons[1]?.disabled, true);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-output pre'), null);

    resolveAction.get('second-button')?.({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ outputs: {}, statePatch: { result: 'current' } }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(dom.window.document.querySelector('.rivet-web-app-output pre')?.textContent, 'current');
    dom.window.close();
  });

  void it('unfolds a collapsed Output when its data key receives a new value', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components = [
      {
        defaultValue: 'Initial',
        id: 'result-input' as any,
        label: 'Result',
        stateKey: 'result',
        type: 'input',
      },
      { id: 'result-output' as any, label: 'Result', stateKey: 'result', type: 'output' },
    ];
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-output-toggle')?.click();
    assert.ok(dom.window.document.querySelector('.rivet-web-app-output-collapsed'));

    const input = dom.window.document.querySelector<HTMLInputElement>('.rivet-web-app-field input')!;
    input.value = 'Updated';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    assert.equal(dom.window.document.querySelector('.rivet-web-app-output-collapsed'), null);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-output pre')?.textContent, 'Updated');
    dom.window.close();
  });

  void it('aborts hosted action fetches when the page is unloaded', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    let actionSignal: AbortSignal | undefined;
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      beforeParse(window) {
        window.fetch = async (_input, init) => {
          actionSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            actionSignal?.addEventListener('abort', () => reject(actionSignal?.reason), { once: true });
          });
        };
      },
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(actionSignal?.aborted, true);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-error'), null);
    dom.window.close();
  });

  void it('streams WebSocket progress, cancels the selected action, and detaches without cancelling on unload', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components.unshift({
      id: 'prompt-input' as any,
      type: 'input',
      label: 'Prompt',
      placeholder: '',
      stateKey: 'prompt',
    });
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    const promptInput = dom.window.document.querySelector('.rivet-web-app-control') as HTMLInputElement;
    promptInput.value = 'hello';
    promptInput.dispatchEvent(new dom.window.Event('input'));
    promptInput.focus();
    promptInput.setSelectionRange(1, 4);
    const runButton = dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement;
    runButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitForActionLoadingPresentation();
    const socket = sockets[0]!;
    const start = socket.sent.find((message) => message.type === 'action.start')!;
    assert.equal(socket.url, 'wss://example.test/app/actions/ws');
    assert.equal(start.componentId, 'run-button');

    socket.receive({
      type: 'action.accepted',
      requestId: start.requestId,
      runId: 'run-1',
      sequence: 1,
    });
    socket.receive({
      type: 'action.progress',
      progress: { message: 'Generating', percent: 45 },
      requestId: start.requestId,
      runId: 'run-1',
      sequence: 2,
    });
    assert.equal(dom.window.document.querySelector('.rivet-web-app-progress span')?.textContent, 'Generating');
    assert.equal(dom.window.document.querySelector('.rivet-web-app-progress progress')?.getAttribute('value'), '45');
    const rerenderedInput = dom.window.document.querySelector('.rivet-web-app-control') as HTMLInputElement;
    assert.equal(dom.window.document.activeElement, rerenderedInput);
    assert.equal(rerenderedInput.selectionStart, 1);
    assert.equal(rerenderedInput.selectionEnd, 4);

    (dom.window.document.querySelector('.rivet-web-app-abort-button') as HTMLButtonElement).click();
    assert.deepEqual(socket.sent.at(-1), { type: 'action.cancel', runId: 'run-1' });
    socket.receive({
      type: 'action.cancelled',
      requestId: start.requestId,
      runId: 'run-1',
      sequence: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('.rivet-web-app-progress'), null);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-button')?.textContent, 'Run');

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitForActionLoadingPresentation();
    const cancelCountBeforeDetach = socket.sent.filter((message) => message.type === 'action.cancel').length;
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(socket.sent.filter((message) => message.type === 'action.cancel').length, cancelCountBeforeDetach);
    assert.equal(socket.readyState, 3);
    dom.window.close();
  });

  void it('preserves an absolute secure WebSocket action URL', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: 'wss://socket.example/actions' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sockets[0]?.url, 'wss://socket.example/actions');
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  });

  void it('settles an accepted browser action when its server run becomes unavailable', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0]!;
    const start = socket.sent.find((message) => message.type === 'action.start')!;
    socket.receive({
      type: 'action.accepted',
      requestId: start.requestId,
      runId: 'run-unavailable',
      sequence: 1,
    });
    socket.receive({
      type: 'run.rejected',
      runId: 'run-unavailable',
      error: 'The web app action is unavailable.',
      code: 'run_unavailable',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      dom.window.document.querySelector('.rivet-web-app-error')?.textContent,
      'The web app action is unavailable.',
    );
    dom.window.close();
  });

  void it('reconnects the hosted client and resumes a run after the last received sequence', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components.push({
      id: 'result-output' as never,
      label: 'Result',
      stateKey: 'result',
      type: 'output',
    });
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstSocket = sockets[0]!;
    const start = firstSocket.sent.find((message) => message.type === 'action.start')!;
    firstSocket.receive({
      type: 'action.accepted',
      requestId: start.requestId,
      runId: 'run-resume',
      sequence: 1,
    });
    firstSocket.receive({
      type: 'action.progress',
      progress: { percent: 30 },
      requestId: start.requestId,
      runId: 'run-resume',
      sequence: 2,
    });
    firstSocket.close();

    await new Promise((resolve) => setTimeout(resolve, 550));
    const secondSocket = sockets[1]!;
    assert.deepEqual(
      secondSocket.sent.find((message) => message.type === 'run.resume'),
      { type: 'run.resume', runId: 'run-resume', lastSequence: 2 },
    );
    secondSocket.receive({
      type: 'action.completed',
      requestId: start.requestId,
      runId: 'run-resume',
      sequence: 3,
      statePatch: { result: 'Reconnected' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(dom.window.document.querySelector('.rivet-web-app-output pre')?.textContent, 'Reconnected');
    dom.window.close();
  });

  void it('surfaces non-retryable WebSocket closes instead of reconnecting forever', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]!.close(1008, 'Authentication expired');
    await new Promise((resolve) => setTimeout(resolve, 550));

    assert.equal(sockets.length, 1);
    assert.equal(dom.window.document.querySelector('.rivet-web-app-error')?.textContent, 'Authentication expired');
    dom.window.close();
  });

  void it('backs off repeated sockets that open but never complete the protocol handshake', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.Math.random = () => 0;
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets, false) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]!.close(1006);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sockets.length, 2);

    sockets[1]!.close(1006);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sockets.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(sockets.length, 3);

    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  });

  void it('replays a sent start after reconnect so cancellation before acceptance reaches the server', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const sockets: FakeBrowserWebSocket[] = [];
    const dom = new JSDOM(
      renderRivetWebAppHtml(uiGraph, {
        actionTransport: { type: 'websocket', socketPath: '/app/actions/ws' },
      }),
      {
        beforeParse(window) {
          window.WebSocket = makeFakeBrowserWebSocketClass(window, sockets) as never;
        },
        runScripts: 'dangerously',
        url: 'https://example.test/app',
      },
    );

    (dom.window.document.querySelector('.rivet-web-app-button') as HTMLButtonElement).click();
    await waitForActionLoadingPresentation();
    const firstSocket = sockets[0]!;
    const start = firstSocket.sent.find((message) => message.type === 'action.start')!;
    (dom.window.document.querySelector('.rivet-web-app-abort-button') as HTMLButtonElement).click();
    firstSocket.close();

    await new Promise((resolve) => setTimeout(resolve, 550));
    const secondSocket = sockets[1]!;
    assert.deepEqual(
      secondSocket.sent.find((message) => message.type === 'action.start'),
      start,
    );
    secondSocket.receive({
      type: 'action.accepted',
      requestId: start.requestId,
      runId: 'run-cancel-before-accept',
      sequence: 1,
    });
    assert.deepEqual(secondSocket.sent.at(-1), {
      type: 'action.cancel',
      runId: 'run-cancel-before-accept',
    });
    secondSocket.receive({
      type: 'action.cancelled',
      requestId: start.requestId,
      runId: 'run-cancel-before-accept',
      sequence: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(dom.window.document.querySelector('.rivet-web-app-button')?.textContent, 'Run');
    dom.window.close();
  });

  void it('renders a friendly HTTP error when a proxy returns non-JSON action content', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      beforeParse(window) {
        window.fetch = async () =>
          ({
            ok: false,
            status: 413,
            statusText: 'Request Entity Too Large',
            text: async () => '<html><body>Request Entity Too Large</body></html>',
          }) as Response;
      },
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });

    dom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renderedError = dom.window.document.querySelector('.rivet-web-app-error')?.textContent;
    dom.window.close();

    assert.equal(renderedError, '413 Request Entity Too Large');
    assert.doesNotMatch(renderedError ?? '', /Unexpected token|<html>/i);
  });

  void it('renders Text and Markdown without card surfaces and sanitizes hosted Markdown', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components = [
      {
        id: 'plain-text' as any,
        text: 'Plain text',
        type: 'text',
      },
      {
        id: 'unsafe-markdown' as any,
        type: 'markdown',
        markdown: '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(2)) [safe](https://example.com/path)',
      },
    ];

    const html = renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/app' });
    const text = dom.window.document.querySelector('.rivet-web-app-text');
    const markdown = dom.window.document.querySelector('.rivet-web-app-markdown');
    const links = markdown?.querySelectorAll('a');

    assert.ok(text);
    assert.equal(text.textContent, 'Plain text');
    assert.equal(text.classList.contains('rivet-web-app-card'), false);
    assert.ok(markdown);
    assert.equal(markdown.classList.contains('rivet-web-app-card'), false);
    assert.equal(markdown.querySelector('img'), null);
    assert.equal(links?.[0]?.hasAttribute('href'), false);
    assert.equal(links?.[1]?.getAttribute('href'), 'https://example.com/path');
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-text\s*\{\s*background: transparent;/);
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-clipboard-fallback\s*\{[\s\S]*position: fixed;/);
    dom.window.close();
  });

  void it('serves the shared web app renderer styles', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(new Request('https://example.test/app'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /class="rivet-web-app-root"/);
    assert.match(html, /rivet-web-app-surface/);
    assert.match(html, /rivet-web-app-field/);
    assert.match(html, /rivet-web-app-card rivet-web-app-output/);
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-surface\s*\{[\s\S]*display: flex;/);
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /--rivet-web-app-chat-min-height: clamp\(360px, calc\(100vh - 136px\), 540px\);/,
    );
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /--rivet-web-app-chat-min-height: clamp\(320px, calc\(100vh - 64px\), 540px\);/,
    );
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /\.rivet-web-app-chat-thinking span\s*\{[\s\S]*animation: rivet-web-app-chat-thinking 0\.9s ease-in-out infinite;/,
    );
    assert.doesNotMatch(
      RIVET_WEB_APP_RENDERER_CSS,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rivet-web-app-chat-thinking span/,
    );
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /\.rivet-web-app-component-frame\[data-rivet-web-app-component-type='chat'\][\s\S]*flex: 1 0/,
    );
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /\.rivet-web-app-button\s*\{[\s\S]*width: fit-content;[\s\S]*height: var\(--rivet-web-app-button-height\);[\s\S]*padding: 0\.5rem 1rem;/,
    );
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /\.rivet-web-app-action-stack-running > \.rivet-web-app-button,[\s\S]*height: var\(--rivet-web-app-button-height\);[\s\S]*padding: 0\.5rem 1rem;/,
    );
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-chat-messages\s*\{[\s\S]*overflow-y: auto;/);
    assert.match(
      RIVET_WEB_APP_RENDERER_CSS,
      /\.rivet-web-app-chat-messages > :first-child\s*\{[\s\S]*margin-top: auto;/,
    );
    assert.match(html, /\.markdown-body \{/);
    assert.ok(html.includes(RIVET_WEB_APP_DOCUMENT_CSS));
    assert.ok(html.includes(RIVET_WEB_APP_RENDERER_CSS));

    const documentStyleIndex = html.indexOf(RIVET_WEB_APP_DOCUMENT_CSS);
    const markdownStyleIndex = html.indexOf('.markdown-body {');
    const rendererStyleIndex = html.indexOf(RIVET_WEB_APP_RENDERER_CSS);

    assert.ok(documentStyleIndex >= 0);
    assert.ok(markdownStyleIndex > documentStyleIndex);
    assert.ok(rendererStyleIndex > markdownStyleIndex);
  });

  void it('renders Gap components as cardless shared spacing', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components = [{ id: 'large-gap' as any, size: 'large', type: 'gap' }];

    const dom = new JSDOM(renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' }), {
      runScripts: 'dangerously',
      url: 'https://example.test/app',
    });
    const gap = dom.window.document.querySelector('.rivet-web-app-gap.rivet-web-app-gap-large');

    assert.ok(gap);
    assert.equal(gap.getAttribute('aria-hidden'), 'true');
    assert.equal(dom.window.document.querySelector('.rivet-web-app-card'), null);
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-gap-small\s*\{\s*height: 8px;/);
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-gap-medium\s*\{\s*height: 32px;/);
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /\.rivet-web-app-gap-large\s*\{\s*height: 96px;/);
    dom.window.close();
  });

  void it('runs bound graph actions and returns a state patch', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { outputs: Record<string, DataValue>; statePatch: Record<string, unknown> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.outputs.value, { type: 'string', value: 'hello' });
    assert.equal(body.statePatch.result, 'hello');
  });

  void it('dispatches an action through a repaired duplicate component ID', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const firstButton = uiGraph.components[0] as Extract<UiGraphComponent, { type: 'button' }>;
    uiGraph.components = [
      {
        ...firstButton,
        id: 'duplicate-button' as any,
        action: { ...firstButton.action, outputStateKey: 'first-result' },
      },
      {
        ...firstButton,
        id: 'duplicate-button' as any,
        label: 'Second',
        action: { ...firstButton.action, outputStateKey: 'second-result' },
      },
    ];

    const handler = createRivetWebAppHandler(project, { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'ui-graph-component-2', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { statePatch: Record<string, unknown> };

    assert.equal(response.status, 200);
    assert.equal(body.statePatch['first-result'], undefined);
    assert.equal(body.statePatch['second-result'], 'hello');
  });

  void it('maps array action inputs to typed Data Values', async () => {
    const project = makeProject();
    const graph = project.graphs[graphId]!;
    graph.nodes[0]!.data = { dataType: 'string[]', id: 'input' };
    graph.nodes[1]!.data = { dataType: 'string[]', id: 'value' };

    const handler = createRivetWebAppHandler(project, { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: ['one', 'two'] } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { outputs: Record<string, DataValue>; statePatch: Record<string, unknown> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.outputs.value, { type: 'string[]', value: ['one', 'two'] });
    assert.deepEqual(body.statePatch.result, ['one', 'two']);
  });

  void it('supports static processor options without letting graph override the action target', async () => {
    const handler = createRivetWebAppHandler(makeProject(), {
      basePath: '/app',
      createProcessorOptions: { graph: 'wrong-graph' as GraphId } as any,
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { outputs: Record<string, DataValue> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.outputs.value, { type: 'string', value: 'hello' });
  });

  void it('resolves processor options per action request', async () => {
    let resolveContextCalled = false;
    const handler = createRivetWebAppHandler(makeProject(), {
      basePath: '/app',
      createProcessorOptions: async (context) => {
        assert.equal(context.componentId, 'run-button');
        assert.equal(context.request.url, 'https://example.test/app/actions/run');
        assert.equal(context.revisionKey, 'rev-1');
        assert.deepEqual(context.state, { prompt: 'hello' });
        assert.deepEqual(context.actionInput, { input: 'hello' });

        return {
          context: {},
          inputs: {
            input: {
              type: 'string',
              value: 'from resolver',
            },
          },
        };
      },
      resolveContext: () => {
        resolveContextCalled = true;
        return {};
      },
      revisionKey: 'rev-1',
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({
          componentId: 'run-button',
          revisionKey: 'rev-1',
          state: { prompt: 'hello', unrelated: 'do not expose to the action' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { outputs: Record<string, DataValue> };

    assert.equal(response.status, 200);
    assert.equal(resolveContextCalled, false);
    assert.deepEqual(body.outputs.value, { type: 'string', value: 'from resolver' });
  });

  void it('falls back to resolveContext when processor options do not provide context', async () => {
    let resolveContextCalled = false;
    const handler = createRivetWebAppHandler(makeProject(), {
      basePath: '/app',
      createProcessorOptions: () => ({}),
      resolveContext: () => {
        resolveContextCalled = true;
        return {};
      },
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(resolveContextCalled, true);
  });

  void it('treats an empty processor option resolver result as defaults', async () => {
    const handler = createRivetWebAppHandler(makeProject(), {
      basePath: '/app',
      createProcessorOptions: () => undefined,
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { outputs: Record<string, DataValue> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.outputs.value, { type: 'string', value: 'hello' });
  });

  void it('embeds and enforces revision keys', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    const html = renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run', revisionKey: 'rev-1' });
    const handler = createRivetWebAppHandler(project, {
      basePath: '/app',
      revisionKey: 'rev-1',
      uiGraphId: 'ui-graph',
    });

    const revisionDom = new JSDOM(html);
    const embeddedConfig = JSON.parse(
      revisionDom.window.document.getElementById('app')!.getAttribute('data-rivet-web-app-config')!,
    ) as { revisionKey?: string };
    revisionDom.window.close();
    assert.equal(embeddedConfig.revisionKey, 'rev-1');
    assert.match(html, /revisionKey: config\.revisionKey/);
    assert.match(html, /credentials: "same-origin"/);

    const accepted = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', revisionKey: 'rev-1', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    assert.equal(accepted.status, 200);

    const rejected = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', revisionKey: 'rev-2', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const rejectedBody = (await rejected.json()) as { code?: string; error?: string };
    assert.equal(rejected.status, 409);
    assert.equal(rejectedBody.error, 'Rivet web app revision mismatch.');
    assert.equal(rejectedBody.code, 'revision_mismatch');
    assert.match(html, /error\.code === "revision_mismatch"/);
    assert.match(html, /renderRevisionMismatchModal/);
    assert.match(html, /role: "dialog"/);
    assert.match(html, /"aria-modal": "true"/);
    assert.match(html, /This app was updated\. Reload to continue\./);
    assert.match(html, /text: "Reload"/);
    assert.match(html, /window\.location\.reload\(\)/);
    assert.match(html, /root\.querySelector\("\.rivet-web-app-modal-button"\)\?\.focus\(\)/);
    assert.ok(RIVET_WEB_APP_RENDERER_CSS.includes('.rivet-web-app-modal-backdrop'));
    assert.ok(RIVET_WEB_APP_RENDERER_CSS.includes('.rivet-web-app-modal'));
    assert.match(RIVET_WEB_APP_RENDERER_CSS, /background: rgba\(0, 0, 0, 0\.46\);[\s\S]*background: color-mix/);
  });

  void it('exports a lower-level action helper', async () => {
    const project = makeProject();
    const result = await runRivetWebAppAction(project, {
      componentId: 'run-button',
      state: { prompt: 'hello' },
      uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
    });

    assert.deepEqual(result.outputs.value, { type: 'string', value: 'hello' });
    assert.deepEqual(result.statePatch, { result: 'hello' });
  });

  void it('exposes setWebAppStatus to the action graph and forwards its message as progress', async () => {
    const project = makeExternalStatusProject();
    const progress: unknown[] = [];

    const result = await runRivetWebAppAction(project, {
      componentId: 'run-button',
      createProcessorOptions: {
        onProgress: ({ progress: nextProgress }) => progress.push(nextProgress),
      },
      state: { prompt: 'Preparing the answer' },
      uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
    });

    assert.deepEqual(progress, [{ message: 'Preparing the answer' }]);
    assert.deepEqual(result.outputs.value, { type: 'string', value: 'Preparing the answer' });
  });

  void it('prepares an inspectable action without starting it and runs it only once', async () => {
    const project = makeProject();
    let starts = 0;
    const prepared = await prepareRivetWebAppAction(project, {
      componentId: 'run-button',
      onActionStart: () => {
        starts += 1;
      },
      state: { prompt: 'hello' },
      uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
    });

    assert.equal(starts, 0);
    assert.equal(prepared.context.componentId, 'run-button');
    assert.deepEqual((await prepared.run()).statePatch, { result: 'hello' });
    assert.equal(starts, 1);
    await assert.rejects(() => prepared.run(), /already been run/);
  });

  void it('disposes an unstarted prepared action idempotently and prevents execution', async () => {
    const project = makeProject();
    let starts = 0;
    const prepared = await prepareRivetWebAppAction(project, {
      componentId: 'run-button',
      onActionStart: () => {
        starts += 1;
      },
      state: { prompt: 'hello' },
      uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
    });

    prepared.dispose();
    prepared.dispose();

    await assert.rejects(() => prepared.run(), /has been disposed/);
    assert.equal(starts, 0);
  });

  void it('runs Chat with the current message, prior native history, and mapped page data', async () => {
    const project = makeProject();
    project.graphs[graphId]!.nodes.push({
      id: 'history-node' as any,
      type: 'graphInput',
      title: 'History',
      visualData: { x: 0, y: 120 },
      data: { dataType: 'chat-message[]', id: 'history' },
    } as any);
    project.graphs[graphId]!.nodes.push({
      id: 'tone-node' as any,
      type: 'graphInput',
      title: 'Tone',
      visualData: { x: 0, y: 240 },
      data: { dataType: 'string', id: 'tone' },
    } as any);
    const uiGraph = project.uiGraphs!['ui-graph' as UiGraphId]!;
    uiGraph.components = [
      {
        action: {
          graphId,
          historyInputId: 'history',
          inputMappings: [{ inputKey: 'tone', stateKey: 'tone' }],
          responseOutputId: 'value',
          type: 'runGraph',
          userInputId: 'input',
        },
        id: 'chat' as any,
        type: 'chat',
      },
    ];
    const messagesKey = getUiGraphChatMessagesStateKey('chat' as any);
    const state = {
      [messagesKey]: [
        { role: 'assistant', content: 'Welcome' },
        { role: 'user', content: 'Hello' },
      ],
      tone: 'Friendly',
    };
    let actionInput: Record<string, unknown> | undefined;

    const result = await runRivetWebAppAction(project, {
      componentId: 'chat',
      createProcessorOptions: (context) => {
        actionInput = context.actionInput;
        return {};
      },
      state,
      uiGraph,
    });

    assert.deepEqual(actionInput, {
      history: {
        type: 'chat-message[]',
        value: [{ type: 'assistant', message: 'Welcome', function_call: undefined, function_calls: undefined }],
      },
      input: 'Hello',
      tone: 'Friendly',
    });
    assert.deepEqual(result.statePatch, {
      [messagesKey]: [...state[messagesKey], { role: 'assistant', content: 'Hello' }],
    });
  });

  void it('rejects stale button bindings before dispatching a hosted graph action', async () => {
    const project = makeProject();
    const component = project.uiGraphs?.['ui-graph' as UiGraphId]?.components[0];
    assert.equal(component?.type, 'button');
    if (component?.type === 'button') {
      component.action.inputs = { removedInput: { key: 'prompt', type: 'state' } };
    }

    await assert.rejects(
      () =>
        runRivetWebAppAction(project, {
          componentId: 'run-button',
          state: { prompt: 'hello' },
          uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
        }),
      (error) =>
        error instanceof RivetWebAppActionHttpError &&
        error.status === 400 &&
        error.code === 'invalid_button_bindings' &&
        error.message.includes('Graph input "removedInput" no longer exists.'),
    );
  });

  void it('uses the action request signal as the default processor cancellation signal', async () => {
    const project = makeProject();
    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      () =>
        runRivetWebAppAction(project, {
          componentId: 'run-button',
          request: new Request('https://example.test/app/actions/run', { signal: abortController.signal }),
          state: { prompt: 'hello' },
          uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
        }),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    );
  });

  void it('prefers an explicit processor abort signal over the action request signal', async () => {
    const project = makeProject();
    const requestAbortController = new AbortController();
    const processorAbortController = new AbortController();
    requestAbortController.abort();

    assert.equal(getEventListeners(processorAbortController.signal, 'abort').length, 0);
    const result = await runRivetWebAppAction(project, {
      componentId: 'run-button',
      createProcessorOptions: { abortSignal: processorAbortController.signal },
      request: new Request('https://example.test/app/actions/run', { signal: requestAbortController.signal }),
      state: { prompt: 'hello' },
      uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
    });

    assert.deepEqual(result.statePatch, { result: 'hello' });
    assert.equal(getEventListeners(processorAbortController.signal, 'abort').length, 0);
  });

  void it('exports an HTTP-shaped action error for lower-level helper conflicts', async () => {
    const project = makeProject();

    await assert.rejects(
      () =>
        runRivetWebAppAction(project, {
          componentId: 'run-button',
          requestRevisionKey: 'rev-2',
          revisionKey: 'rev-1',
          state: { prompt: 'hello' },
          uiGraph: project.uiGraphs?.['ui-graph' as UiGraphId]!,
        }),
      (error) =>
        error instanceof RivetWebAppActionHttpError &&
        error.status === 409 &&
        error.code === 'revision_mismatch' &&
        error.message === 'Rivet web app revision mismatch.',
    );
  });

  void it('calls lifecycle hooks without letting hook failures replace action outcomes', async () => {
    const events: string[] = [];
    const handler = createRivetWebAppHandler(makeProject(), {
      basePath: '/app',
      onActionError: () => {
        events.push('error');
        throw new Error('ignored error hook failure');
      },
      onActionFinish: (context) => {
        events.push(`finish:${context.statePatch.result}`);
        throw new Error('ignored finish hook failure');
      },
      onActionStart: (context) => {
        events.push(`start:${context.actionInput.input}`);
        throw new Error('ignored start hook failure');
      },
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(events, ['start:hello', 'finish:hello']);
  });

  void it('calls the error lifecycle hook for action failures', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId];
    const button = uiGraph?.components.find(
      (component): component is Extract<UiGraphComponent, { type: 'button' }> => component.type === 'button',
    );
    const errors: string[] = [];

    assert.ok(button);
    button.action.outputKey = 'missing-output';

    const handler = createRivetWebAppHandler(project, {
      basePath: '/app',
      onActionError: (context) => {
        errors.push(context.error instanceof Error ? context.error.message : String(context.error));
      },
      uiGraphId: 'ui-graph',
    });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(errors, ['Invalid web app button bindings: Graph output "missing-output" no longer exists.']);
  });

  void it('reports malformed action JSON clearly', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid JSON request body.');
    assert.equal(body.code, undefined);
  });

  void it('reports malformed action request shapes clearly', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify('not an object'),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid action request body.');
    assert.equal(body.code, undefined);
  });

  void it('reports malformed action state clearly', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: [] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid action state.');
    assert.equal(body.code, undefined);
  });

  void it('reports a clear action error when the selected graph output is missing', async () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId];
    const button = uiGraph?.components.find(
      (component): component is Extract<UiGraphComponent, { type: 'button' }> => component.type === 'button',
    );

    assert.ok(button);
    button.action.outputKey = 'missing-output';

    const handler = createRivetWebAppHandler(project, { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(
      new Request('https://example.test/app/actions/run', {
        body: JSON.stringify({ componentId: 'run-button', state: { prompt: 'hello' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid web app button bindings: Graph output "missing-output" no longer exists.');
    assert.equal(body.code, 'invalid_button_bindings');
  });
});

type FakeBrowserWebSocket = {
  close(code?: number, reason?: string): void;
  readyState: number;
  sent: Record<string, unknown>[];
  url: string;
  receive(message: Record<string, unknown>): void;
};

function makeFakeBrowserWebSocketClass(
  window: Pick<Window, 'Event' | 'EventTarget' | 'MessageEvent'>,
  sockets: FakeBrowserWebSocket[],
  respondToHello = true,
) {
  const WindowEventTarget = window.EventTarget;
  return class FakeWebSocket extends WindowEventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readonly sent: Record<string, unknown>[] = [];
    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      sockets.push(this);
      void Promise.resolve().then(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new window.Event('open'));
      });
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      const event = new window.Event('close');
      Object.defineProperties(event, {
        code: { value: code },
        reason: { value: reason },
      });
      this.dispatchEvent(event);
    }

    send(value: string): void {
      const message = JSON.parse(value) as Record<string, unknown>;
      this.sent.push(message);
      if (respondToHello && message.type === 'client.hello') {
        void Promise.resolve().then(() => {
          if (this.readyState !== FakeWebSocket.OPEN) return;
          this.receive({ type: 'server.ready', protocolVersion: 1 });
        });
      }
    }

    receive(message: Record<string, unknown>): void {
      this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify(message) }));
    }
  };
}
