import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';
import { getStoredValueOptions } from './storedValueOptions.js';

function graph(id: string, nodes: ChartNode[]): NodeGraph {
  return { connections: [], metadata: { id: id as GraphId, name: id }, nodes };
}

function setNode(key: string, useKeyInput = false, disabled = false): ChartNode {
  return {
    type: 'setStoredValue',
    title: 'Set Stored Value',
    id: `${key}-${useKeyInput}` as NodeId,
    disabled,
    visualData: { x: 0, y: 0 },
    data: { dataType: 'string', key, useKeyInput },
  } as ChartNode;
}

test('getStoredValueOptions finds sorted, unique enabled static keys and prefers the live graph', () => {
  const options = getStoredValueOptions(
    {
      graphs: {
        main: graph('main', [setNode('saved'), setNode('dynamic', true), setNode('disabled', false, true)]),
        other: graph('other', [setNode('zeta'), setNode('alpha'), setNode('alpha')]),
      } as never,
    },
    graph('main', [setNode('live')]),
  );

  assert.deepEqual(options, [
    { label: 'alpha', value: 'alpha' },
    { label: 'live', value: 'live' },
    { label: 'zeta', value: 'zeta' },
  ]);
});
