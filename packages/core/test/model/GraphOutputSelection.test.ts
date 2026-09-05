import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '../../src/model/NodeBase.js';
import { createGraphOutputSelection } from '../../src/model/GraphOutputSelection.js';

function node(id: string, type = 'text', data: unknown = {}): ChartNode {
  return { id: id as NodeId, type, title: id, data, visualData: { x: 0, y: 0, width: 200 } };
}

function connection(from: string, to: string, outputId = 'output', inputId = 'input'): NodeConnection {
  return {
    outputNodeId: from as NodeId,
    inputNodeId: to as NodeId,
    outputId: outputId as PortId,
    inputId: inputId as PortId,
  };
}

function select(nodes: ChartNode[], connections: NodeConnection[], outputIds: string[]) {
  return createGraphOutputSelection({ nodes, connections }, outputIds, (target) =>
    connections
      .filter((edge) => edge.inputNodeId === target.id)
      .map((edge) => nodes.find((source) => source.id === edge.outputNodeId)!),
  );
}

describe('Graph output selection', () => {
  it('selects all duplicate output producers and shared ancestors without their unrelated descendants', () => {
    const nodes = [
      node('shared'),
      node('left'),
      node('right'),
      node('unused'),
      node('first', 'graphOutput', { id: 'result' }),
      node('second', 'graphOutput', { id: 'result' }),
      node('other', 'graphOutput', { id: 'other' }),
    ];
    const connections = [
      connection('shared', 'left'),
      connection('shared', 'right'),
      connection('shared', 'unused'),
      connection('left', 'first'),
      connection('right', 'second'),
      connection('unused', 'other'),
    ];
    const selection = select(nodes, connections, ['result', 'result']);
    assert.deepEqual(
      selection.startNodes.map((entry) => entry.id),
      ['first', 'second'],
    );
    assert.deepEqual([...selection.nodeIds].sort(), ['first', 'left', 'right', 'second', 'shared']);
    assert.equal(nodes.length, 7);
    assert.equal(connections.length, 6);
  });

  it('retains feedback dependencies and every provider the scheduler waits for', () => {
    const selection = select(
      [node('a'), node('b'), node('otherProvider'), node('out', 'graphOutput', { id: 'result' })],
      [connection('a', 'b'), connection('b', 'a'), connection('otherProvider', 'b'), connection('b', 'out')],
      ['result'],
    );
    assert.deepEqual([...selection.nodeIds].sort(), ['a', 'b', 'otherProvider', 'out']);
  });

  it('treats empty selection as no work and rejects unknown output names', () => {
    const nodes = [node('out', 'graphOutput', { id: 'result' })];
    assert.equal(select(nodes, [], []).nodeIds.size, 0);
    assert.throws(() => select(nodes, [], ['missing']), /Unknown requested graph output IDs: "missing"/);
  });

  it('retains the selected LLM connected Delegate but not its unrelated output branches', () => {
    const nodes = [
      node('llm', 'llmChatV2', { useToolCalling: true, autoContinueToolCalls: true }),
      node('delegate', 'delegateFunctionCall'),
      node('unused'),
      node('out', 'graphOutput', { id: 'result' }),
    ];
    const connections = [
      connection('llm', 'delegate', 'function-calls', 'function-call'),
      connection('llm', 'out', 'response'),
      connection('delegate', 'unused'),
    ];
    assert.deepEqual([...select(nodes, connections, ['result']).nodeIds].sort(), ['delegate', 'llm', 'out']);
  });

  it('leaves ambiguity resolution to the selected LLM runtime rather than picking a Delegate', () => {
    const nodes = [
      node('llm', 'llmChatV2', { useToolCalling: true, autoContinueToolCalls: true }),
      node('first', 'delegateFunctionCall'),
      node('second', 'delegateFunctionCall'),
      node('out', 'graphOutput', { id: 'result' }),
    ];
    const connections = [
      connection('llm', 'first', 'function-calls', 'function-call'),
      connection('llm', 'second', 'function-calls', 'function-call'),
      connection('llm', 'out', 'response'),
    ];
    assert.deepEqual([...select(nodes, connections, ['result']).nodeIds].sort(), ['llm', 'out']);
  });
});
