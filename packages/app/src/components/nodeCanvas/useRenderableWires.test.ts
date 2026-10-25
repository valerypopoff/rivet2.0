import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  getProjectConnectionComparisonKey,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { useRenderableWires } from './useRenderableWires.js';
import type { PortPositions } from './wireEndpoints.js';

void test('the real wire hook reuses geometry through pan/zoom and invalidates for ports, nodes, connections and removal', async (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
  const nodes = [-3000, 4000].map(
    (x, i) =>
      ({
        id: (i ? 'target' : 'source') as NodeId,
        type: 'text',
        title: 'Fixture',
        data: { text: '' },
        visualData: { x: x - 100, y: 300 },
      }) as ChartNode,
  );
  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const connection: NodeConnection = {
    outputNodeId: nodes[0]!.id,
    outputId: 'out' as PortId,
    inputNodeId: nodes[1]!.id,
    inputId: 'in' as PortId,
  };
  let reads = 0;
  const measured = (y: number): PortPositions =>
    Object.defineProperties(
      {},
      {
        'source-output-out': {
          enumerable: true,
          get() {
            reads++;
            return { x: -3000, y };
          },
        },
        'target-input-in': {
          enumerable: true,
          get() {
            reads++;
            return { x: 4000, y };
          },
        },
      },
    );
  type Props = Parameters<typeof useRenderableWires>[0];
  const convert = (x: number, y: number) => ({ x, y });
  let props: Props = {
    connections: [connection],
    nodesById,
    portPositions: measured(400),
    clientToCanvasPosition: convert,
    viewportClientRect: { left: 0, top: 0, right: 1000, bottom: 1000 },
  };
  let rendered: NodeConnection[] = [];
  function Probe(next: Props) {
    rendered = useRenderableWires(next);
    return null;
  }
  const render = async (updates: Partial<Props> = {}) => {
    props = { ...props, ...updates };
    await act(async () => root.render(createElement(Probe, props)));
  };
  await render();
  const originalList = rendered;
  const initialReads = reads;
  assert.ok(initialReads > 0);
  assert.deepEqual(rendered, [connection]);
  await render({ viewportClientRect: { left: 20, top: 10, right: 1020, bottom: 1010 } });
  assert.equal(rendered, originalList);
  await render({ clientToCanvasPosition: (x, y) => ({ x: x / 2, y: y / 2 }) });
  assert.equal(rendered, originalList);
  await render({ clientToCanvasPosition: (x, y) => ({ x, y: y - 10000 }) });
  assert.deepEqual(rendered, []);
  await render({ clientToCanvasPosition: convert });
  assert.deepEqual(rendered, [connection]);
  assert.equal(reads, initialReads, 'Camera changes must not reread endpoints or rebuild route bounds');
  await render({ portPositions: measured(-2000) });
  assert.deepEqual(rendered, []);
  assert.ok(reads > initialReads);
  await render({ portPositions: {} });
  assert.deepEqual(rendered, [connection], 'Unmeasured ports use the drawing fallback');
  const moved = Object.fromEntries(
    nodes.map((node) => [node.id, { ...node, visualData: { ...node.visualData, y: -3100 } }]),
  );
  await render({ nodesById: moved });
  assert.deepEqual(rendered, []);
  const bent = { ...connection, bendPoint: { x: 500, y: 500 } };
  await render({ connections: [bent] });
  assert.deepEqual(rendered, [bent]);
  await render({
    nodesById: { [nodes[0]!.id]: nodes[0]! },
    forceRenderableConnectionKeySet: new Set([getProjectConnectionComparisonKey(bent)]),
  });
  assert.deepEqual(rendered, [], 'Forced visibility must not resurrect missing nodes');
});
