import {
  buildAgentResponseTrace,
  type AgentResponseTrace,
  type ChartNode,
  type GraphExecutionMetadata,
} from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode } from '../../state/dataFlow.js';

/** Builds the inspector model for one exact editor node invocation. */
export function buildLlmInvocationTrace(
  node: ChartNode,
  processData: ProcessDataForNode | undefined,
): AgentResponseTrace | undefined {
  if (node.type !== 'llmChatV2' || processData == null) return undefined;

  const { data, graphId, graphRunId, processId, rootRunId } = processData;
  if (graphId == null || graphRunId == null || rootRunId == null || data.agentTraceEvents == null) return undefined;

  const execution: GraphExecutionMetadata = { graphId, graphRunId, rootRunId };
  return buildAgentResponseTrace({
    scope: 'llm-invocation',
    execution,
    events: data.agentTraceEvents,
    nodeId: node.id,
    processId,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    status: toTraceStatus(data.status?.type),
  });
}

function toTraceStatus(status: string | undefined): AgentResponseTrace['status'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'ok':
      return 'completed';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'aborted';
    default:
      return 'unavailable';
  }
}
