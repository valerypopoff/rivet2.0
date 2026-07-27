import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import { getPassthroughDataBusConversionError } from './dataBusConversion.js';

const passthrough: ChartNode<'passthrough'> = {
  id: 'passthrough' as NodeId,
  type: 'passthrough',
  title: 'Passthrough',
  data: {},
  visualData: { x: 0, y: 0 },
};

function connection(overrides: Partial<NodeConnection>): NodeConnection {
  return {
    outputNodeId: 'source' as NodeId,
    outputId: 'output' as PortId,
    inputNodeId: passthrough.id,
    inputId: 'input1' as PortId,
    ...overrides,
  };
}

test('allows converting a Passthrough whose incident edges map to independent Data Bus channels', () => {
  assert.equal(
    getPassthroughDataBusConversionError(passthrough, [
      connection({ inputId: 'input1' as PortId }),
      connection({ outputNodeId: passthrough.id, outputId: 'output1' as PortId, inputNodeId: 'receiver' as NodeId }),
    ]),
    undefined,
  );
});

test('blocks converting a Passthrough when a Data Bus channel would have duplicate providers', () => {
  assert.match(
    getPassthroughDataBusConversionError(passthrough, [
      connection({ outputNodeId: 'first' as NodeId }),
      connection({ outputNodeId: 'second' as NodeId }),
    ]) ?? '',
    /input1.*2 providers/,
  );
});

test('blocks converting a Passthrough with noncanonical incident port IDs', () => {
  assert.match(
    getPassthroughDataBusConversionError(passthrough, [connection({ inputId: 'input01' as PortId })]) ?? '',
    /incoming port "input01"/,
  );
  assert.match(
    getPassthroughDataBusConversionError(passthrough, [
      connection({ outputNodeId: passthrough.id, outputId: 'output01' as PortId, inputNodeId: 'receiver' as NodeId }),
    ]) ?? '',
    /outgoing port "output01"/,
  );
});
