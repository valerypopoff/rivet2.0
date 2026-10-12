import {
  buildAgentResponseTrace,
  type AgentResponseTrace,
  type ChartNode,
  type GraphExecutionMetadata,
} from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode } from '../../state/dataFlow.js';

/** Builds the inspector model for one exact editor node invocation. */
export function buildModelInvocationTrace(
  node: ChartNode,
  processData: ProcessDataForNode | undefined,
): AgentResponseTrace | undefined {
  if (!hasModelResponseInspector(node) || processData == null) return undefined;

  const { data, graphId, graphRunId, processId, rootRunId } = processData;
  if (graphId == null || graphRunId == null || rootRunId == null || data.agentTraceEvents == null) return undefined;

  const timing = data.recordedTiming;
  const execution: GraphExecutionMetadata = { graphId, graphRunId, rootRunId };
  return buildAgentResponseTrace({
    scope: node.type === 'classifierEvaluate' ? 'classifier-invocation' : 'llm-invocation',
    execution,
    events: data.agentTraceEvents,
    nodeId: node.id,
    processId,
    ...(timing == null ? {} : { invocationDurationMs: data.durationMs }),
    startedAt: timing == null ? data.startedAt : timing.startedAt,
    finishedAt: timing == null ? data.finishedAt : timing.finishedAt,
    status: toTraceStatus(data.status?.type),
  });
}

export function hasModelResponseInspector(node: ChartNode): boolean {
  return node.type === 'llmChatV2' || node.type === 'classifierEvaluate';
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
