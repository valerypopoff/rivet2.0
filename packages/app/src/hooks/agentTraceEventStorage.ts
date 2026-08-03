import { getAgentTraceEventIdentity, mergeAgentTraceEvent, type AgentTraceEvent } from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../state/dataFlow.js';

/**
 * Stores an observational trace event on its owning node invocation.
 * Identified redeliveries replace their earlier row without changing order;
 * anonymous tool events remain distinct because they cannot be matched safely.
 */
export function upsertAgentTraceEventForInvocation(runDataByNode: RunDataByNodeId, event: AgentTraceEvent): void {
  const execution = event.execution;
  const nodeId = event.type === 'llm-call-finished' ? event.nodeId : event.sourceNodeId;
  const processId = event.type === 'llm-call-finished' ? event.processId : event.sourceProcessId;
  const processes = (runDataByNode[nodeId] ??= []);
  let process = processes.find((candidate) => candidate.processId === processId);

  if (process == null) {
    process = {
      processId,
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      data: {},
    };
    processes.push(process);
  } else {
    process.graphId = execution.graphId;
    process.graphRunId = execution.graphRunId;
    process.rootRunId = execution.rootRunId;
  }

  const events = (process.data.agentTraceEvents ??= []);
  const identity = getAgentTraceEventIdentity(event);
  const existingIndex =
    identity == null ? -1 : events.findIndex((candidate) => getAgentTraceEventIdentity(candidate) === identity);

  if (existingIndex < 0) {
    events.push(event);
  } else {
    events[existingIndex] = mergeAgentTraceEvent(events[existingIndex]!, event);
  }
}
