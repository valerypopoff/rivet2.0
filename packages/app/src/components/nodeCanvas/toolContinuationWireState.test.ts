import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveNodePrefabInstance,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodePrefabId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { getToolContinuationWireStates } from './toolContinuationWireState.js';

function node(id: string, type: string, data: Record<string, unknown> = {}): ChartNode {
  return {
    id: id as NodeId,
    type,
    title: id,
    data,
    visualData: { x: 0, y: 0 },
  };
}

function connection(outputNodeId: string, inputNodeId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    inputNodeId: inputNodeId as NodeId,
    outputId: 'function-calls' as PortId,
    inputId: 'function-call' as PortId,
  };
}

const enabledLLMData = { useToolCalling: true, autoContinueToolCalls: true };

function projectWithPrefab(prefabId: NodePrefabId, sourceNode: ChartNode): Project {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: {},
    plugins: [],
    nodePrefabs: {
      [prefabId]: { id: prefabId, sourceNode },
    },
  };
}

function linkedNode(id: string, prefabId: NodePrefabId): ChartNode {
  return node(id, 'nodePrefabInstance', { prefabId });
}

test('getToolContinuationWireStates marks a unique edge as connected', () => {
  const llm = node('llm', 'llmChatV2', enabledLLMData);
  const delegate = node('delegate', 'delegateFunctionCall');
  const edge = connection('llm', 'delegate');

  const states = getToolContinuationWireStates({ nodes: [llm, delegate], connections: [edge] });

  assert.deepEqual(states.get(edge), { kind: 'connected', delegateNodeId: delegate.id });
});

test('getToolContinuationWireStates marks every competing edge as ambiguous', () => {
  const llm = node('llm', 'llmChatV2', enabledLLMData);
  const delegateA = node('delegate-a', 'delegateFunctionCall');
  const delegateB = node('delegate-b', 'delegateFunctionCall');
  const edgeA = connection('llm', 'delegate-a');
  const edgeB = connection('llm', 'delegate-b');

  const states = getToolContinuationWireStates({
    nodes: [llm, delegateA, delegateB],
    connections: [edgeA, edgeB],
  });

  assert.deepEqual(states.get(edgeA), { kind: 'ambiguous', delegateNodeId: delegateA.id });
  assert.deepEqual(states.get(edgeB), { kind: 'ambiguous', delegateNodeId: delegateB.id });
});

test('getToolContinuationWireStates leaves ordinary tool-call edges unchanged', () => {
  const llm = node('llm', 'llmChatV2', { useToolCalling: true, autoContinueToolCalls: false });
  const delegate = node('delegate', 'delegateFunctionCall');
  const edge = connection('llm', 'delegate');

  const states = getToolContinuationWireStates({ nodes: [llm, delegate], connections: [edge] });

  assert.equal(states.size, 0);
});

test('getToolContinuationWireStates only marks the first edge into a Delegate input', () => {
  const llmA = node('llm-a', 'llmChatV2', enabledLLMData);
  const llmB = node('llm-b', 'llmChatV2', enabledLLMData);
  const delegate = node('delegate', 'delegateFunctionCall');
  const edgeA = connection('llm-a', 'delegate');
  const edgeB = connection('llm-b', 'delegate');

  const states = getToolContinuationWireStates({
    nodes: [llmA, llmB, delegate],
    connections: [edgeA, edgeB],
  });

  assert.deepEqual(states.get(edgeA), { kind: 'connected', delegateNodeId: delegate.id });
  assert.equal(states.has(edgeB), false);
});

test('getToolContinuationWireStates recognizes an effective linked LLM endpoint', () => {
  const prefabId = 'linked-llm-prefab' as NodePrefabId;
  const linkedLLM = linkedNode('linked-llm', prefabId);
  const sourceLLM = node('source-llm', 'llmChatV2', enabledLLMData);
  const delegate = node('delegate', 'delegateFunctionCall');
  const edge = connection(linkedLLM.id, delegate.id);
  const project = projectWithPrefab(prefabId, sourceLLM);
  const effectiveLLM = resolveNodePrefabInstance(project, linkedLLM);

  const states = getToolContinuationWireStates({ nodes: [effectiveLLM, delegate], connections: [edge] });

  assert.deepEqual(states.get(edge), { kind: 'connected', delegateNodeId: delegate.id });
});

test('getToolContinuationWireStates recognizes an effective linked Delegate endpoint', () => {
  const prefabId = 'linked-delegate-prefab' as NodePrefabId;
  const llm = node('llm', 'llmChatV2', enabledLLMData);
  const linkedDelegate = linkedNode('linked-delegate', prefabId);
  const sourceDelegate = node('source-delegate', 'delegateFunctionCall');
  const edge = connection(llm.id, linkedDelegate.id);
  const project = projectWithPrefab(prefabId, sourceDelegate);
  const effectiveDelegate = resolveNodePrefabInstance(project, linkedDelegate);

  const states = getToolContinuationWireStates({ nodes: [llm, effectiveDelegate], connections: [edge] });

  assert.deepEqual(states.get(edge), { kind: 'connected', delegateNodeId: linkedDelegate.id });
});
