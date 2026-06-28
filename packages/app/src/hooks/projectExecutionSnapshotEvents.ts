import { produce } from 'immer';
import {
  type GraphRunId,
  type ProcessEventMessageMap,
  type ProcessEvents,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  createEmptyProjectExecutionSnapshot,
  type GraphRunRecord,
  type NodeRunData,
  type NodeRunDataWithRefs,
  type ProcessDataForNode,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { buildGraphViewKeyFromExecution } from '../utils/executionIdentity.js';
import { sanitizeInputsOrOutputs } from '../utils/executionDataSanitization.js';
import {
  clearExecutionDataRefs,
  collectStoredRefIds,
  deleteStoredRefIds,
  storeInputsOrOutputsForHistory,
  storeNodeDataForHistory,
} from '../utils/executionDataStorage.js';
import {
  reconcileRunningProcessesAfterSuccessfulDone,
  removeRunningGraphEntry,
  updateSelectedGraphRunForGraphStart,
} from './graphExecutionEventHelpers.js';
import {
  collectReplacedRefIds,
  mergeNodeRunDataForProcess,
  prepareNodeRunDataForStorage,
} from './useExecutionDataFlow.js';

export type ProjectExecutionSnapshotEventResult = {
  changed: boolean;
  snapshot: ProjectExecutionSnapshot;
};

export function applyProcessEventToProjectExecutionSnapshot<K extends keyof ProcessEventMessageMap>(options: {
  data: ProcessEventMessageMap[K];
  message: K;
  projectId: ProjectId;
  refStore: DataRefStore;
  snapshot: ProjectExecutionSnapshot | undefined;
}): ProjectExecutionSnapshotEventResult {
  const snapshot = options.snapshot ?? createEmptyProjectExecutionSnapshot();

  switch (options.message) {
    case 'start':
      return {
        changed: true,
        snapshot: applyStart(snapshot, options.data as ProcessEvents['start'], options.refStore),
      };
    case 'nodeStart':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeStart'],
          {
            inputData: sanitizeInputsOrOutputs((options.data as ProcessEvents['nodeStart']).inputs),
            startedAt: Date.now(),
            status: { type: 'running' },
          },
          options,
        ),
      };
    case 'nodeFinish':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeFinish'],
          {
            durationMs: (options.data as ProcessEvents['nodeFinish']).durationMs,
            finishedAt: Date.now(),
            outputData: sanitizeInputsOrOutputs((options.data as ProcessEvents['nodeFinish']).outputs),
            splitRunDurationMs: (options.data as ProcessEvents['nodeFinish']).splitRunDurationMs,
            status: { type: 'ok' },
          },
          options,
        ),
      };
    case 'nodeError':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeError'],
          {
            durationMs: (options.data as ProcessEvents['nodeError']).durationMs,
            finishedAt: Date.now(),
            splitRunDurationMs: (options.data as ProcessEvents['nodeError']).splitRunDurationMs,
            status: {
              type: 'error',
              error:
                typeof (options.data as ProcessEvents['nodeError']).error === 'string'
                  ? ((options.data as ProcessEvents['nodeError']).error as string)
                  : (options.data as ProcessEvents['nodeError']).error.toString(),
            },
          },
          options,
        ),
      };
    case 'nodeExcluded':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeExcluded'],
          {
            finishedAt: Date.now(),
            inputData: sanitizeInputsOrOutputs((options.data as ProcessEvents['nodeExcluded']).inputs),
            outputData: sanitizeInputsOrOutputs((options.data as ProcessEvents['nodeExcluded']).outputs),
            startedAt: Date.now(),
            status: { type: 'notRan', reason: (options.data as ProcessEvents['nodeExcluded']).reason },
          },
          options,
        ),
      };
    case 'partialOutput':
      return {
        changed: true,
        snapshot: applyPartialOutput(snapshot, options.data as ProcessEvents['partialOutput'], options),
      };
    case 'nodeOutputsCleared':
      return {
        changed: true,
        snapshot: applyNodeOutputsCleared(snapshot, options.data as ProcessEvents['nodeOutputsCleared'], options.refStore),
      };
    case 'userInput':
      return {
        changed: true,
        snapshot: applyUserInput(snapshot, options.data as ProcessEvents['userInput']),
      };
    case 'graphStart':
      return {
        changed: true,
        snapshot: applyGraphStart(snapshot, options.data as ProcessEvents['graphStart']),
      };
    case 'graphFinish':
      return {
        changed: true,
        snapshot: applyGraphFinish(snapshot, options.data as ProcessEvents['graphFinish'], 'ok'),
      };
    case 'graphAbort':
      return {
        changed: true,
        snapshot: applyGraphFinish(snapshot, options.data as ProcessEvents['graphAbort'], 'aborted'),
      };
    case 'graphError':
      return {
        changed: true,
        snapshot: applyGraphFinish(snapshot, options.data as ProcessEvents['graphError'], 'error'),
      };
    case 'done':
      return {
        changed: true,
        snapshot: applyDone(snapshot),
      };
    case 'abort':
      return {
        changed: true,
        snapshot: applyAbort(snapshot),
      };
    case 'pause':
      return {
        changed: true,
        snapshot: { ...snapshot, graphPaused: true },
      };
    case 'resume':
      return {
        changed: true,
        snapshot: { ...snapshot, graphPaused: false },
      };
    case 'error':
      return {
        changed: true,
        snapshot: applyAbort(snapshot),
      };
    default:
      return {
        changed: false,
        snapshot,
      };
  }
}

function applyStart(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['start'],
  refStore: DataRefStore,
): ProjectExecutionSnapshot {
  clearExecutionDataRefs(refStore, snapshot.lastRunDataByNode);

  return {
    ...createEmptyProjectExecutionSnapshot(),
    frozenNodeOutputs: snapshot.frozenNodeOutputs ?? {},
    graphRunning: true,
    graphStartTime: Date.now(),
    rootGraph: data.startGraph.metadata!.id!,
  };
}

function applyDone(snapshot: ProjectExecutionSnapshot): ProjectExecutionSnapshot {
  return {
    ...snapshot,
    graphPaused: false,
    graphRunning: false,
    lastRunDataByNode: reconcileRunningProcessesAfterSuccessfulDone(snapshot.lastRunDataByNode),
    runningGraphs: [],
    userInputQuestions: {},
  };
}

function applyAbort(snapshot: ProjectExecutionSnapshot): ProjectExecutionSnapshot {
  return {
    ...snapshot,
    graphPaused: false,
    graphRunning: false,
    lastRunDataByNode: interruptRunningProcesses(snapshot.lastRunDataByNode),
    runningGraphs: [],
    userInputQuestions: {},
  };
}

function applyUserInput(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['userInput'],
): ProjectExecutionSnapshot {
  return produce(snapshot, (draft) => {
    draft.userInputQuestions ??= {};
    draft.userInputQuestions[data.node.id] ??= [];
    draft.userInputQuestions[data.node.id]!.push({
      nodeId: data.node.id,
      processId: data.processId,
      questions: data.inputStrings,
    });
    draft.selectedProcessPageNodes[data.node.id] = 'latest';
  });
}

function applyGraphStart(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['graphStart'],
): ProjectExecutionSnapshot {
  const graphId = data.graph.metadata!.id!;
  const graphViewKey = buildGraphViewKeyFromExecution({
    execution: data.execution,
    graphIdFallback: graphId,
  });

  return produce(snapshot, (draft) => {
    draft.runningGraphs.push(graphId);
    draft.graphRunHistoryByView[graphViewKey] ??= [];

    const existing = draft.graphRunHistoryByView[graphViewKey]!.find(
      (graphRun) => graphRun.graphRunId === data.execution.graphRunId,
    );
    if (!existing) {
      draft.graphRunHistoryByView[graphViewKey]!.push({
        executor: data.execution.executor,
        graphId: data.execution.graphId,
        graphRunId: data.execution.graphRunId,
        parentGraphRunId: data.execution.parentGraphRunId,
        rootRunId: data.execution.rootRunId,
        startedAt: Date.now(),
        status: 'running',
      });
    }

    draft.selectedGraphRunByView = updateSelectedGraphRunForGraphStart(
      draft.selectedGraphRunByView,
      graphViewKey,
    );
  });
}

function applyGraphFinish(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['graphFinish'] | ProcessEvents['graphAbort'] | ProcessEvents['graphError'],
  status: GraphRunRecord['status'],
): ProjectExecutionSnapshot {
  const graphId = data.graph.metadata!.id!;
  const graphViewKey = buildGraphViewKeyFromExecution({
    execution: data.execution,
    graphIdFallback: graphId,
  });

  return produce(snapshot, (draft) => {
    draft.runningGraphs = removeRunningGraphEntry(draft.runningGraphs, graphId);
    finishGraphRun(draft, graphViewKey, data.execution.graphRunId, status);
  });
}

function setDataForNodeInSnapshot(
  snapshot: ProjectExecutionSnapshot,
  event: Pick<ProcessEvents['nodeStart'], 'execution' | 'node' | 'processId'>,
  data: Partial<NodeRunData>,
  options: { projectId: ProjectId; refStore: DataRefStore },
): ProjectExecutionSnapshot {
  const storedData = storeNodeDataForHistory(prepareNodeRunDataForStorage(data), options.refStore, {
    nodeId: event.node.id,
    processId: event.processId,
    projectId: options.projectId,
  });
  const refIdsToDelete: string[] = [];

  const nextSnapshot = produce(snapshot, (draft) => {
    draft.lastRunDataByNode[event.node.id] ??= [];

    const existingProcess = draft.lastRunDataByNode[event.node.id]!.find(
      (process) => process.processId === event.processId,
    );
    if (existingProcess) {
      existingProcess.graphId = event.execution?.graphId ?? existingProcess.graphId;
      existingProcess.graphRunId = event.execution?.graphRunId ?? existingProcess.graphRunId;
      existingProcess.rootRunId = event.execution?.rootRunId ?? existingProcess.rootRunId;
      const nextProcessData = mergeNodeRunDataForProcess(existingProcess.data, storedData);
      refIdsToDelete.push(...collectReplacedRefIds(existingProcess.data, nextProcessData));
      existingProcess.data = nextProcessData;
      return;
    }

    draft.lastRunDataByNode[event.node.id]!.push({
      data: storedData as NodeRunDataWithRefs,
      graphId: event.execution?.graphId,
      graphRunId: event.execution?.graphRunId,
      processId: event.processId,
      rootRunId: event.execution?.rootRunId,
    });
    draft.selectedProcessPageNodes[event.node.id] = 'latest';
  });

  deleteStoredRefIds(options.refStore, refIdsToDelete);
  return nextSnapshot;
}

function applyPartialOutput(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['partialOutput'],
  options: { projectId: ProjectId; refStore: DataRefStore },
): ProjectExecutionSnapshot {
  const sanitizedOutputs = sanitizeInputsOrOutputs(data.outputs);

  if (!data.node.isSplitRun) {
    return setDataForNodeInSnapshot(snapshot, data, { outputData: sanitizedOutputs }, options);
  }

  const storedOutputs = storeInputsOrOutputsForHistory(sanitizedOutputs, options.refStore, {
    channel: 'output',
    nodeId: data.node.id,
    processId: data.processId,
    projectId: options.projectId,
    splitIndex: data.index,
  });
  const refIdsToDelete: string[] = [];

  const nextSnapshot = produce(snapshot, (draft) => {
    draft.lastRunDataByNode[data.node.id] ??= [];

    const existingProcess = draft.lastRunDataByNode[data.node.id]!.find(
      (process) => process.processId === data.processId,
    );
    if (existingProcess) {
      existingProcess.graphId = data.execution.graphId;
      existingProcess.graphRunId = data.execution.graphRunId;
      existingProcess.rootRunId = data.execution.rootRunId;
      refIdsToDelete.push(...collectStoredRefIds(existingProcess.data.splitOutputData?.[data.index]));
      existingProcess.data.splitOutputData = {
        ...existingProcess.data.splitOutputData,
        [data.index]: storedOutputs!,
      };
    } else {
      draft.lastRunDataByNode[data.node.id]!.push({
        data: {
          splitOutputData: {
            [data.index]: storedOutputs!,
          },
        },
        graphId: data.execution.graphId,
        graphRunId: data.execution.graphRunId,
        processId: data.processId,
        rootRunId: data.execution.rootRunId,
      });
    }

    draft.selectedProcessPageNodes[data.node.id] = 'latest';
  });

  deleteStoredRefIds(options.refStore, refIdsToDelete);
  return nextSnapshot;
}

function applyNodeOutputsCleared(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['nodeOutputsCleared'],
  refStore: DataRefStore,
): ProjectExecutionSnapshot {
  const refIdsToDelete: string[] = [];

  const nextSnapshot = produce(snapshot, (draft) => {
    const nodeRuns = draft.lastRunDataByNode[data.node.id];
    if (!nodeRuns) {
      return;
    }

    if (data.processId) {
      const index = nodeRuns.findIndex((process) => process.processId === data.processId);
      if (index !== -1) {
        refIdsToDelete.push(...collectStoredRefIds(nodeRuns[index]!.data));
        nodeRuns.splice(index, 1);
      }
    } else {
      refIdsToDelete.push(...nodeRuns.flatMap((process) => collectStoredRefIds(process.data)));
      delete draft.lastRunDataByNode[data.node.id];
    }

    draft.selectedProcessPageNodes[data.node.id] = 'latest';
  });

  deleteStoredRefIds(refStore, refIdsToDelete);
  return nextSnapshot;
}

function finishGraphRun(
  snapshot: ProjectExecutionSnapshot,
  graphViewKey: string,
  graphRunId: GraphRunId | undefined,
  status: GraphRunRecord['status'],
): void {
  if (!graphRunId) {
    return;
  }

  const run = snapshot.graphRunHistoryByView[graphViewKey]?.find((graphRun) => graphRun.graphRunId === graphRunId);
  if (run) {
    run.finishedAt = Date.now();
    run.status = status;
  }
}

function interruptRunningProcesses(lastRunData: ProjectExecutionSnapshot['lastRunDataByNode']) {
  return produce(lastRunData, (draft) => {
    for (const processes of Object.values(draft) as ProcessDataForNode[][]) {
      for (const process of processes) {
        if (process.data.status?.type === 'running') {
          process.data.status = { type: 'interrupted' };
        }
      }
    }
  });
}
