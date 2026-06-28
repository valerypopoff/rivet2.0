import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltInRegistry, type NodeId } from '@valerypopoff/rivet2-core';
import { createPastedNodeLibraryPrefabs } from './nodePrefabClipboard.js';

const registry = createBuiltInRegistry();

function makeNode(type: string, id: string, x: number, y: number) {
  const node = registry.createDynamic(type);
  node.id = id as NodeId;
  node.visualData.x = x;
  node.visualData.y = y;
  return node;
}

test('createPastedNodeLibraryPrefabs turns supported copied nodes into standalone prefabs', () => {
  const textNode = makeNode('text', 'text-node', 20, 40);
  const boolNode = makeNode('boolean', 'bool-node', 120, 90);
  const { prefabs, skippedNodeCount } = createPastedNodeLibraryPrefabs({
    nodes: [textNode, boolNode],
    position: { x: 500, y: 600 },
  });

  assert.equal(prefabs.length, 2);
  assert.equal(skippedNodeCount, 0);
  assert.notEqual(prefabs[0]!.sourceNode.id, textNode.id);
  assert.notEqual(prefabs[1]!.sourceNode.id, boolNode.id);
  assert.equal(prefabs[0]!.sourceNode.type, 'text');
  assert.equal(prefabs[1]!.sourceNode.type, 'boolean');
  assert.deepEqual(
    prefabs.map((prefab) => ({ x: prefab.sourceNode.visualData.x, y: prefab.sourceNode.visualData.y })),
    [
      { x: 500, y: 600 },
      { x: 600, y: 650 },
    ],
  );
});

test('createPastedNodeLibraryPrefabs skips node types that cannot be library sources', () => {
  const textNode = makeNode('text', 'text-node', 0, 0);
  const graphInputNode = makeNode('graphInput', 'graph-input-node', 100, 100);
  const prefabInstanceNode = makeNode('nodePrefabInstance', 'prefab-instance-node', 200, 200);

  const { prefabs, skippedNodeCount } = createPastedNodeLibraryPrefabs({
    nodes: [graphInputNode, textNode, prefabInstanceNode],
    position: { x: 10, y: 20 },
  });

  assert.equal(prefabs.length, 1);
  assert.equal(prefabs[0]!.sourceNode.type, 'text');
  assert.equal(skippedNodeCount, 2);
});
