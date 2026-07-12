import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, GraphOutputs, Project, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import { runUiGraphAction } from './useRunUiGraphAction.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';

test('web app actions run through the editor graph runner and wait for outputs', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const outputs: GraphOutputs = {
    result: { type: 'string', value: 'done' },
  };
  const calls: EditorGraphRunOptions[] = [];
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        id: componentId,
        type: 'button',
        label: 'Run',
        action: {
          type: 'runGraph',
          graphId,
          inputs: {
            input: { type: 'state', key: 'prompt' },
            staticValue: { type: 'literal', value: 42 },
          },
          outputStateKey: 'lastResult',
        },
      },
    ],
  };

  const result = await runUiGraphAction({
    componentId,
    project: makeProject(uiGraph, graphId),
    state: { prompt: 'hello' },
    tryRunGraph: async (options) => {
      calls.push(options ?? {});
      return outputs;
    },
    uiGraph,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    graphId,
    inputs: {
      input: { type: 'string', value: 'hello' },
      staticValue: { type: 'number', value: 42 },
    },
    requireLiveRun: true,
    throwOnError: true,
    waitForResults: true,
  });
  assert.deepEqual(result, {
    outputs,
    statePatch: {
      lastResult: outputs,
    },
  });
});

test('web app actions can map multiple inputs and outputs', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const outputs: GraphOutputs = {
    answer: { type: 'string', value: 'done' },
    score: { type: 'number', value: 7 },
  };
  const calls: EditorGraphRunOptions[] = [];
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        id: componentId,
        type: 'button',
        label: 'Run',
        action: {
          type: 'runGraph',
          graphId,
          inputMappings: [
            { inputKey: 'prompt', stateKey: 'draftPrompt' },
            { inputKey: 'count', stateKey: 'draftCount' },
          ],
          outputs: [
            { outputKey: 'answer', stateKey: 'lastAnswer' },
            { outputKey: 'score', stateKey: 'lastScore' },
          ],
        },
      },
    ],
  };

  const result = await runUiGraphAction({
    componentId,
    project: makeProject(uiGraph, graphId),
    state: { draftCount: 2, draftPrompt: 'hello' },
    tryRunGraph: async (options) => {
      calls.push(options ?? {});
      return outputs;
    },
    uiGraph,
  });

  assert.deepEqual(calls[0]?.inputs, {
    count: { type: 'number', value: 2 },
    prompt: { type: 'string', value: 'hello' },
  });
  assert.deepEqual(result, {
    outputs,
    statePatch: {
      lastAnswer: 'done',
      lastScore: 7,
    },
  });
});

test('web app actions map array state values to typed Data Values', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const outputs: GraphOutputs = {
    tags: { type: 'string[]', value: ['one', 'two'] },
  };
  const calls: EditorGraphRunOptions[] = [];
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        id: componentId,
        type: 'button',
        label: 'Run',
        action: {
          type: 'runGraph',
          graphId,
          inputMappings: [{ inputKey: 'tags', stateKey: 'draftTags' }],
          outputStateKey: 'lastResult',
        },
      },
    ],
  };

  await runUiGraphAction({
    componentId,
    project: makeProject(uiGraph, graphId),
    state: { draftTags: ['one', 'two'] },
    tryRunGraph: async (options) => {
      calls.push(options ?? {});
      return outputs;
    },
    uiGraph,
  });

  assert.deepEqual(calls[0]?.inputs, {
    tags: { type: 'string[]', value: ['one', 'two'] },
  });
});

test('web app actions can store one unwrapped graph output value', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const outputs: GraphOutputs = {
    graphOutput: { type: 'string', value: 'hello from graph' },
    cost: { type: 'number', value: 0 },
  };
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        id: componentId,
        type: 'button',
        label: 'Run',
        action: {
          type: 'runGraph',
          graphId,
          outputKey: 'graphOutput',
          outputStateKey: 'lastResult',
        },
      },
    ],
  };

  const result = await runUiGraphAction({
    componentId,
    project: makeProject(uiGraph, graphId),
    state: {},
    tryRunGraph: async () => outputs,
    uiGraph,
  });

  assert.deepEqual(result, {
    outputs,
    statePatch: {
      lastResult: 'hello from graph',
    },
  });
});

test('web app actions fail clearly when the selected graph output is missing', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        id: componentId,
        type: 'button',
        label: 'Run',
        action: {
          type: 'runGraph',
          graphId,
          outputKey: 'missing',
          outputStateKey: 'lastResult',
        },
      },
    ],
  };

  await assert.rejects(
    () =>
      runUiGraphAction({
        componentId,
        project: makeProject(uiGraph, graphId),
        state: {},
        tryRunGraph: async () => ({ result: { type: 'string', value: 'done' } }),
        uiGraph,
      }),
    /Graph output "missing" was not returned by the target graph/,
  );
});

test('web app actions reject stale bindings before starting an editor graph run', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const uiGraph: UiGraph = {
    components: [
      {
        action: {
          graphId,
          inputMappings: [{ inputKey: 'removed', stateKey: 'prompt' }],
          type: 'runGraph',
        },
        id: componentId,
        label: 'Run',
        type: 'button',
      },
    ],
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
  };
  const project = makeProject(uiGraph, graphId);
  const inputNode = project.graphs[graphId]!.nodes[0]!;
  (inputNode.data as { id: string }).id = 'current';
  let didRun = false;

  await assert.rejects(
    () =>
      runUiGraphAction({
        componentId,
        project,
        state: { prompt: 'hello' },
        tryRunGraph: async () => {
          didRun = true;
          return {};
        },
        uiGraph,
      }),
    /Graph input "removed" no longer exists/,
  );
  assert.equal(didRun, false);
});

test('web app actions propagate cancellation and reject results completed after abort', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const uiGraph: UiGraph = {
    id: 'ui-graph-1' as UiGraphId,
    name: 'Test app',
    components: [
      {
        action: {
          graphId,
          outputs: [{ outputKey: 'result', stateKey: 'lastResult' }],
          type: 'runGraph',
        },
        id: componentId,
        label: 'Run',
        type: 'button',
      },
    ],
  };
  const abortController = new AbortController();
  let receivedAbortSignal: AbortSignal | undefined;
  let resolveRun!: (outputs: GraphOutputs) => void;
  const actionPromise = runUiGraphAction({
    abortSignal: abortController.signal,
    componentId,
    project: makeProject(uiGraph, graphId),
    state: {},
    tryRunGraph: async (options) => {
      receivedAbortSignal = options?.abortSignal;
      return await new Promise<GraphOutputs>((resolve) => (resolveRun = resolve));
    },
    uiGraph,
  });

  abortController.abort();
  resolveRun({ result: { type: 'string', value: 'stale' } });

  await assert.rejects(actionPromise, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(receivedAbortSignal, abortController.signal);
});

function makeProject(uiGraph: UiGraph, graphId: GraphId): Project {
  const button = uiGraph.components.find((component) => component.type === 'button');
  assert.ok(button?.type === 'button');
  const inputIds =
    button.action.inputMappings?.map((binding) => binding.inputKey) ?? Object.keys(button.action.inputs ?? {});
  const outputIds = (button.action.outputs?.map((binding) => binding.outputKey) ?? [button.action.outputKey]).filter(
    (outputId): outputId is string => !!outputId,
  );

  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: { description: '', id: graphId, name: 'Graph' },
        nodes: [
          ...inputIds.map((id, index) => ({
            data: { dataType: 'string', id },
            id: `input-${index}` as any,
            title: id,
            type: 'graphInput' as const,
            visualData: { x: 0, y: index * 100 },
          })),
          ...outputIds.map((id, index) => ({
            data: { dataType: 'string', id },
            id: `output-${index}` as any,
            title: id,
            type: 'graphOutput' as const,
            visualData: { x: 300, y: index * 100 },
          })),
        ] as any,
      },
    },
    metadata: { description: '', id: 'project' as any, title: 'Project' },
    uiGraphs: { [uiGraph.id]: uiGraph },
  };
}
