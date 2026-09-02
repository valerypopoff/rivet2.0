import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type NodeConnection,
  type NodePrefabId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { graphState } from '../atoms/graph.js';
import { projectState } from '../savedGraphs.js';
import { disabledUpstreamInputWarningsState } from './ioDefinitions.js';

test('updates the warning when a direct required-input source is enabled or disabled', () => {
  const store = createStore();
  const registry = createBuiltInRegistry();
  const source = registry.createDynamic('text');
  const target = registry.createDynamic('destructure');
  source.title = 'Disabled source';
  source.disabled = true;

  const connection: NodeConnection = {
    outputNodeId: source.id,
    outputId: 'output' as any,
    inputNodeId: target.id,
    inputId: 'object' as any,
  };
  const graph = {
    metadata: { id: 'graph-1', name: 'Test Graph' },
    nodes: [source, target],
    connections: [connection],
  } as any;

  store.set(graphState, graph);
  assert.equal(
    store.get(disabledUpstreamInputWarningsState).get(target.id),
    'Input "Object" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );

  store.set(graphState, { ...graph, nodes: [{ ...source, disabled: false }, target] });
  assert.equal(store.get(disabledUpstreamInputWarningsState).get(target.id), undefined);

  store.set(graphState, { ...graph, connections: [] });
  assert.equal(store.get(disabledUpstreamInputWarningsState).get(target.id), undefined);
});
test('warns a Graph Input default-value connection from a disabled source', () => {
  const store = createStore();
  const registry = createBuiltInRegistry();
  const source = registry.createDynamic('text');
  const graphInput = registry.createDynamic('graphInput');
  source.title = 'Disabled source';
  source.disabled = true;
  (graphInput.data as { useDefaultValueInput: boolean }).useDefaultValueInput = true;

  const graph = {
    metadata: { id: 'graph-1', name: 'Test Graph' },
    nodes: [source, graphInput],
    connections: [
      {
        outputNodeId: source.id,
        outputId: 'output',
        inputNodeId: graphInput.id,
        inputId: 'default',
      },
    ],
  } as any;

  store.set(graphState, graph);
  assert.equal(
    store.get(disabledUpstreamInputWarningsState).get(graphInput.id),
    'Input "Default Value" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
});
test('uses the resolved disabled library source for a prefab instance', () => {
  const store = createStore();
  const registry = createBuiltInRegistry();
  const sourceTemplate = registry.createDynamic('text');
  const target = registry.createDynamic('destructure');
  const prefabId = 'disabled-source-prefab' as NodePrefabId;
  const sourceInstance = {
    id: 'prefab-source-instance',
    type: 'nodePrefabInstance',
    title: 'Outdated link title',
    data: { prefabId },
    visualData: { x: 0, y: 0, width: 250 },
  };

  sourceTemplate.title = 'Disabled library source';
  sourceTemplate.disabled = true;
  store.set(projectState, {
    metadata: { description: '', id: 'project-1' as ProjectId, title: 'Project' },
    graphs: {},
    nodePrefabs: {
      [prefabId]: { id: prefabId, sourceNode: sourceTemplate },
    },
    plugins: [],
  });
  store.set(graphState, {
    metadata: { id: 'graph-1', name: 'Test Graph' },
    nodes: [sourceInstance, target],
    connections: [
      {
        outputNodeId: sourceInstance.id,
        outputId: 'output',
        inputNodeId: target.id,
        inputId: 'object',
      },
    ],
  } as any);

  assert.equal(
    store.get(disabledUpstreamInputWarningsState).get(target.id),
    'Input "Object" is connected to disabled node "Disabled library source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
});
