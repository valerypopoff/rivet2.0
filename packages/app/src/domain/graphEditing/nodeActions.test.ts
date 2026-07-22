import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  createAddedNode,
  createPastedNodes,
  duplicateNodeWithConnections,
  duplicateNodesWithConnections,
} from './nodeActions';

test('createAddedNode applies configured default colors to supported node types', () => {
  const registry = createBuiltInRegistry();

  const graphInputNode = createAddedNode({
    nodeType: 'graphInput',
    position: { x: 10, y: 20 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const graphOutputNode = createAddedNode({
    nodeType: 'graphOutput',
    position: { x: 30, y: 40 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const httpCallNode = createAddedNode({
    nodeType: 'httpCall',
    position: { x: 50, y: 60 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const getGlobalNode = createAddedNode({
    nodeType: 'getGlobal',
    position: { x: 70, y: 80 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const setGlobalNode = createAddedNode({
    nodeType: 'setGlobal',
    position: { x: 90, y: 100 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const getStoredValueNode = createAddedNode({
    nodeType: 'getStoredValue',
    position: { x: 100, y: 110 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const setStoredValueNode = createAddedNode({
    nodeType: 'setStoredValue',
    position: { x: 105, y: 115 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });
  const subGraphNode = createAddedNode({
    nodeType: 'subGraph',
    position: { x: 110, y: 120 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });

  assert.deepEqual(graphInputNode.visualData.color, { bg: 'var(--node-color-3)', border: 'transparent' });
  assert.deepEqual(graphOutputNode.visualData.color, { bg: 'var(--node-color-3)', border: 'transparent' });
  assert.deepEqual(httpCallNode.visualData.color, { bg: 'var(--node-color-6)', border: 'transparent' });
  assert.deepEqual(getGlobalNode.visualData.color, { bg: 'var(--node-color-7)', border: 'transparent' });
  assert.deepEqual(setGlobalNode.visualData.color, { bg: 'var(--node-color-7)', border: 'transparent' });
  assert.deepEqual(getStoredValueNode.visualData.color, { bg: 'var(--node-color-7)', border: 'transparent' });
  assert.deepEqual(setStoredValueNode.visualData.color, { bg: 'var(--node-color-7)', border: 'transparent' });
  assert.deepEqual(subGraphNode.visualData.color, { bg: 'var(--node-color-2)', border: 'transparent' });
});

test('createAddedNode leaves node colors untouched when default node colors are disabled or unsupported', () => {
  const registry = createBuiltInRegistry();

  const graphInputNode = createAddedNode({
    nodeType: 'graphInput',
    position: { x: 10, y: 20 },
    registry,
    referencedProjects: {},
    applyDefaultColor: false,
  });
  const textNode = createAddedNode({
    nodeType: 'text',
    position: { x: 30, y: 40 },
    registry,
    referencedProjects: {},
    applyDefaultColor: true,
  });

  assert.equal(graphInputNode.visualData.color, undefined);
  assert.equal(textNode.visualData.color, undefined);
});

test('createAddedNode sizes linked nodes from the library node', () => {
  const registry = createBuiltInRegistry();
  const prefabId = 'prefab-text' as NodePrefabId;
  const project: Project = {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: 'graph' as GraphId,
    },
    graphs: {},
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode: {
          id: 'source' as NodeId,
          type: 'text',
          title: 'Shared Text',
          visualData: { x: 0, y: 0, width: 420 },
          data: { text: 'hello' },
        } as ChartNode<'text'>,
      },
    },
    plugins: [],
  };

  const instance = createAddedNode({
    nodeType: `nodePrefabInstance:${prefabId}`,
    position: { x: 10, y: 20 },
    registry,
    referencedProjects: {},
    project,
  });

  assert.equal(instance.title, 'Shared Text');
  assert.equal(instance.visualData.width, 420);
});

test('duplicateNodeWithConnections clones nested node data independently', () => {
  const registry = createBuiltInRegistry();
  const node = registry.createDynamic('chat');
  (node.data as any) = {
    nested: {
      temperature: 0.5,
    },
  };

  const { newNode } = duplicateNodeWithConnections({
    node,
    connections: [],
    registry,
  });

  ((newNode.data as any).nested as { temperature: number }).temperature = 0.9;

  assert.equal((node.data as any).nested.temperature, 0.5);
  assert.equal((newNode.data as any).nested.temperature, 0.9);
});

test('duplicateNodeWithConnections places the copy below and to the right of the source node', () => {
  const registry = createBuiltInRegistry();
  const node = registry.createDynamic('chat');
  node.visualData.x = 10;
  node.visualData.y = 20;

  const { newNode } = duplicateNodeWithConnections({
    node,
    connections: [],
    registry,
  });

  assert.equal(newNode.visualData.x, 90);
  assert.equal(newNode.visualData.y, 220);
});

test('createPastedNodes remaps node ids and internal connections from the new anchor position', () => {
  const registry = createBuiltInRegistry();
  const source = registry.createDynamic('chat');
  const target = registry.createDynamic('chat');

  source.visualData.x = 10;
  source.visualData.y = 20;
  target.visualData.x = 110;
  target.visualData.y = 220;

  const { newNodes, newConnections } = createPastedNodes({
    nodes: [source, target],
    connections: [
      {
        inputNodeId: target.id,
        inputId: 'prompt' as any,
        outputNodeId: source.id,
        outputId: 'messages' as any,
      },
    ],
    position: { x: 500, y: 600 },
  });

  assert.equal(newNodes.length, 2);
  assert.equal(newConnections.length, 1);
  assert.equal(newNodes[0]!.visualData.x, 500);
  assert.equal(newNodes[0]!.visualData.y, 600);
  assert.equal(newNodes[1]!.visualData.x, 600);
  assert.equal(newNodes[1]!.visualData.y, 800);
  assert.notEqual(newNodes[0]!.id, source.id);
  assert.notEqual(newNodes[1]!.id, target.id);
  assert.equal(newConnections[0]!.outputNodeId, newNodes[0]!.id);
  assert.equal(newConnections[0]!.inputNodeId, newNodes[1]!.id);
});

test('duplicateNodesWithConnections duplicates internal links and external incoming links for the dragged cohort', () => {
  const registry = createBuiltInRegistry();
  const source = registry.createDynamic('chat');
  const target = registry.createDynamic('chat');
  const external = registry.createDynamic('text');

  source.visualData.x = 10;
  source.visualData.y = 20;
  target.visualData.x = 110;
  target.visualData.y = 220;

  const { newNodes, duplicatedConnections } = duplicateNodesWithConnections({
    nodes: [external, source, target],
    nodeIds: [source.id, target.id],
    connections: [
      {
        inputNodeId: source.id,
        inputId: 'prompt' as any,
        outputNodeId: external.id,
        outputId: 'data' as any,
      },
      {
        inputNodeId: target.id,
        inputId: 'prompt' as any,
        outputNodeId: source.id,
        outputId: 'response' as any,
      },
      {
        inputNodeId: external.id,
        inputId: 'data' as any,
        outputNodeId: target.id,
        outputId: 'response' as any,
      },
    ],
    delta: { x: 50, y: 75 },
  });

  assert.equal(newNodes.length, 2);
  assert.equal(newNodes[0]!.visualData.x, 60);
  assert.equal(newNodes[0]!.visualData.y, 95);
  assert.equal(newNodes[1]!.visualData.x, 160);
  assert.equal(newNodes[1]!.visualData.y, 295);
  assert.equal(duplicatedConnections.length, 2);
  assert.equal(duplicatedConnections[0]!.outputNodeId, external.id);
  assert.equal(duplicatedConnections[0]!.inputNodeId, newNodes[0]!.id);
  assert.equal(duplicatedConnections[1]!.outputNodeId, newNodes[0]!.id);
  assert.equal(duplicatedConnections[1]!.inputNodeId, newNodes[1]!.id);
});
