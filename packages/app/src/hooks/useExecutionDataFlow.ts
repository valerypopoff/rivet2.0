import { useLatest } from 'ahooks';
import { produce } from 'immer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useRef } from 'react';
import {
  type GraphExecutionMetadata,
  type NodeId,
  type ProcessEvents,
  type ProcessId,
} from '@valerypopoff/rivet2-core';
import { useDataRefs } from '../providers/ProvidersContext';
import { lastRecordingState } from '../state/execution';
import {
  currentGraphViewState,
  selectedGraphRunByViewState,
  type NodeRunData,
  type NodeRunDataWithRefs,
  lastRunDataByNodeState,
  selectedLLMChatOutputPageByInvocationState,
  selectedProcessPageNodesState,
} from '../state/dataFlow';
import { previousDataPerNodeToKeepState } from '../state/settings';
import { evaluationsRunningState } from '../state/evaluations';
import { type ProcessQuestions, userInputModalQuestionsState } from '../state/userInput';
import {
  clearExecutionDataRefs,
  collectStoredRefIds,
  deleteStoredRefIds,
  storeNodeDataForHistory,
} from '../utils/executionDataStorage';
import { projectState } from '../state/savedGraphs';
import { removeLLMChatOutputHistorySelectionsForProcess } from '../utils/llmChatOutputHistory.js';
import { shouldFollowLatestNodeProcess } from '../state/selectors/executionSelectors.js';

export type ExecutionDataFlowApi = {
  clearNodeRunDataPreservationForNextStart: () => void;
  consumeNodeRunDataPreservationForNextStart: () => NodeId[] | undefined;
  onEvaluationStart: () => void;
  onUserInput: (data: ProcessEvents['userInput']) => void;
  preserveNodeRunDataForNextStart: (nodeIds: NodeId[]) => void;
  setDataForNode: (
    nodeId: NodeId,
    processId: ProcessId,
    execution: GraphExecutionMetadata | undefined,
    data: Partial<NodeRunData>,
  ) => void;
  setSelectedNodePageLatest: (nodeId: NodeId, execution: GraphExecutionMetadata | undefined) => void;
  shouldSuppressPreloadedNodeEvent: (nodeId: NodeId, processId: ProcessId) => boolean;
  suppressPreloadedNodeEventsForCurrentRun: (nodeIds: NodeId[]) => void;
  evaluationRunningLatest: ReturnType<typeof useLatest<boolean>>;
};

export function useExecutionDataFlow(): ExecutionDataFlowApi {
  const dataRefs = useDataRefs();
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const setLLMChatOutputPageSelections = useSetAtom(selectedLLMChatOutputPageByInvocationState);
  const setSelectedPage = useSetAtom(selectedProcessPageNodesState);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const setLastRecordingState = useSetAtom(lastRecordingState);
  const evaluationRunning = useAtomValue(evaluationsRunningState);
  const evaluationRunningLatest = useLatest(evaluationRunning);
  const previousDataPerNodeToKeep = useAtomValue(previousDataPerNodeToKeepState);
  const currentGraphView = useAtomValue(currentGraphViewState);
  const selectedGraphRunByView = useAtomValue(selectedGraphRunByViewState);
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const project = useAtomValue(projectState);
  const currentGraphViewLatest = useLatest(currentGraphView);
  const selectedGraphRunByViewLatest = useLatest(selectedGraphRunByView);
  const lastRunDataLatest = useLatest(lastRunData);
  const nodeIdsToPreserveOnNextStartRef = useRef<NodeId[] | undefined>(undefined);
  const suppressedPreloadedNodeIdsRef = useRef<Set<NodeId>>(new Set());

  const preserveNodeRunDataForNextStart = (nodeIds: NodeId[]) => {
    nodeIdsToPreserveOnNextStartRef.current = nodeIds;
  };

  const suppressPreloadedNodeEventsForCurrentRun = (nodeIds: NodeId[]) => {
    suppressedPreloadedNodeIdsRef.current = new Set(nodeIds);
  };

  const clearNodeRunDataPreservationForNextStart = () => {
    nodeIdsToPreserveOnNextStartRef.current = undefined;
    suppressedPreloadedNodeIdsRef.current = new Set();
  };

  const consumeNodeRunDataPreservationForNextStart = () => {
    const nodeIds = nodeIdsToPreserveOnNextStartRef.current;
    nodeIdsToPreserveOnNextStartRef.current = undefined;
    return nodeIds;
  };

  const shouldSuppressPreloadedNodeEvent = (nodeId: NodeId, processId: ProcessId) => {
    return processId === ('preload' as ProcessId) && suppressedPreloadedNodeIdsRef.current.has(nodeId);
  };

  const setDataForNode = (
    nodeId: NodeId,
    processId: ProcessId,
    execution: GraphExecutionMetadata | undefined,
    data: Partial<NodeRunData>,
  ) => {
    if (data.status && data.status.type !== 'running') {
      setUserInputQuestions((questions) => removeUserInputQuestionsForProcess(questions, nodeId, processId));
    }
    const storedData = storeNodeDataForHistory(prepareNodeRunDataForStorage(data), dataRefs, {
      nodeId,
      processId,
      projectId: project.metadata.id,
    });
    const refIdsToDelete: string[] = [];
    const evictedProcessIds: ProcessId[] = [];

    setLastRunData((prev) =>
      produce(prev, (draft) => {
        if (!draft[nodeId]) {
          draft[nodeId] = [];
        }

        const existingProcess = draft[nodeId]!.find((process) => process.processId === processId);
        if (existingProcess) {
          existingProcess.graphId = execution?.graphId ?? existingProcess.graphId;
          existingProcess.graphRunId = execution?.graphRunId ?? existingProcess.graphRunId;
          existingProcess.rootRunId = execution?.rootRunId ?? existingProcess.rootRunId;
          const nextProcessData = mergeNodeRunDataForProcess(existingProcess.data, storedData);
          refIdsToDelete.push(...collectReplacedRefIds(existingProcess.data, nextProcessData));
          existingProcess.data = nextProcessData;
          return;
        }

        if (previousDataPerNodeToKeep > -1) {
          const dataNotKept =
            previousDataPerNodeToKeep === 0 ? draft[nodeId]! : draft[nodeId]!.slice(0, -previousDataPerNodeToKeep);

          for (const previousProcess of dataNotKept) {
            refIdsToDelete.push(...collectStoredRefIds(previousProcess.data));
            evictedProcessIds.push(previousProcess.processId);
            if (previousProcess.data.inputData) {
              previousProcess.data.inputData = {};
            }
            if (previousProcess.data.outputData) {
              previousProcess.data.outputData = {};
            }
            if (previousProcess.data.splitOutputData) {
              previousProcess.data.splitOutputData = {};
            }
            if (previousProcess.data.llmChatOutputHistory) {
              previousProcess.data.llmChatOutputHistory = {};
            }
          }
        }

        draft[nodeId]!.push({
          processId,
          graphId: execution?.graphId,
          graphRunId: execution?.graphRunId,
          rootRunId: execution?.rootRunId,
          data: storedData as NodeRunDataWithRefs,
        });
      }),
    );

    deleteStoredRefIds(dataRefs, refIdsToDelete);
    if (evictedProcessIds.length > 0) {
      setLLMChatOutputPageSelections((previous) =>
        evictedProcessIds.reduce(
          (selections, evictedProcessId) =>
            removeLLMChatOutputHistorySelectionsForProcess({
              nodeId,
              processId: evictedProcessId,
              selections,
            }),
          previous,
        ),
      );
    }
  };

  const setSelectedNodePageLatest = (nodeId: NodeId, execution: GraphExecutionMetadata | undefined) => {
    const view = currentGraphViewLatest.current;
    const selectionByView = selectedGraphRunByViewLatest.current ?? {};
    const shouldFollowLatest =
      view != null &&
      execution?.graphId === view.graphId &&
      shouldFollowLatestNodeProcess(selectionByView[view.key], execution);

    if (!shouldFollowLatest) {
      return;
    }

    setSelectedPage((prev) => ({ ...prev, [nodeId]: 'latest' }));
  };

  const onUserInput = ({ node, processId, inputStrings, execution, isReplay }: ProcessEvents['userInput']) => {
    // RecordingPlayer re-emits historical prompts for observability. Their
    // recorded answers are already part of the replay, so they must never
    // create an interactive modal even if a future caller bypasses the normal
    // dispatcher-level observer-only route.
    if (isReplay) {
      return;
    }

    const questions: ProcessQuestions = {
      nodeId: node.id,
      processId,
      questions: inputStrings,
    };

    setUserInputQuestions((currentQuestions) => {
      const previousQuestions = currentQuestions[node.id] ?? [];
      return {
        ...currentQuestions,
        [node.id]: [...previousQuestions, questions],
      };
    });

    setSelectedNodePageLatest(node.id, execution);
  };

  const onEvaluationStart = () => {
    clearNodeRunDataPreservationForNextStart();
    setLastRecordingState(undefined);
    setUserInputQuestions({});
    setLastRunData({});
    setLLMChatOutputPageSelections({});
    clearExecutionDataRefs(dataRefs, lastRunDataLatest.current ?? {});
  };

  return {
    clearNodeRunDataPreservationForNextStart,
    consumeNodeRunDataPreservationForNextStart,
    onEvaluationStart,
    onUserInput,
    preserveNodeRunDataForNextStart,
    setDataForNode,
    setSelectedNodePageLatest,
    shouldSuppressPreloadedNodeEvent,
    suppressPreloadedNodeEventsForCurrentRun,
    evaluationRunningLatest,
  };
}

/** A terminal invocation must not leave a prompt blocking other live branches. */
export function removeUserInputQuestionsForProcess(
  questions: Record<NodeId, ProcessQuestions[]>,
  nodeId: NodeId,
  processId: ProcessId,
): Record<NodeId, ProcessQuestions[]> {
  const pending = questions[nodeId];
  if (!pending) return questions;
  const remaining = pending.filter((request) => request.processId !== processId);
  if (remaining.length === pending.length) return questions;
  const next = { ...questions };
  if (remaining.length > 0) next[nodeId] = remaining;
  else delete next[nodeId];
  return next;
}

export function prepareNodeRunDataForStorage(data: Partial<NodeRunData>): Partial<NodeRunData> {
  if (data.status?.type !== 'running' || (data.outputData === undefined && data.splitOutputData === undefined)) {
    return data;
  }

  const { outputData: _outputData, splitOutputData: _splitOutputData, ...dataWithoutOutputs } = data;
  return dataWithoutOutputs;
}

export function mergeNodeRunDataForProcess(
  previousData: NodeRunDataWithRefs,
  nextData: Partial<NodeRunDataWithRefs>,
): NodeRunDataWithRefs {
  const mergedData = {
    ...previousData,
    ...nextData,
  };

  if (nextData.status?.type === 'running' && isTerminalNodeRunStatus(previousData.status)) {
    mergedData.status = previousData.status;
    copyOptionalNodeRunField(previousData, mergedData, 'startedAt');
    copyOptionalNodeRunField(previousData, mergedData, 'finishedAt');
    copyOptionalNodeRunField(previousData, mergedData, 'durationMs');
    copyOptionalNodeRunField(previousData, mergedData, 'splitRunDurationMs');
    copyOptionalNodeRunField(previousData, mergedData, 'outputData');
    copyOptionalNodeRunField(previousData, mergedData, 'splitOutputData');
  }

  return mergedData;
}

function copyOptionalNodeRunField<T extends keyof NodeRunDataWithRefs>(
  source: NodeRunDataWithRefs,
  target: NodeRunDataWithRefs,
  key: T,
): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}

function isTerminalNodeRunStatus(status: NodeRunDataWithRefs['status']): boolean {
  return (
    status?.type === 'ok' ||
    status?.type === 'error' ||
    status?.type === 'notRan' ||
    status?.type === 'interrupted'
  );
}

export function collectReplacedRefIds(
  previousData: NodeRunDataWithRefs,
  nextData: Partial<NodeRunDataWithRefs>,
): string[] {
  const previousRefIds = new Set<string>();
  const nextRefIds = new Set<string>();

  if (nextData.inputData !== undefined) {
    for (const refId of collectStoredRefIds(previousData.inputData)) {
      previousRefIds.add(refId);
    }
    for (const refId of collectStoredRefIds(nextData.inputData)) {
      nextRefIds.add(refId);
    }
  }

  if (nextData.outputData !== undefined) {
    for (const refId of collectStoredRefIds(previousData.outputData)) {
      previousRefIds.add(refId);
    }
    for (const refId of collectStoredRefIds(nextData.outputData)) {
      nextRefIds.add(refId);
    }
  }

  if (nextData.splitOutputData !== undefined) {
    for (const [index, nextSplitData] of Object.entries(nextData.splitOutputData)) {
      for (const refId of collectStoredRefIds(previousData.splitOutputData?.[Number(index)])) {
        previousRefIds.add(refId);
      }
      for (const refId of collectStoredRefIds(nextSplitData)) {
        nextRefIds.add(refId);
      }
    }
  }

  return [...previousRefIds].filter((refId) => !nextRefIds.has(refId));
}
