import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, GraphOutputs, UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
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
        state: {},
        tryRunGraph: async () => ({ result: { type: 'string', value: 'done' } }),
        uiGraph,
      }),
    /Graph output "missing" was not returned by the target graph/,
  );
});
