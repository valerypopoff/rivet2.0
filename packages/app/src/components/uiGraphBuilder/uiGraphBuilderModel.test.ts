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
  normalizeButtonActionToGraphBoundary,
  type UiGraphButtonComponent,
} from './buttonBindings.js';
import {
  createUiGraphComponent,
  getUiGraphComponentDataKeys,
  getUiGraphGraphOptions,
  UI_GRAPH_COMPONENT_DESCRIPTORS,
  UI_GRAPH_COMPONENT_PALETTE,
} from './componentDescriptors.js';
import { collectUiGraphDataKeyUsages, getUniqueDataKeyOptions, isDataKeyAlreadyUsedEarlier } from './dataKeys.js';
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

test('component descriptors exhaustively own labels, defaults, settings, and data-key policy', () => {
  const expectedTypes: UiGraphComponent['type'][] = [
    'text',
    'markdown',
    'gap',
    'input',
    'textarea',
    'button',
    'output',
  ];

  assert.deepEqual(Object.keys(UI_GRAPH_COMPONENT_DESCRIPTORS), expectedTypes);
  assert.deepEqual(
    UI_GRAPH_COMPONENT_PALETTE.map(({ type }) => type),
    expectedTypes,
  );

  for (const type of expectedTypes) {
    const descriptor = UI_GRAPH_COMPONENT_DESCRIPTORS[type];
    const component = createUiGraphComponent(type, graphId);

    assert.equal(component.type, type);
    assert.ok(component.id);
    assert.ok(descriptor.label);
    assert.equal(typeof descriptor.Settings, 'function');
    assert.doesNotThrow(() => getUiGraphComponentDataKeys(component));
    if (component.type === 'gap') {
      assert.equal(component.size, 'medium');
      assert.deepEqual(getUiGraphComponentDataKeys(component), { reads: [], writes: [] });
    }
  }
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
