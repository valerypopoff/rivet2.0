import type { ChartNode, NodeConnection, NodeId, PortId } from '../NodeBase.js';
import type { NodeGraph } from '../NodeGraph.js';
import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';

export const LLM_CHAT_V2_TOOL_CALLS_OUTPUT_ID = 'function-calls' as PortId;
export const DELEGATE_TOOL_CALL_INPUT_ID = 'function-call' as PortId;

type ContinuationGraph = Pick<NodeGraph, 'connections' | 'nodes'>;

export type ToolContinuationConnectionCandidate = {
  connection: NodeConnection;
  delegateNode: ChartNode<'delegateFunctionCall'>;
};

export type ToolContinuationConnectionResolution =
  | {
      kind: 'none';
    }
  | ({ kind: 'connected' } & ToolContinuationConnectionCandidate)
  | {
      kind: 'ambiguous';
      candidates: ToolContinuationConnectionCandidate[];
    };

/**
 * Resolves every special request/response relationship formed by an
 * auto-continuing LLM Chat node and an effective Delegate Tool Call input.
 * Callers that inspect a whole graph should reuse this single pass.
 */
export function resolveToolContinuationConnections(
  graph: ContinuationGraph,
): ReadonlyMap<NodeId, Exclude<ToolContinuationConnectionResolution, { kind: 'none' }>> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const firstConnectionByInput = new Map<string, NodeConnection>();

  for (const connection of graph.connections) {
    if (!nodesById.has(connection.outputNodeId) || !nodesById.has(connection.inputNodeId)) {
      continue;
    }

    const inputKey = `${connection.inputNodeId}\u0000${connection.inputId}`;
    if (!firstConnectionByInput.has(inputKey)) {
      firstConnectionByInput.set(inputKey, connection);
    }
  }

  const candidatesByLLMNodeId = new Map<NodeId, ToolContinuationConnectionCandidate[]>();
  for (const connection of graph.connections) {
    if (
      connection.outputId !== LLM_CHAT_V2_TOOL_CALLS_OUTPUT_ID ||
      connection.inputId !== DELEGATE_TOOL_CALL_INPUT_ID
    ) {
      continue;
    }

    const llmNode = nodesById.get(connection.outputNodeId);
    const delegateNode = nodesById.get(connection.inputNodeId);
    if (!isEligibleLLMChatV2Node(llmNode) || !isEligibleDelegateToolCallNode(delegateNode)) {
      continue;
    }

    const inputKey = `${connection.inputNodeId}\u0000${connection.inputId}`;
    if (firstConnectionByInput.get(inputKey) !== connection) {
      continue;
    }

    const candidates = candidatesByLLMNodeId.get(llmNode.id);
    const candidate = { connection, delegateNode };
    if (candidates) {
      candidates.push(candidate);
    } else {
      candidatesByLLMNodeId.set(llmNode.id, [candidate]);
    }
  }

  const resolutions = new Map<NodeId, Exclude<ToolContinuationConnectionResolution, { kind: 'none' }>>();
  for (const [llmNodeId, candidates] of candidatesByLLMNodeId) {
    if (candidates.length === 1) {
      resolutions.set(llmNodeId, { kind: 'connected', ...candidates[0]! });
    } else {
      resolutions.set(llmNodeId, { kind: 'ambiguous', candidates });
    }
  }

  return resolutions;
}

/** Resolves one LLM node while preserving the convenient `none` result. */
export function resolveToolContinuationConnection(
  graph: ContinuationGraph,
  llmNodeId: NodeId,
): ToolContinuationConnectionResolution {
  return resolveToolContinuationConnections(graph).get(llmNodeId) ?? { kind: 'none' };
}

function isEligibleLLMChatV2Node(node: ChartNode | undefined): node is ChartNode<'llmChatV2', LLMChatV2NodeData> {
  if (!node || node.disabled || node.isSplitRun || node.type !== 'llmChatV2') {
    return false;
  }

  const data = node.data as LLMChatV2NodeData;
  return data.useToolCalling === true && data.autoContinueToolCalls === true;
}

function isEligibleDelegateToolCallNode(node: ChartNode | undefined): node is ChartNode<'delegateFunctionCall'> {
  return node?.type === 'delegateFunctionCall' && !node.disabled;
}
