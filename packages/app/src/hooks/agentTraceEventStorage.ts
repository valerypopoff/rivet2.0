import { getAgentTraceEventIdentity, mergeAgentTraceEvent, type AgentTraceEvent } from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../state/dataFlow.js';
import { updateNodeRunData } from './executionDataTransitions.js';

/**
 * Stores an observational trace event on its owning node invocation.
 * Identified redeliveries replace their earlier row without changing order;
 * anonymous tool events remain distinct because they cannot be matched safely.
 * Invocation creation and payload retention use the same transition as node
 * events, even when a diagnostic arrives before nodeStart.
 */
export function updateAgentTraceEventForInvocation(
  runDataByNode: RunDataByNodeId,
  event: AgentTraceEvent,
  previousDataPerNodeToKeep?: number,
) {
  const execution = event.execution;
  const nodeId = event.type === 'tool-call-finished' ? event.sourceNodeId : event.nodeId;
  const processId = event.type === 'tool-call-finished' ? event.sourceProcessId : event.processId;
  const process = runDataByNode[nodeId]?.find((candidate) => candidate.processId === processId);
  const events = [...(process?.data.agentTraceEvents ?? [])];
  const identity = getAgentTraceEventIdentity(event);
  const existingIndex =
    identity == null ? -1 : events.findIndex((candidate) => getAgentTraceEventIdentity(candidate) === identity);

  if (existingIndex < 0) {
    events.push(event);
  } else {
    events[existingIndex] = mergeAgentTraceEvent(events[existingIndex]!, event);
  }
  return {
    nodeId,
    ...updateNodeRunData(runDataByNode, {
      nodeId,
      processId,
      execution,
      data: { agentTraceEvents: events },
      previousDataPerNodeToKeep,
    }),
  };
}
