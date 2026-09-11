import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import {
  getStreamingOutputWatchBranchNodeIds,
  getStreamingOutputWatchConnections,
} from './streamingOutputWatchWireState.js';

function node(id: string, type: ChartNode['type'], disabled = false): ChartNode {
  return {
    data: {},
    disabled,
    id: id as NodeId,
    title: id,
    type,
    visualData: { x: 0, y: 0 },
  };
}

function connection(inputId: string): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId: 'watch' as NodeId,
    outputId: 'response' as PortId,
    outputNodeId: 'llm' as NodeId,
  };
}

test('marks only the direct streaming input of an enabled Watch Streaming Output node', () => {
  const streamingConnection = connection('stream');
  const ordinaryConnection = connection('value');

  const states = getStreamingOutputWatchConnections({
    connections: [streamingConnection, ordinaryConnection],
    nodes: [node('llm', 'llmChatV2'), node('watch', 'watchStreamingOutput')],
  });

  assert.deepEqual(states, new Set([streamingConnection]));
});

test('leaves disabled and non-watch targets visually ordinary', () => {
  const streamingConnection = connection('stream');

  assert.equal(
    getStreamingOutputWatchConnections({
      connections: [streamingConnection],
      nodes: [node('llm', 'llmChatV2'), node('watch', 'watchStreamingOutput', true)],
    }).size,
    0,
  );
  assert.equal(
    getStreamingOutputWatchConnections({
      connections: [streamingConnection],
      nodes: [node('llm', 'llmChatV2'), node('watch', 'passthrough')],
    }).size,
    0,
  );
});

test('finds the Watch branch through Stop but not its ordinary downstream work', () => {
  const connections: NodeConnection[] = [
    connection('stream'),
    {
      inputId: 'input' as PortId,
      inputNodeId: 'transform' as NodeId,
      outputId: 'value' as PortId,
      outputNodeId: 'watch' as NodeId,
    },
    {
      inputId: 'value' as PortId,
      inputNodeId: 'stop' as NodeId,
      outputId: 'output' as PortId,
      outputNodeId: 'transform' as NodeId,
    },
    {
      inputId: 'input' as PortId,
      inputNodeId: 'after-stop' as NodeId,
      outputId: 'value' as PortId,
      outputNodeId: 'stop' as NodeId,
    },
  ];

  const branchNodeIds = getStreamingOutputWatchBranchNodeIds({
    connections,
    nodes: [
      node('llm', 'llmChatV2'),
      node('watch', 'watchStreamingOutput'),
      node('transform', 'passthrough'),
      node('stop', 'stopWatchingStreamingOutput'),
      node('after-stop', 'passthrough'),
    ],
  });

  assert.deepEqual(branchNodeIds, new Set(['transform' as NodeId, 'stop' as NodeId]));
});
