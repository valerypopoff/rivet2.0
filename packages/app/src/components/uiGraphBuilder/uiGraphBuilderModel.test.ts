import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GraphBoundary,
  GraphId,
  NodeId,
  PortId,
  Project,
  ProjectId,
  UiComponentId,
  UiGraph,
  UiGraphComponent,
} from '@valerypopoff/rivet2-core';
import {
  alignInputRowsToBoundary,
  alignOutputRowsToBoundary,
  getButtonOutputRows,
  normalizeButtonActionToGraphBoundary,
  type UiGraphButtonComponent,
} from './buttonBindings.js';
import {
  createChatAdditionalInputBinding,
  createUiGraphComponent,
  getUiGraphComponentDataKeys,
  getUiGraphGraphOptions,
  UI_GRAPH_COMPONENT_MODELS,
  UI_GRAPH_COMPONENT_PALETTE,
  UI_GRAPH_COMPONENT_PALETTE_GROUPS,
} from './uiGraphComponentModel.js';
import {
  collectUiGraphDataKeyUsages,
  getUniqueDataKeyOptions,
  isDataKeyAlreadyUsedEarlier,
  isUiGraphDataKeyMissing,
} from './dataKeys.js';
import { canRunDesktopWebAppPreview } from './uiGraphBuilderPolicy.js';

const graphId = 'graph' as GraphId;

function makeBoundary(inputIds: string[], outputIds: string[]): GraphBoundary {
  return {
    inputs: inputIds.map((id) => ({ dataType: 'string', id, portId: `input-${id}` as PortId })),
    outputs: outputIds.map((id) => ({
      dataType: 'string',
      id,
      nodeId: `output-${id}` as NodeId,
      portId: `output-${id}` as PortId,
    })),
  };
}

test('button bindings follow graph boundary order while preserving matching data keys', () => {
  const boundary = makeBoundary(['second', 'first', 'new'], ['beta', 'alpha']);

  assert.deepEqual(
    alignInputRowsToBoundary(boundary, [
      { inputKey: 'first', stateKey: 'first-state' },
      { inputKey: 'second', stateKey: 'second-state' },
    ]),
    [
      { inputKey: 'second', stateKey: 'second-state' },
      { inputKey: 'first', stateKey: 'first-state' },
      { inputKey: 'new', stateKey: 'new' },
    ],
  );
  assert.deepEqual(
    alignOutputRowsToBoundary(boundary, [
      { outputKey: 'alpha', stateKey: 'alpha-state' },
      { outputKey: 'beta', stateKey: 'beta-state' },
    ]),
    [
      { outputKey: 'beta', stateKey: 'beta-state' },
      { outputKey: 'alpha', stateKey: 'alpha-state' },
    ],
  );
});

test('button bindings do not reuse data keys from unrelated rows by position', () => {
  assert.deepEqual(
    alignInputRowsToBoundary(makeBoundary(['replacement'], []), [{ inputKey: 'removed', stateKey: 'old-state' }]),
    [{ inputKey: 'replacement', stateKey: 'replacement' }],
  );
  assert.deepEqual(
    alignOutputRowsToBoundary(makeBoundary([], ['replacement']), [{ outputKey: 'removed', stateKey: 'old-state' }]),
    [{ outputKey: 'replacement', stateKey: 'replacement' }],
  );
});

test('button normalization migrates legacy bindings without changing mapped state keys', () => {
  const button: UiGraphButtonComponent = {
    action: {
      graphId,
      inputs: { prompt: { key: 'question', type: 'state' } },
      outputKey: 'answer',
      outputStateKey: 'result',
      type: 'runGraph',
    },
    id: 'button' as UiComponentId,
    label: 'Run',
    type: 'button',
  };

  normalizeButtonActionToGraphBoundary(button, makeBoundary(['prompt'], ['answer']));

  assert.deepEqual(button.action.inputMappings, [{ inputKey: 'prompt', stateKey: 'question' }]);
  assert.deepEqual(button.action.outputs, [{ outputKey: 'answer', stateKey: 'result' }]);
  assert.equal(button.action.inputs, undefined);
  assert.equal(button.action.outputKey, undefined);
  assert.equal(button.action.outputStateKey, undefined);
});

test('button settings show an empty persisted output mapping instead of a render-time default', () => {
  const button: UiGraphButtonComponent = {
    action: {
      graphId,
      outputs: [{ outputKey: 'answer', stateKey: '' }],
      type: 'runGraph',
    },
    id: 'button' as UiComponentId,
    label: 'Run',
    type: 'button',
  };

  assert.deepEqual(getButtonOutputRows(button, makeBoundary([], ['answer'])), [{ outputKey: 'answer', stateKey: '' }]);
});

test('component models exhaustively own labels, defaults, and data-key policy', () => {
  const expectedTypes: UiGraphComponent['type'][] = [
    'text',
    'markdown',
    'gap',
    'input',
    'textarea',
    'dropdown',
    'button',
    'chat',
    'output',
  ];

  assert.deepEqual(Object.keys(UI_GRAPH_COMPONENT_MODELS), expectedTypes);
  assert.deepEqual(
    UI_GRAPH_COMPONENT_PALETTE.map(({ type }) => type),
    expectedTypes,
  );
  assert.deepEqual(
    UI_GRAPH_COMPONENT_PALETTE_GROUPS.flatMap(({ types }) => types),
    expectedTypes,
  );

  for (const type of expectedTypes) {
    const descriptor = UI_GRAPH_COMPONENT_MODELS[type];
    const component = createUiGraphComponent(type, graphId);

    assert.equal(component.type, type);
    assert.ok(component.id);
    assert.ok(descriptor.label);
    assert.doesNotThrow(() => getUiGraphComponentDataKeys(component));
    if (component.type === 'gap') {
      assert.equal(component.size, 'medium');
      assert.deepEqual(getUiGraphComponentDataKeys(component), { reads: [], writes: [] });
    }
    if (component.type === 'dropdown') {
      assert.deepEqual(component.items, [{ label: 'Option 1', value: 'option-1' }]);
      assert.deepEqual(getUiGraphComponentDataKeys(component), { reads: [], writes: [{ key: 'selection' }] });
    }
  }
});

test('Chat descriptor reports only explicitly mapped page data as reads', () => {
  const chat = createUiGraphComponent('chat', graphId);
  assert.equal(chat.type, 'chat');
  chat.action.inputMappings = [
    { inputKey: 'tone', stateKey: 'selectedTone' },
    { inputKey: 'context', stateKey: 'pageContext' },
  ];

  assert.deepEqual(getUiGraphComponentDataKeys(chat), {
    reads: ['selectedTone', 'pageContext'],
    writes: [],
  });
});

test('Chat can add unfinished additional input rows after graph inputs are exhausted', () => {
  const boundary = makeBoundary(['message', 'history', 'tone'], ['response']);
  assert.deepEqual(
    createChatAdditionalInputBinding(
      {
        graphId,
        historyInputId: 'history',
        responseOutputId: 'response',
        type: 'runGraph',
        userInputId: 'message',
      },
      boundary,
      ['tone'],
    ),
    { inputKey: 'tone', stateKey: 'tone' },
  );
  const action = {
    graphId,
    historyInputId: 'history',
    inputMappings: [{ inputKey: 'tone', stateKey: 'tone' }],
    responseOutputId: 'response',
    type: 'runGraph' as const,
    userInputId: 'message',
  };

  assert.deepEqual(createChatAdditionalInputBinding(action, boundary, ['tone']), {
    inputKey: '',
    stateKey: 'tone',
  });
  assert.deepEqual(createChatAdditionalInputBinding({ graphId, type: 'runGraph' }, undefined, []), {
    inputKey: '',
    stateKey: '',
  });
});

test('the graph selector keeps a deleted target visible as a disabled option', () => {
  const project: Project = {
    metadata: { description: '', id: 'project' as ProjectId, title: 'Project' },
    graphs: {
      [graphId]: {
        connections: [],
        metadata: { description: '', id: graphId, name: 'Main graph' },
        nodes: [],
      },
    },
  };

  assert.deepEqual(getUiGraphGraphOptions(project, 'deleted-graph' as GraphId), [
    { isDisabled: true, label: 'deleted-graph (missing)', value: 'deleted-graph' },
    { label: 'Main graph', value: graphId },
  ]);
});

test('data-key indexing reports only later producers as duplicates and exposes consumer reads', () => {
  const firstInput = {
    id: 'first-input' as UiComponentId,
    label: 'First',
    stateKey: 'question',
    type: 'input',
  } satisfies UiGraphComponent;
  const secondInput = {
    id: 'second-input' as UiComponentId,
    label: 'Second',
    stateKey: 'question',
    type: 'textarea',
  } satisfies UiGraphComponent;
  const button = {
    action: {
      graphId,
      inputMappings: [{ inputKey: 'prompt', stateKey: 'question' }],
      outputs: [{ outputKey: 'answer', stateKey: 'result' }],
      type: 'runGraph',
    },
    id: 'button' as UiComponentId,
    label: 'Run',
    type: 'button',
  } satisfies UiGraphComponent;
  const output = {
    id: 'output' as UiComponentId,
    stateKey: 'result',
    type: 'output',
  } satisfies UiGraphComponent;
  const uiGraph = {
    components: [firstInput, secondInput, button, output],
    id: 'ui-graph',
    name: 'App',
  } as UiGraph;
  const usages = collectUiGraphDataKeyUsages(uiGraph);

  assert.deepEqual(getUniqueDataKeyOptions(usages), ['question', 'result']);
  assert.equal(isUiGraphDataKeyMissing('', ['question']), false);
  assert.equal(isUiGraphDataKeyMissing('question', ['question']), false);
  assert.equal(isUiGraphDataKeyMissing('removed-key', ['question']), true);
  assert.equal(isDataKeyAlreadyUsedEarlier(usages, 'question', { componentId: firstInput.id }), false);
  assert.equal(isDataKeyAlreadyUsedEarlier(usages, 'question', { componentId: secondInput.id }), true);
  assert.deepEqual(getUiGraphComponentDataKeys(button), {
    reads: ['question'],
    writes: [{ key: 'result', outputIndex: 0 }],
  });
  assert.deepEqual(getUiGraphComponentDataKeys(output), { reads: ['result'], writes: [] });
});

test('host UI policy disables only detached desktop preview when explicitly requested', () => {
  assert.equal(canRunDesktopWebAppPreview({}), true);
  assert.equal(canRunDesktopWebAppPreview({ webApps: {} }), true);
  assert.equal(canRunDesktopWebAppPreview({ webApps: { desktopPreview: false } }), false);
});
