import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '../../../src/model/NodeBase.js';
import type { NodeGraph } from '../../../src/model/NodeGraph.js';
import {
  resolveToolContinuationConnection,
  resolveToolContinuationConnections,
} from '../../../src/model/chat-v2/toolContinuationConnection.js';

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  options: { disabled?: boolean } = {},
): ChartNode {
  return {
    id: id as NodeId,
    type,
    title: id,
    data,
    disabled: options.disabled,
    visualData: { x: 0, y: 0 },
  };
}

function connection(
  outputNodeId: string,
  inputNodeId: string,
  outputId = 'function-calls',
  inputId = 'function-call',
): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    inputNodeId: inputNodeId as NodeId,
    outputId: outputId as PortId,
    inputId: inputId as PortId,
  };
}

function graph(nodes: ChartNode[], connections: NodeConnection[]): Pick<NodeGraph, 'connections' | 'nodes'> {
  return { nodes, connections };
}

const enabledLLMData = { useToolCalling: true, autoContinueToolCalls: true };

describe('resolveToolContinuationConnection', () => {
  it('upgrades exactly one eligible LLM-to-Delegate edge', () => {
    const llm = node('llm', 'llmChatV2', enabledLLMData);
    const delegate = node('delegate', 'delegateFunctionCall');
    const edge = connection('llm', 'delegate');

    const resolution = resolveToolContinuationConnection(graph([llm, delegate], [edge]), llm.id);

    assert.equal(resolution.kind, 'connected');
    if (resolution.kind === 'connected') {
      assert.equal(resolution.connection, edge);
      assert.equal(resolution.delegateNode, delegate);
    }
  });

  it('reports every eligible edge when an LLM has an ambiguous continuation', () => {
    const llm = node('llm', 'llmChatV2', enabledLLMData);
    const delegateA = node('delegate-a', 'delegateFunctionCall');
    const delegateB = node('delegate-b', 'delegateFunctionCall');
    const edgeA = connection('llm', 'delegate-a');
    const edgeB = connection('llm', 'delegate-b');

    const resolution = resolveToolContinuationConnection(graph([llm, delegateA, delegateB], [edgeA, edgeB]), llm.id);

    assert.equal(resolution.kind, 'ambiguous');
    if (resolution.kind === 'ambiguous') {
      assert.deepEqual(resolution.candidates, [
        { connection: edgeA, delegateNode: delegateA },
        { connection: edgeB, delegateNode: delegateB },
      ]);
    }
  });

  it('resolves a whole graph into candidate-bearing entries keyed by eligible LLM id', () => {
    const llmA = node('llm-a', 'llmChatV2', enabledLLMData);
    const llmB = node('llm-b', 'llmChatV2', enabledLLMData);
    const disabledLLM = node('disabled-llm', 'llmChatV2', enabledLLMData, { disabled: true });
    const delegateA = node('delegate-a', 'delegateFunctionCall');
    const delegateB = node('delegate-b', 'delegateFunctionCall');
    const delegateC = node('delegate-c', 'delegateFunctionCall');
    const edgeA = connection('llm-a', 'delegate-a');
    const edgeB = connection('llm-b', 'delegate-b');
    const edgeC = connection('llm-b', 'delegate-c');
    const disabledEdge = connection('disabled-llm', 'delegate-c');

    const resolutions = resolveToolContinuationConnections(
      graph([llmA, llmB, disabledLLM, delegateA, delegateB, delegateC], [edgeA, edgeB, edgeC, disabledEdge]),
    );

    assert.deepEqual([...resolutions.keys()], [llmA.id, llmB.id]);
    assert.deepEqual(resolutions.get(llmA.id), {
      kind: 'connected',
      connection: edgeA,
      delegateNode: delegateA,
    });
    assert.deepEqual(resolutions.get(llmB.id), {
      kind: 'ambiguous',
      candidates: [
        { connection: edgeB, delegateNode: delegateB },
        { connection: edgeC, delegateNode: delegateC },
      ],
    });
  });

  it('does not upgrade disabled nodes, disabled settings, or different ports', () => {
    const enabledLLM = node('enabled-llm', 'llmChatV2', enabledLLMData);
    const disabledLLM = node('disabled-llm', 'llmChatV2', enabledLLMData, { disabled: true });
    const noToolsLLM = node('no-tools-llm', 'llmChatV2', {
      useToolCalling: false,
      autoContinueToolCalls: true,
    });
    const noContinuationLLM = node('no-continuation-llm', 'llmChatV2', {
      useToolCalling: true,
      autoContinueToolCalls: false,
    });
    const delegate = node('delegate', 'delegateFunctionCall');
    const disabledDelegate = node('disabled-delegate', 'delegateFunctionCall', {}, { disabled: true });
    const nodes = [enabledLLM, disabledLLM, noToolsLLM, noContinuationLLM, delegate, disabledDelegate];
    const connections = [
      connection('disabled-llm', 'delegate'),
      connection('no-tools-llm', 'delegate'),
      connection('no-continuation-llm', 'delegate'),
      connection('enabled-llm', 'disabled-delegate'),
      connection('enabled-llm', 'delegate', 'response'),
      connection('enabled-llm', 'delegate', 'function-calls', 'other-input'),
    ];

    for (const llm of [enabledLLM, disabledLLM, noToolsLLM, noContinuationLLM]) {
      assert.deepEqual(resolveToolContinuationConnection(graph(nodes, connections), llm.id), { kind: 'none' });
    }
  });

  it('ignores missing targets and non-Delegate targets', () => {
    const llm = node('llm', 'llmChatV2', enabledLLMData);
    const text = node('text', 'text');

    assert.deepEqual(
      resolveToolContinuationConnection(
        graph([llm, text], [connection('llm', 'missing'), connection('llm', 'text')]),
        llm.id,
      ),
      { kind: 'none' },
    );
  });

  it('only upgrades the first connected value for a Delegate tool-call input', () => {
    const llmA = node('llm-a', 'llmChatV2', enabledLLMData);
    const llmB = node('llm-b', 'llmChatV2', enabledLLMData);
    const delegate = node('delegate', 'delegateFunctionCall');
    const firstEdge = connection('llm-a', 'delegate');
    const ignoredEdge = connection('llm-b', 'delegate');
    const currentGraph = graph([llmA, llmB, delegate], [firstEdge, ignoredEdge]);

    assert.equal(resolveToolContinuationConnection(currentGraph, llmA.id).kind, 'connected');
    assert.deepEqual(resolveToolContinuationConnection(currentGraph, llmB.id), { kind: 'none' });
  });

  it('ignores missing upstream nodes when choosing the first Delegate input', () => {
    const llm = node('llm', 'llmChatV2', enabledLLMData);
    const delegate = node('delegate', 'delegateFunctionCall');
    const missingEdge = connection('missing', 'delegate');
    const liveEdge = connection('llm', 'delegate');

    assert.equal(
      resolveToolContinuationConnection(graph([llm, delegate], [missingEdge, liveEdge]), llm.id).kind,
      'connected',
    );
  });

  it('does not upgrade a split-run LLM Chat connection', () => {
    const llm = {
      ...node('llm', 'llmChatV2', enabledLLMData),
      isSplitRun: true,
    };
    const delegate = node('delegate', 'delegateFunctionCall');

    assert.deepEqual(
      resolveToolContinuationConnection(graph([llm, delegate], [connection('llm', 'delegate')]), llm.id),
      { kind: 'none' },
    );
  });
});
