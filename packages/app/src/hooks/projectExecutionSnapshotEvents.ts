import { produce } from 'immer';
import {
  type AgentTraceEvent,
  type ProcessEventMessageMap,
  type ProcessEvents,
  type ProjectId,
  type NodeId,
  type GraphExecutionMetadata,
} from '@valerypopoff/rivet2-core';
import {
  createEmptyProjectExecutionSnapshot,
  type GraphRunRecord,
  type NodeRunData,
  type ProjectExecutionSnapshot,
} from '../state/dataFlow.js';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { buildGraphViewKeyFromExecution, isLiveCalledProjectExecutionEvent } from '../utils/executionIdentity.js';
import { sanitizeInputsOrOutputs } from '../utils/executionDataSanitization.js';
import { getEventOccurredAt } from '../utils/recordedNodeTiming.js';
import { nodeExecutionData } from './nodeExecutionData.js';
import {
  clearExecutionDataRefs,
  clearRemovedExecutionDataRefs,
  collectStoredRefIds,
  splitRunDataByPreservedNodes,
  deleteStoredRefIds,
  storeInputsOrOutputsForHistory,
  storeNodeDataForHistory,
} from '../utils/executionDataStorage.js';
import {
  startGraphRunHistory,
  finishGraphRunState,
  interruptRunningProcesses,
  reconcileRunningProcessesAfterSuccessfulDone,
  updateSelectedGraphRunForGraphStart,
  appendRootRunIdOnce,
  type MissingDebuggerTerminalEvent,
} from './graphExecutionEventHelpers.js';
import {
  isTerminalNodeRunStatus,
  clearNodeRunData,
  updateNodeRunData,
  updateLLMChatOutputHistory,
  prepareNodeRunDataForStorage,
  removeUserInputQuestionsForProcess,
} from './executionDataTransitions.js';
import { applyProcessEventToRunActivityJournal } from '../features/runActivity/runActivityProcessEvents.js';
import { createRunActivityJournal } from '../features/runActivity/runActivityJournal.js';
import { handleError } from '../utils/errorHandling.js';
import { updateAgentTraceEventForInvocation } from './agentTraceEventStorage.js';
import {
  removeLLMChatOutputHistorySelectionsForProcess,
  toLLMChatOutputHistoryEntry,
} from '../utils/llmChatOutputHistory.js';
import { markStreamingOutputWatchTerminal } from './streamingOutputWatchTerminal.js';

export type ProjectExecutionSnapshotEventResult = {
  changed: boolean;
  snapshot: ProjectExecutionSnapshot;
};

export type ProjectExecutionEventPolicy = {
  /** Interactive presentation choices; passive projection leaves these unspecified. */
  selectProcessPage?: boolean;
  includeDebugData?: boolean;
  start?: { preserveNodeIds?: NodeId[]; evaluationRunning: boolean };
  keepRunningNodesOnError?: boolean;
  /** Collect metadata only; external diagnostic listeners run after the snapshot commits. */
  missingTerminalEvents?: MissingDebuggerTerminalEvent[];
};

export type ProjectExecutionSnapshotEventOptions<K extends keyof ProcessEventMessageMap> = {
  data: ProcessEventMessageMap[K];
  /** Original ancestry for passive copies; false when the source already journals the raw event. */
  activityData?: ProcessEventMessageMap[K] | false;
  /** Passive observers retain waits in the journal without creating interactive prompts. */
  activityOnly?: boolean;
  message: K;
  projectId: ProjectId;
  refStore: DataRefStore;
  snapshot: ProjectExecutionSnapshot | undefined;
  previousDataPerNodeToKeep?: number;
  policy?: ProjectExecutionEventPolicy;
};

export function applyProcessEventToProjectExecutionSnapshot<K extends keyof ProcessEventMessageMap>(
  options: ProjectExecutionSnapshotEventOptions<K>,
): ProjectExecutionSnapshotEventResult {
  const occurredAt = getEventOccurredAt(options.data) ?? Date.now();
  const previousSnapshot = options.snapshot ?? createEmptyProjectExecutionSnapshot();

  // partialOutput is detached from Core execution. A late observer callback
  // must not overwrite a completed/error/excluded invocation in either the
  // project snapshot or its Run Activity journal.
  if (
    options.message === 'partialOutput' &&
    isTerminalNodeProcess(
      previousSnapshot,
      (options.data as ProcessEvents['partialOutput']).node.id,
      (options.data as ProcessEvents['partialOutput']).processId,
    )
  ) {
    return { changed: false, snapshot: previousSnapshot };
  }

  const result = options.activityOnly
    ? { changed: false, snapshot: previousSnapshot }
    : applyProcessEventToProjectExecutionSnapshotData(options);
  let runActivityJournal = previousSnapshot.runActivityJournal ?? createRunActivityJournal();

  try {
    if (options.activityData !== false)
      runActivityJournal = applyProcessEventToRunActivityJournal({
        data: options.activityData ?? options.data,
        // Project snapshots created by older app versions do not carry the
        // additive Run Activity journal. Treat them as an empty journal instead
        // of making an inactive-project or replay event fail during restoration.
        journal: runActivityJournal,
        message: options.message,
        occurredAt,
      });
  } catch (error) {
    // This projection is observational. A malformed activity event must not
    // discard the primary execution snapshot for an inactive project.
    handleError(error, `Failed to update Run Activity for ${options.message}`, { toastError: false });
  }

  if (result.snapshot.runActivityJournal === runActivityJournal) {
    return result;
  }

  return {
    changed: true,
    snapshot: {
      ...result.snapshot,
      runActivityJournal,
    },
  };
}

function applyProcessEventToProjectExecutionSnapshotData<K extends keyof ProcessEventMessageMap>(
  options: ProjectExecutionSnapshotEventOptions<K>,
): ProjectExecutionSnapshotEventResult {
  const snapshot = options.snapshot ?? createEmptyProjectExecutionSnapshot();

  // Match active-workspace dispatch: called-project observations remain in
  // Run Activity without colliding with an inactive caller's graph/node IDs.
  if (options.message !== 'userInput' && isLiveCalledProjectExecutionEvent(options.data)) {
    if (options.message === 'nodeFinish' || options.message === 'nodeError' || options.message === 'nodeExcluded') {
      const { node, processId } = options.data as ProcessEvents['nodeFinish'];
      const userInputQuestions = removeUserInputQuestionsForProcess(
        snapshot.userInputQuestions ?? {},
        node.id,
        processId,
      );
      if (userInputQuestions !== snapshot.userInputQuestions) {
        return { changed: true, snapshot: { ...snapshot, userInputQuestions } };
      }
    }
    return { changed: false, snapshot };
  }

  switch (options.message) {
    case 'start':
      return {
        changed: true,
        snapshot: applyStart(snapshot, options.data as ProcessEvents['start'], options.refStore, options.policy?.start),
      };
    case 'nodeStart':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeStart'],
          nodeExecutionData.start(
            options.data as ProcessEvents['nodeStart'],
            options.policy?.includeDebugData ?? false,
          ),
          options,
        ),
      };
    case 'nodeFinish':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeFinish'],
          nodeExecutionData.finish(options.data as ProcessEvents['nodeFinish']),
          options,
        ),
      };
    case 'nodeError':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeError'],
          nodeExecutionData.error(options.data as ProcessEvents['nodeError']),
          options,
        ),
      };
    case 'nodeExcluded':
      return {
        changed: true,
        snapshot: setDataForNodeInSnapshot(
          snapshot,
          options.data as ProcessEvents['nodeExcluded'],
          nodeExecutionData.excluded(
            options.data as ProcessEvents['nodeExcluded'],
            options.policy?.includeDebugData ?? false,
          ),
          options,
        ),
      };
    case 'partialOutput':
      return {
        changed: true,
        snapshot: applyPartialOutput(snapshot, options.data as ProcessEvents['partialOutput'], options),
      };
    case 'llmCallFinished': {
      const data = options.data as ProcessEvents['llmCallFinished'];
      return {
        changed: true,
        snapshot: applyAgentTraceEvent(
          snapshot,
          {
            type: 'llm-call-finished',
            ...data,
          },
          options,
        ),
      };
    }
    case 'llmChatOutputSnapshot':
      return {
        changed: true,
        snapshot: applyLLMChatOutputSnapshot(snapshot, options.data as ProcessEvents['llmChatOutputSnapshot'], options),
      };
    case 'llmProfileAttempt': {
      const data = options.data as ProcessEvents['llmProfileAttempt'];
      return {
        changed: true,
        snapshot: applyAgentTraceEvent(
          snapshot,
          {
            type: 'llm-profile-attempt',
            ...data,
          },
          options,
        ),
      };
    }
    case 'toolCallFinished': {
      const data = options.data as ProcessEvents['toolCallFinished'];
      return {
        changed: true,
        snapshot: applyAgentTraceEvent(
          snapshot,
          {
            type: 'tool-call-finished',
            ...data,
          },
          options,
        ),
      };
    }
    case 'nodeOutputsCleared':
      return {
        changed: true,
        snapshot: applyNodeOutputsCleared(
          snapshot,
          options.data as ProcessEvents['nodeOutputsCleared'],
          options.refStore,
          options.policy?.selectProcessPage,
        ),
      };
    case 'streamingOutputWatchSummary': {
      const nextSnapshot = applyStreamingOutputWatchTerminal(
        snapshot,
        options.data as ProcessEvents['streamingOutputWatchSummary'],
      );
      return { changed: nextSnapshot !== snapshot, snapshot: nextSnapshot };
    }
    case 'userInput':
      return {
        changed: true,
        snapshot: applyUserInput(
          snapshot,
          options.data as ProcessEvents['userInput'],
          options.policy?.selectProcessPage,
        ),
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
        snapshot: applyDone(
          snapshot,
          options.data as ProcessEventMessageMap['done'],
          options.policy?.missingTerminalEvents,
        ),
      };
    case 'abort':
      return {
        changed: true,
        snapshot: applyAbort(snapshot),
      };
    case 'pause':
      if ((options.data as ProcessEvents['pause'])?.isReplay) {
        return { changed: false, snapshot };
      }
      return {
        changed: true,
        snapshot: { ...snapshot, graphPaused: true },
      };
    case 'resume':
      if ((options.data as ProcessEvents['resume'])?.isReplay) {
        return { changed: false, snapshot };
      }
      return {
        changed: true,
        snapshot: { ...snapshot, graphPaused: false },
      };
    case 'error':
      return {
        changed: true,
        snapshot: applyAbort(snapshot, options.policy?.keepRunningNodesOnError),
      };
    default:
      return {
        changed: false,
        snapshot,
      };
  }
}

function applyStreamingOutputWatchTerminal(
  snapshot: ProjectExecutionSnapshot,
  event: ProcessEvents['streamingOutputWatchSummary'],
): ProjectExecutionSnapshot {
  return produce(snapshot, (draft) => {
    markStreamingOutputWatchTerminal(draft.lastRunDataByNode, event);
  });
}

function applyAgentTraceEvent(
  snapshot: ProjectExecutionSnapshot,
  event: AgentTraceEvent,
  options: { refStore: DataRefStore; previousDataPerNodeToKeep?: number },
): ProjectExecutionSnapshot {
  const result = updateAgentTraceEventForInvocation(
    snapshot.lastRunDataByNode,
    event,
    options.previousDataPerNodeToKeep,
  );
  const nextSnapshot = {
    ...snapshot,
    lastRunDataByNode: result.runData,
    selectedLLMChatOutputPageByInvocation: result.evictedProcessIds.reduce(
      (selections, processId) =>
        removeLLMChatOutputHistorySelectionsForProcess({ nodeId: result.nodeId, processId, selections }),
      snapshot.selectedLLMChatOutputPageByInvocation ?? {},
    ),
  };
  deleteStoredRefIds(options.refStore, result.obsoleteRefIds);
  return nextSnapshot;
}

function applyLLMChatOutputSnapshot(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['llmChatOutputSnapshot'],
  options: { projectId: ProjectId; refStore: DataRefStore; previousDataPerNodeToKeep?: number },
): ProjectExecutionSnapshot {
  const storedOutputData = storeInputsOrOutputsForHistory(sanitizeInputsOrOutputs(data.outputs), options.refStore, {
    channel: 'llm-chat-output-history',
    historyEntryId: data.entryId,
    nodeId: data.nodeId,
    processId: data.processId,
    projectId: options.projectId,
    splitIndex: data.splitIndex,
  })!;
  const entry = toLLMChatOutputHistoryEntry(data, storedOutputData);
  const result = updateLLMChatOutputHistory(snapshot.lastRunDataByNode, data, entry, options.previousDataPerNodeToKeep);
  const nextSnapshot = {
    ...snapshot,
    lastRunDataByNode: result.runData,
    selectedLLMChatOutputPageByInvocation: result.evictedProcessIds.reduce(
      (selections, processId) =>
        removeLLMChatOutputHistorySelectionsForProcess({
          nodeId: data.nodeId,
          processId,
          selections,
        }),
      snapshot.selectedLLMChatOutputPageByInvocation ?? {},
    ),
  };
  deleteStoredRefIds(options.refStore, result.obsoleteRefIds);
  return nextSnapshot;
}

function applyStart(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['start'],
  refStore: DataRefStore,
  interactive?: ProjectExecutionEventPolicy['start'],
): ProjectExecutionSnapshot {
  if (interactive) {
    const base = {
      ...snapshot,
      lastRecording: undefined,
      userInputQuestions: {},
      graphPaused: snapshot.graphPaused,
      graphRunning: true,
      graphStartTime: Date.now(),
      rootGraph: data.startGraph.metadata!.id!,
      completedRootRunIds: [],
    };
    if (interactive.evaluationRunning) return base;
    const { preservedRunData, removedRunData } = splitRunDataByPreservedNodes(
      snapshot.lastRunDataByNode,
      interactive.preserveNodeIds ?? [],
    );
    let selections = interactive.preserveNodeIds?.length ? snapshot.selectedLLMChatOutputPageByInvocation ?? {} : {};
    for (const nodeId of Object.keys(removedRunData))
      selections = removeLLMChatOutputHistorySelectionsForProcess({ nodeId, selections });
    clearRemovedExecutionDataRefs(refStore, removedRunData, preservedRunData);
    return {
      ...base,
      lastRunDataByNode: preservedRunData,
      selectedLLMChatOutputPageByInvocation: selections,
      graphRunHistoryByView: {},
      selectedGraphRunByView: {},
    };
  }
  clearExecutionDataRefs(refStore, snapshot.lastRunDataByNode);

  return {
    ...createEmptyProjectExecutionSnapshot(),
    frozenNodeOutputs: snapshot.frozenNodeOutputs ?? {},
    graphRunning: true,
    graphStartTime: Date.now(),
    rootGraph: data.startGraph.metadata!.id!,
  };
}

function applyDone(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEventMessageMap['done'],
  missingTerminalEvents?: MissingDebuggerTerminalEvent[],
): ProjectExecutionSnapshot {
  const rootRunId = data.execution?.rootRunId ?? snapshot.completedRootRunIds?.[0];
  return {
    ...snapshot,
    graphPaused: false,
    graphRunning: false,
    lastRunDataByNode: reconcileRunningProcessesAfterSuccessfulDone(snapshot.lastRunDataByNode, {
      rootRunId,
      onMissingTerminalEvent: missingTerminalEvents ? (event) => missingTerminalEvents.push(event) : undefined,
    }),
    completedRootRunIds: (snapshot.completedRootRunIds ?? []).filter((id) => id !== rootRunId),
    runningGraphs: [],
    userInputQuestions: {},
  };
}

export function stopProjectExecutionSnapshot(snapshot: ProjectExecutionSnapshot): ProjectExecutionSnapshot {
  return {
    ...snapshot,
    graphPaused: false,
    graphRunning: false,
    runningGraphs: [],
    userInputQuestions: {},
    completedRootRunIds: [],
  };
}

function applyAbort(snapshot: ProjectExecutionSnapshot, keepRunningNodes = false): ProjectExecutionSnapshot {
  return {
    ...stopProjectExecutionSnapshot(snapshot),
    lastRunDataByNode: keepRunningNodes
      ? snapshot.lastRunDataByNode
      : interruptRunningProcesses(snapshot.lastRunDataByNode),
  };
}

function applyUserInput(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['userInput'],
  selectProcessPage?: boolean,
): ProjectExecutionSnapshot {
  // Playback retains this event for the snapshot's Run Activity journal, but
  // never restores an already-satisfied historical prompt into the User Input
  // modal when the project becomes active again.
  if (data.isReplay) {
    return snapshot;
  }

  return produce(snapshot, (draft) => {
    draft.userInputQuestions ??= {};
    draft.userInputQuestions[data.node.id] ??= [];
    draft.userInputQuestions[data.node.id]!.push({
      nodeId: data.node.id,
      processId: data.processId,
      questions: data.inputStrings,
    });
    if (!isLiveCalledProjectExecutionEvent(data) && selectProcessPage !== false)
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

  if (
    data.execution &&
    snapshot.graphRunHistoryByView[graphViewKey]?.some((run) => run.graphRunId === data.execution.graphRunId)
  )
    return snapshot;

  return produce(snapshot, (draft) => {
    draft.runningGraphs.push(graphId);
    draft.graphRunHistoryByView = startGraphRunHistory(draft.graphRunHistoryByView, graphViewKey, data.execution);

    draft.selectedGraphRunByView = updateSelectedGraphRunForGraphStart(draft.selectedGraphRunByView, graphViewKey);
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

  return {
    ...snapshot,
    ...finishGraphRunState(snapshot, graphViewKey, graphId, data.execution?.graphRunId, status),
    ...(status === 'ok' && data.execution && data.execution.parentGraphRunId == null
      ? { completedRootRunIds: appendRootRunIdOnce(snapshot.completedRootRunIds ?? [], data.execution.rootRunId) }
      : {}),
  };
}

export function setDataForNodeInSnapshot(
  snapshot: ProjectExecutionSnapshot,
  event: Pick<ProcessEvents['nodeStart'], 'node' | 'processId'> & { execution?: GraphExecutionMetadata },
  data: Partial<NodeRunData>,
  options: {
    projectId: ProjectId;
    refStore: DataRefStore;
    previousDataPerNodeToKeep?: number;
    ignoreIfTerminal?: boolean;
    policy?: ProjectExecutionEventPolicy;
  },
): ProjectExecutionSnapshot {
  if (options.ignoreIfTerminal && isTerminalNodeProcess(snapshot, event.node.id, event.processId)) return snapshot;
  const storedData = storeNodeDataForHistory(prepareNodeRunDataForStorage(data), options.refStore, {
    nodeId: event.node.id,
    processId: event.processId,
    projectId: options.projectId,
  });
  const result = updateNodeRunData(snapshot.lastRunDataByNode, {
    nodeId: event.node.id,
    processId: event.processId,
    execution: event.execution,
    data: storedData,
    previousDataPerNodeToKeep: options.previousDataPerNodeToKeep,
    ignoreIfTerminal: options.ignoreIfTerminal,
  });
  if (!result.applied) {
    deleteStoredRefIds(options.refStore, collectStoredRefIds(storedData));
    return snapshot;
  }
  const nextSnapshot = {
    ...snapshot,
    lastRunDataByNode: result.runData,
    selectedLLMChatOutputPageByInvocation: result.evictedProcessIds.reduce(
      (selections, processId) =>
        removeLLMChatOutputHistorySelectionsForProcess({
          nodeId: event.node.id,
          processId,
          selections,
        }),
      snapshot.selectedLLMChatOutputPageByInvocation ?? {},
    ),
    userInputQuestions:
      data.status && data.status.type !== 'running'
        ? removeUserInputQuestionsForProcess(snapshot.userInputQuestions ?? {}, event.node.id, event.processId)
        : snapshot.userInputQuestions,
    selectedProcessPageNodes:
      options.policy?.selectProcessPage === false ||
      (options.policy?.selectProcessPage !== true &&
        snapshot.lastRunDataByNode[event.node.id]?.some((process) => process.processId === event.processId))
        ? snapshot.selectedProcessPageNodes
        : { ...snapshot.selectedProcessPageNodes, [event.node.id]: 'latest' as const },
  };
  deleteStoredRefIds(options.refStore, result.obsoleteRefIds);
  return nextSnapshot;
}

function applyPartialOutput(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['partialOutput'],
  options: {
    projectId: ProjectId;
    refStore: DataRefStore;
    previousDataPerNodeToKeep?: number;
    policy?: ProjectExecutionEventPolicy;
  },
): ProjectExecutionSnapshot {
  const next = setDataForNodeInSnapshot(snapshot, data, nodeExecutionData.partial(data), options);
  if (!data.node.isSplitRun || options.policy?.selectProcessPage === false) return next;
  return { ...next, selectedProcessPageNodes: { ...next.selectedProcessPageNodes, [data.node.id]: 'latest' } };
}

function isTerminalNodeProcess(
  snapshot: ProjectExecutionSnapshot,
  nodeId: ProcessEvents['nodeStart']['node']['id'],
  processId: ProcessEvents['nodeStart']['processId'],
): boolean {
  const status = snapshot.lastRunDataByNode[nodeId]?.find((process) => process.processId === processId)?.data.status;
  return isTerminalNodeRunStatus(status);
}

function applyNodeOutputsCleared(
  snapshot: ProjectExecutionSnapshot,
  data: ProcessEvents['nodeOutputsCleared'],
  refStore: DataRefStore,
  selectProcessPage = true,
): ProjectExecutionSnapshot {
  const result = clearNodeRunData(snapshot.lastRunDataByNode, data.node.id, data.processId);
  const nextSnapshot = produce(snapshot, (draft) => {
    draft.lastRunDataByNode = result.runData;

    if (selectProcessPage) draft.selectedProcessPageNodes[data.node.id] = 'latest';
    draft.selectedLLMChatOutputPageByInvocation = removeLLMChatOutputHistorySelectionsForProcess({
      nodeId: data.node.id,
      processId: data.processId,
      selections: draft.selectedLLMChatOutputPageByInvocation ?? {},
    });
  });

  deleteStoredRefIds(refStore, result.obsoleteRefIds);
  return nextSnapshot;
}
