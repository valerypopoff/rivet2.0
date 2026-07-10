import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import {
  createRivetWebAppHandler,
  type DataValue,
  type GraphId,
  type NodeGraph,
  type Project,
  RIVET_WEB_APP_DOCUMENT_CSS,
  RIVET_WEB_APP_RENDERER_CSS,
  RivetWebAppActionHttpError,
  type UiGraphComponent,
  type UiGraphId,
  renderRivetWebAppHtml,
  runRivetWebAppAction,
} from '../src/index.js';

const graphId = 'main-graph' as GraphId;

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

void describe('createRivetWebAppHandler', () => {
  void it('serves the UI graph HTML', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(new Request('https://example.test/app'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Test App/);
    assert.match(html, /\/app\/actions\/run/);
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

  void it('sanitizes hosted Markdown with the shared browser policy', () => {
    const project = makeProject();
    const uiGraph = project.uiGraphs?.['ui-graph' as UiGraphId]!;
    uiGraph.components = [
      {
        id: 'unsafe-markdown' as any,
        type: 'markdown',
        markdown: '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(2)) [safe](https://example.com/path)',
      },
    ];

    const html = renderRivetWebAppHtml(uiGraph, { actionPath: '/app/actions/run' });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/app' });
    const markdown = dom.window.document.querySelector('.rivet-web-app-markdown');
    const links = markdown?.querySelectorAll('a');

    assert.ok(markdown);
    assert.equal(markdown.querySelector('img'), null);
    assert.equal(links?.[0]?.hasAttribute('href'), false);
    assert.equal(links?.[1]?.getAttribute('href'), 'https://example.com/path');
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
        body: JSON.stringify({ componentId: 'run-button', revisionKey: 'rev-1', state: { prompt: 'hello' } }),
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

    assert.match(html, /"revisionKey":"rev-1"/);
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
    assert.match(html, /result\.code === "revision_mismatch"/);
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
    assert.deepEqual(errors, ['Graph output "missing-output" was not returned by the target graph.']);
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
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Graph output "missing-output" was not returned by the target graph.');
  });
});
