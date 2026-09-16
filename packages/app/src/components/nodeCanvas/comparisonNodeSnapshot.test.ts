import assert from 'node:assert/strict';
import test from 'node:test';
import {
  globalRivetNodeRegistry,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type Project,
} from '@valerypopoff/rivet2-core';
import {
  getComparisonBodySpecs,
  getComparisonNodeFallback,
  getComparisonNodePorts,
  getComparisonNodesById,
} from './comparisonNodeSnapshot.js';

const graphId = 'main' as GraphId;
function node(type: string, data: unknown = {}): ChartNode {
  return { id: type as NodeId, type, title: type, data, visualData: { x: 0, y: 0 } };
}
function project(nodes: ChartNode[]): Project {
  return {
    metadata: { id: 'reference' as Project['metadata']['id'], title: 'Reference', description: '' },
    graphs: {
      [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes, connections: [] },
    },
  } as Project;
}

test('reference subgraphs retain their name, conditional and boundary ports independently of current project', () => {
  const sub = { ...node('subGraph', { graphId: 'child' }), isConditional: true };
  const reference = project([sub]);
  reference.graphs['child' as GraphId] = {
    metadata: { id: 'child' as GraphId, name: 'Original target' },
    nodes: [
      node('graphInput', { id: 'original-input', dataType: 'string' }),
      node('graphOutput', { id: 'original-output', dataType: 'string' }),
    ],
    connections: [],
  };
  const before = structuredClone(reference);
  const ports = getComparisonNodePorts(globalRivetNodeRegistry, reference, reference.graphs[graphId]!, sub);
  assert.deepEqual(
    ports.inputs.map((port) => port.id),
    ['original-input', '$if'],
  );
  assert.deepEqual(
    ports.outputs.map((port) => port.id),
    ['original-output'],
  );
  assert.match(getComparisonNodeFallback(sub, reference), /Original target\nID: child/);
  assert.deepEqual(reference, before);
});

test('linked nodes resolve the reference library source while preserving the saved instance', () => {
  const instance = node('nodePrefabInstance', { prefabId: 'library' });
  const reference = project([instance]);
  reference.nodePrefabs = {
    ['library' as NodePrefabId]: {
      id: 'library' as NodePrefabId,
      sourceNode: node('getGlobal', { id: 'original-global', dataType: 'string' }),
    },
  };
  const before = structuredClone(reference);
  const resolved = getComparisonNodesById(reference, reference.graphs[graphId]!)[instance.id]!;
  assert.equal(resolved.type, 'getGlobal');
  assert.deepEqual(resolved.data, { id: 'original-global', dataType: 'string' });
  assert.equal(resolved.id, instance.id);
  assert.deepEqual(reference, before);
  assert.equal(instance.type, 'nodePrefabInstance');
});

test('missing plugins still have bounded settings previews and no invented ports', () => {
  const missing = node('missing-plugin', { prompt: 'line\n'.repeat(1000) });
  const reference = project([missing]);
  const fallback = getComparisonNodeFallback(missing, reference);
  assert.match(fallback, /missing-plugin/);
  assert.deepEqual(getComparisonNodePorts(globalRivetNodeRegistry, reference, reference.graphs[graphId]!, missing), {
    inputs: [],
    outputs: [],
  });
  const specs = getComparisonBodySpecs(undefined, fallback);
  assert.ok(specs[0]!.text.length < 4005);
  assert.match(specs[0]!.text, /…$/);
  assert.equal((missing.data as { prompt: string }).prompt.length, 5000);
  assert.equal(
    getComparisonNodeFallback({ ...node('missing-without-settings'), data: undefined }, reference),
    'missing-without-settings',
  );
});

test('body presentation preserves spec types, bounds previews and disables legacy Markdown links', () => {
  const input = Object.freeze({ type: 'colorized' as const, text: 'const original = true;', language: 'javascript' });
  assert.deepEqual(getComparisonBodySpecs(input, 'fallback'), [input]);
  assert.deepEqual(getComparisonBodySpecs('', 'fallback'), [{ type: 'plain', text: 'fallback' }]);
  assert.deepEqual(getComparisonBodySpecs('!markdown**original**', ''), [
    { type: 'markdown', text: '**original**', disableLinks: true },
  ]);
  assert.equal(getComparisonBodySpecs('x\n'.repeat(30), '')[0]!.text.split('\n').length, 13);
});
