import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileSubgraphTargetBoundary,
  type DataType,
  type GraphBoundary,
  type NodeId,
  type PortId,
} from '../../src/index.js';
import { buildGraphBoundaryInputData } from '../../src/model/GraphBoundaryCache.js';

function port(id: string, nodeId: string, dataType: DataType = 'string') {
  return { id, nodeId: nodeId as NodeId, portId: id as PortId, dataType };
}
function boundary(...ports: ReturnType<typeof port>[]): GraphBoundary {
  return { inputs: ports, outputs: ports };
}

test('external boundaries adopt type changes and additions while preserving renamed wire IDs', () => {
  const saved = boundary(port('old', 'survivor'), port('removed', 'deleted'));
  const original = structuredClone(saved);
  const actual = boundary(port('added', 'new'), port('renamed', 'survivor', 'number'));
  const next = reconcileSubgraphTargetBoundary(saved, actual);
  for (const side of ['inputs', 'outputs'] as const) {
    assert.deepEqual(
      next[side].map(({ id, portId, dataType }) => ({ id, portId, dataType })),
      [
        { id: 'added', portId: 'added', dataType: 'string' },
        { id: 'renamed', portId: 'old', dataType: 'number' },
      ],
    );
  }
  assert.deepEqual(saved, original);
});

test('a removed port disappears and a recreated same-name port is adopted automatically', () => {
  const saved = boundary(port('input', 'old-node'));
  assert.deepEqual(reconcileSubgraphTargetBoundary(saved, boundary()), boundary());
  const replacement = boundary(port('input', 'replacement', 'number'));
  assert.deepEqual(reconcileSubgraphTargetBoundary(saved, replacement), replacement);
});

test('reusing a renamed port name keeps the original wire and new port distinct across saves', () => {
  const saved = boundary(port('old', 'survivor'));
  const actual = boundary(port('old', 'new'), port('renamed', 'survivor'));
  const next = reconcileSubgraphTargetBoundary(saved, actual);
  for (const side of ['inputs', 'outputs'] as const) {
    assert.deepEqual(
      next[side].map(({ id, portId }) => [id, portId]),
      [
        ['old', 'new'],
        ['renamed', 'old'],
      ],
    );
  }
  assert.deepEqual(reconcileSubgraphTargetBoundary(next, actual), next);
  assert.deepEqual(buildGraphBoundaryInputData(next, {}, { old: { type: 'string', value: 'original default' } }), {
    old: { type: 'string', value: 'original default' },
  });
});

test('fallback port IDs cannot collide with a surviving port alias', () => {
  const next = reconcileSubgraphTargetBoundary(
    boundary(port('old', 'survivor')),
    boundary(port('old', 'old'), port('renamed', 'survivor')),
  );
  assert.deepEqual(
    next.inputs.map(({ portId }) => portId),
    ['old:2', 'old'],
  );
  assert.deepEqual(
    next.outputs.map(({ portId }) => portId),
    ['old:2', 'old'],
  );
});

test('legacy snapshots and callers without snapshots use available current identities', () => {
  const actual = boundary(port('renamed', 'node'));
  const legacy: GraphBoundary = {
    inputs: [{ id: 'old', portId: 'old' as PortId, dataType: 'string' }],
    outputs: [],
  };
  assert.deepEqual(reconcileSubgraphTargetBoundary(legacy, actual), actual);
  assert.equal(reconcileSubgraphTargetBoundary(undefined, actual), actual);
});
