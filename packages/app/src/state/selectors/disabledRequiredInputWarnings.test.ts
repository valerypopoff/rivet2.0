import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltInRegistry, type NodeConnection, type NodePrefabId, type ProjectId } from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { graphState } from '../atoms/graph.js';
import { projectState } from '../savedGraphs.js';
import { disabledRequiredInputWarningsState } from './ioDefinitions.js';

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
    store.get(disabledRequiredInputWarningsState).get(target.id),
    'Required input "Object" is connected to disabled node "Disabled source". It will not provide a value, so this node is marked Not Ran. Enable the source or remove or replace the connection.',
  );

  store.set(graphState, { ...graph, nodes: [{ ...source, disabled: false }, target] });
  assert.equal(store.get(disabledRequiredInputWarningsState).get(target.id), undefined);

  store.set(graphState, { ...graph, connections: [] });
  assert.equal(store.get(disabledRequiredInputWarningsState).get(target.id), undefined);
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
    connections: [{
      outputNodeId: sourceInstance.id,
      outputId: 'output',
      inputNodeId: target.id,
      inputId: 'object',
    }],
  } as any);

  assert.equal(
    store.get(disabledRequiredInputWarningsState).get(target.id),
    'Required input "Object" is connected to disabled node "Disabled library source". It will not provide a value, so this node is marked Not Ran. Enable the source or remove or replace the connection.',
  );
});