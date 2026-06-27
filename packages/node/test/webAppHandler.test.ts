import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createRivetWebAppHandler,
  type DataValue,
  type GraphId,
  type NodeGraph,
  type Project,
  type UiGraphComponent,
  type UiGraphId,
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

  void it('serves card-backed input and textarea field styling', async () => {
    const handler = createRivetWebAppHandler(makeProject(), { basePath: '/app', uiGraphId: 'ui-graph' });
    const response = await handler.handleRequest(new Request('https://example.test/app'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /\.rivet-card, \.rivet-field \{ background:/);
    assert.match(html, /\.rivet-field-label \{ opacity: \.9; \}/);
    assert.match(html, /input, textarea \{ appearance: none;[\s\S]*border: 1px solid rgba\(255,255,255,\.18\);/);
    assert.match(html, /className: 'rivet-field'/);
    assert.match(html, /className: 'rivet-field-label'/);
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
