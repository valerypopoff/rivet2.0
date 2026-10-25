import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProjectConnectionComparisonKey,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { clientToCanvasPosition } from '../../hooks/useCanvasPositioning.js';
import { getConnectionCacheKeys, getNodePortPosition } from './wireEndpoints.js';
import {
  getRenderableWireCandidates,
  getWireViewportBounds,
  prepareWireVisibility,
} from './getRenderableWireCandidates.js';

const viewport = { left: 0, top: 0, right: 1000, bottom: 1000 };
function fixture(sx: number, sy: number, ex: number, ey: number, bendPoint?: { x: number; y: number }) {
  const nodes = ['source', 'target'].map(
    (id, i) =>
      ({
        id: id as NodeId,
        type: 'text',
        title: id,
        data: {},
        visualData: { x: (i ? ex : sx) - 100, y: (i ? ey : sy) - 100 },
      }) as ChartNode,
  );
  const connection: NodeConnection = {
    outputNodeId: nodes[0]!.id,
    inputNodeId: nodes[1]!.id,
    outputId: 'out' as PortId,
    inputId: 'in' as PortId,
    ...(bendPoint ? { bendPoint } : {}),
  };
  return {
    connection,
    nodesById: Object.fromEntries(nodes.map((n) => [n.id, n])),
    positions: { 'source-output-out': { x: sx, y: sy }, 'target-input-in': { x: ex, y: ey } },
  };
}
function entries(f: ReturnType<typeof fixture>) {
  return prepareWireVisibility([f.connection], f.nodesById, f.positions);
}

void test('drawing and culling share endpoint keys and preserve measured, reference and unmeasured-port behavior', () => {
  const f = fixture(-3000, 400, 4000, 400);
  const keys = getConnectionCacheKeys(f.connection);
  assert.deepEqual(keys, ['source-output-out', 'target-input-in']);
  assert.equal(getConnectionCacheKeys(f.connection), keys);
  const source = f.nodesById[f.connection.outputNodeId]!;
  const port = f.connection.outputId;
  const positions = { ...f.positions, ['reference:' + keys[0]]: { x: 42, y: 99 } };
  assert.deepEqual(getNodePortPosition(source, port, keys[0], positions), { x: -3000, y: 400 });
  assert.deepEqual(getNodePortPosition(source, port, 'reference:' + keys[0], positions), { x: 42, y: 99 });
  assert.deepEqual(getNodePortPosition(source, port, keys[0], {}), { x: -3000, y: 400 });
  assert.deepEqual(getNodePortPosition(source, '' as PortId, keys[0], positions), { x: 0, y: 0 });
});

void test('visibility uses the complete route, not endpoint visibility or straight chords; truly remote routes remain culled', () => {
  for (const [name, f, visible] of [
    ['crossing with both nodes far outside', fixture(-3000, 400, 4000, 400), true],
    ['vertical crossing with both nodes far outside', fixture(400, -3000, 400, 4000), true],
    ['backwards curve bulging onto screen', fixture(-100, 100, -200, 900), true],
    ['backwards curve returning from the right edge', fixture(1200, 100, 1100, 900), true],
    ['bend crossing with both endpoints outside', fixture(-2000, 200, -2000, 800, { x: 500, y: 500 }), true],
    ['fully left', fixture(-3000, 400, -2000, 400), false],
    ['fully above', fixture(100, -3000, 900, -2000), false],
    ['inclusive boundary', fixture(-3000, 0, 4000, 0), true],
  ] as const) {
    assert.deepEqual(
      getRenderableWireCandidates({ entries: entries(f), viewportBounds: viewport }),
      visible ? [f.connection] : [],
      name,
    );
  }
});

void test('cached bounds follow measured ports, fallback positions and moved/bent nodes without mutating old entries', () => {
  const f = fixture(-3000, 400, 4000, 400);
  const initial = entries(f);
  assert.deepEqual(initial, prepareWireVisibility([f.connection], f.nodesById, {}));
  f.positions['source-output-out'].y = -2000;
  f.positions['target-input-in'].y = -2000;
  assert.deepEqual(getRenderableWireCandidates({ entries: entries(f), viewportBounds: viewport }), []);
  assert.deepEqual(getRenderableWireCandidates({ entries: initial, viewportBounds: viewport }), [f.connection]);
  const moved = { ...f.connection, bendPoint: { x: 500, y: 500 } };
  const changed = prepareWireVisibility([moved], f.nodesById, f.positions);
  assert.deepEqual(getRenderableWireCandidates({ entries: changed, viewportBounds: viewport }), [moved]);
});

void test('forced Data Bus/bend routes retain identity and order but cannot resurrect missing endpoints', () => {
  const f = fixture(-3000, -3000, -2000, -2000);
  const second = { ...f.connection, outputId: 'other' as PortId };
  const missing = { ...f.connection, inputNodeId: 'missing' as NodeId };
  const prepared = prepareWireVisibility([f.connection, missing, second], f.nodesById, f.positions);
  const force = new Set([f.connection, missing, second].map(getProjectConnectionComparisonKey));
  const result = getRenderableWireCandidates({
    entries: prepared,
    viewportBounds: viewport,
    forceRenderableConnectionKeySet: force,
  });
  assert.deepEqual(result, [f.connection, second]);
  assert.equal(result[0], f.connection);
  assert.equal(result[1], second);
});

void test('live viewport conversion keeps crossing wires at multiple zooms and nonzero canvas offsets, with bounded decoration padding', () => {
  const f = fixture(-10000, 500, 10000, 500);
  const prepared = entries(f);
  const rect = { left: 220, top: 130, right: 1400, bottom: 950 };
  for (const zoom of [0.2, 0.5, 1, 2, 4]) {
    const convert = clientToCanvasPosition({ x: 0, y: 300 / zoom - 500, zoom }, { x: 220, y: 130 });
    const bounds = getWireViewportBounds(rect, convert);
    assert.deepEqual(getRenderableWireCandidates({ entries: prepared, viewportBounds: bounds }), [f.connection]);
    const edge = convert(rect.left, rect.top);
    assert.equal(bounds.left, edge.x - 16 / zoom - 16);
    const remote = getWireViewportBounds(rect, clientToCanvasPosition({ x: 0, y: -10000, zoom }));
    assert.deepEqual(getRenderableWireCandidates({ entries: prepared, viewportBounds: remote }), []);
  }
});
