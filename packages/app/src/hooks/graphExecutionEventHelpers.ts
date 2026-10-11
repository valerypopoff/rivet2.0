import {
  WarningsPort,
  type GraphId,
  type GraphRunId,
  type NodeId,
  type PortId,
  type RootRunId,
  type GraphExecutionMetadata,
} from '@valerypopoff/rivet2-core';
import { produce } from 'immer';
import type { GraphViewKey } from '../domain/graphEditing/navigationActions.js';
import type {
  GraphRunSelection,
  GraphRunRecord,
  ProjectExecutionSnapshot,
  ProcessDataForNode,
  RunDataByNodeId,
} from '../state/dataFlow.js';

export function startGraphRunHistory(
  history: ProjectExecutionSnapshot['graphRunHistoryByView'],
  graphViewKey: GraphViewKey,
  execution: GraphExecutionMetadata | undefined,
): ProjectExecutionSnapshot['graphRunHistoryByView'] {
  if (!execution) return history;
  return produce(history, (draft) => {
    draft[graphViewKey] ??= [];
    if (!draft[graphViewKey]!.some((run) => run.graphRunId === execution.graphRunId)) {
      draft[graphViewKey]!.push({
        executor: execution.executor,
        graphId: execution.graphId,
        graphRunId: execution.graphRunId,
        parentGraphRunId: execution.parentGraphRunId,
        rootRunId: execution.rootRunId,
        startedAt: Date.now(),
        status: 'running',
      });
    }
  });
}

export function finishGraphRunHistory(
  history: ProjectExecutionSnapshot['graphRunHistoryByView'],
  graphViewKey: GraphViewKey,
  graphRunId: GraphRunId | undefined,
  status: GraphRunRecord['status'],
): ProjectExecutionSnapshot['graphRunHistoryByView'] {
  if (!graphRunId) return history;
  return produce(history, (draft) => {
    const run = draft[graphViewKey]?.find((candidate) => candidate.graphRunId === graphRunId);
    if (run) {
      run.finishedAt = Date.now();
      run.status = status;
    }
  });
}

export function interruptRunningProcesses(lastRunData: RunDataByNodeId): RunDataByNodeId {
  return produce(lastRunData, (draft) => {
    for (const processes of Object.values(draft)) {
      for (const process of processes) {
        if (process.data.status?.type === 'running') process.data.status = { type: 'interrupted' };
      }
    }
  });
}

export const MISSING_DEBUGGER_TERMINAL_EVENT_WARNING =
  'Remote Debugger did not receive the terminal event for this node. The graph run completed successfully, so Rivet cleared the stale running state.';

export type MissingDebuggerTerminalEvent = {
  graphId?: GraphId;
  graphRunId?: GraphRunId;
  nodeId: NodeId;
  processId: ProcessDataForNode['processId'];
  rootRunId?: RootRunId;
};

export function removeRunningGraphEntry(runningGraphs: GraphId[], graphId: GraphId): GraphId[] {
  const nextRunningGraphs = [...runningGraphs];
  const graphIndex = nextRunningGraphs.indexOf(graphId);
  if (graphIndex !== -1) {
    nextRunningGraphs.splice(graphIndex, 1);
  }
  return nextRunningGraphs;
}

export function updateSelectedGraphRunForGraphStart(
  previousSelections: Record<GraphViewKey, GraphRunSelection>,
  graphViewKey: GraphViewKey,
): Record<GraphViewKey, GraphRunSelection> {
  const previousSelection = previousSelections[graphViewKey];
  if (previousSelection != null && previousSelection !== 'latest') {
    return previousSelections;
  }

  return {
    ...previousSelections,
    [graphViewKey]: 'latest',
  };
}

export function appendRootRunIdOnce(rootRunIds: RootRunId[], rootRunId: RootRunId): RootRunId[] {
  if (rootRunIds.includes(rootRunId)) {
    return rootRunIds;
  }

  return [...rootRunIds, rootRunId];
}

export function reconcileRunningProcessesAfterSuccessfulDone(
  lastRunData: RunDataByNodeId,
  options: { onMissingTerminalEvent?: (event: MissingDebuggerTerminalEvent) => void; rootRunId?: RootRunId } = {},
): RunDataByNodeId {
  let nextRunData = lastRunData;
  const finishedAt = Date.now();

  for (const [nodeId, processes] of Object.entries(lastRunData)) {
    let nextProcesses: ProcessDataForNode[] | undefined;

    for (let index = 0; index < processes.length; index++) {
      const process = processes[index]!;
      if (process.data.status?.type !== 'running' || !shouldReconcileProcess(process, options.rootRunId)) {
        continue;
      }

      nextProcesses ??= [...processes];
      options.onMissingTerminalEvent?.({
        graphId: process.graphId,
        graphRunId: process.graphRunId,
        nodeId: nodeId as NodeId,
        processId: process.processId,
        rootRunId: process.rootRunId,
      });
      nextProcesses[index] = markProcessFinishedAfterMissingTerminalEvent(process, finishedAt);
    }

    if (nextProcesses) {
      if (nextRunData === lastRunData) {
        nextRunData = { ...lastRunData };
      }
      nextRunData[nodeId as NodeId] = nextProcesses;
    }
  }

  return nextRunData;
}

function shouldReconcileProcess(process: ProcessDataForNode, rootRunId: RootRunId | undefined): boolean {
  return rootRunId == null || process.rootRunId === rootRunId;
}

function markProcessFinishedAfterMissingTerminalEvent(
  process: ProcessDataForNode,
  finishedAt: number,
): ProcessDataForNode {
  const warningPort = WarningsPort as PortId;
  const existingWarnings = process.data.outputData?.[warningPort];
  const warningValues =
    existingWarnings?.type === 'string[]' &&
    existingWarnings.storage === 'inline' &&
    Array.isArray(existingWarnings.value)
      ? existingWarnings.value
      : [];
  const nextWarnings = warningValues.includes(MISSING_DEBUGGER_TERMINAL_EVENT_WARNING)
    ? warningValues
    : [...warningValues, MISSING_DEBUGGER_TERMINAL_EVENT_WARNING];

  return {
    ...process,
    data: {
      ...process.data,
      finishedAt: process.data.finishedAt ?? finishedAt,
      outputData: {
        ...process.data.outputData,
        [warningPort]: {
          type: 'string[]',
          storage: 'inline',
          value: nextWarnings,
        },
      },
      status: { type: 'ok' },
    },
  };
}
