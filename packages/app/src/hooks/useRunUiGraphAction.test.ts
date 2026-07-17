import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getUiGraphChatMessagesStateKey,
  type GraphId,
  type GraphOutputs,
  type GraphProgress,
  type Project,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { runUiGraphAction } from './useRunUiGraphAction.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';

test('web app actions run through the editor graph runner and wait for outputs', async () => {
  const componentId = 'button-1' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const outputs: GraphOutputs = {
    result: { type: 'string', value: 'done' },
  };
  const calls: EditorGraphRunOptions[] = [];
  const progress = { message: 'Working', percent: 25 };
  const onProgress = (report: GraphProgress) => assert.equal(report, progress);
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
      const getStorage = options?.externalFunctions?.getWebAppStorage;
      const setStorage = options?.externalFunctions?.setWebAppStorage;
      assert.deepEqual(await getStorage?.({} as never, 'existing'), { type: 'any', value: 'old' });
      await setStorage?.({} as never, 'analysis', { summary: 'Saved in preview storage' });
      options?.onProgress?.(progress);
      return outputs;
    },
    onProgress,
    storage: { existing: 'old' },
    uiGraph,
  });

  assert.equal(calls.length, 1);
  const { externalFunctions, ...runCall } = calls[0]!;
  assert.deepEqual(Object.keys(externalFunctions ?? {}).sort(), ['getWebAppStorage', 'setWebAppStorage']);
  assert.deepEqual(runCall, {
    graphId,
    inputs: {
      input: { type: 'string', value: 'hello' },
      staticValue: { type: 'number', value: 42 },
    },
    requireLiveRun: true,
    onProgress,
    throwOnError: true,
    waitForResults: true,
  });
  assert.deepEqual(result, {
    outputs,
    statePatch: {
      lastResult: outputs,
    },
    storagePatch: { analysis: { summary: 'Saved in preview storage' } },
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
    storagePatch: {},
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

test('Chat actions run visibly with current input, prior native history, and mapped page data', async () => {
  const componentId = 'chat' as UiComponentId;
  const graphId = 'graph-1' as GraphId;
  const messagesKey = getUiGraphChatMessagesStateKey(componentId);
  const uiGraph: UiGraph = {
    components: [
      {
        action: {
          graphId,
          historyInputId: 'history',
          inputMappings: [{ inputKey: 'tone', stateKey: 'tone' }],
          responseOutputId: 'response',
          type: 'runGraph',
          userInputId: 'message',
        },
        id: componentId,
        type: 'chat',
      },
    ],
    id: 'ui-graph-1' as UiGraphId,
    name: 'Chat app',
  };
  const state = {
    [messagesKey]: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Hello' },
    ],
    tone: 'Friendly',
  };
  let call: EditorGraphRunOptions | undefined;

  const result = await runUiGraphAction({
    componentId,
    project: makeProject(uiGraph, graphId),
    state,
    tryRunGraph: async (options) => {
      call = options;
      return { response: { type: 'string', value: 'Hi!' } };
    },
    uiGraph,
  });

  assert.deepEqual(call?.inputs, {
    history: {
      type: 'chat-message[]',
      value: [{ type: 'assistant', message: 'Welcome', function_call: undefined, function_calls: undefined }],
    },
    message: { type: 'string', value: 'Hello' },
    tone: { type: 'string', value: 'Friendly' },
  });
  assert.deepEqual(result.statePatch, {
    [messagesKey]: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ],
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
    storagePatch: {},
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
  const actionComponent = uiGraph.components.find(
    (component) => component.type === 'button' || component.type === 'chat',
  );
  assert.ok(actionComponent);
  const inputIds =
    actionComponent.type === 'button'
      ? actionComponent.action.inputMappings?.map((binding) => binding.inputKey) ??
        Object.keys(actionComponent.action.inputs ?? {})
      : [
          actionComponent.action.userInputId,
          actionComponent.action.historyInputId,
          ...(actionComponent.action.inputMappings ?? []).map((binding) => binding.inputKey),
        ].filter((inputId): inputId is string => !!inputId);
  const outputIds = (
    actionComponent.type === 'button'
      ? actionComponent.action.outputs?.map((binding) => binding.outputKey) ?? [actionComponent.action.outputKey]
      : [actionComponent.action.responseOutputId]
  ).filter((outputId): outputId is string => !!outputId);

  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: { description: '', id: graphId, name: 'Graph' },
        nodes: [
          ...inputIds.map((id, index) => ({
            data: { dataType: id === 'history' ? 'chat-message[]' : 'string', id },
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
