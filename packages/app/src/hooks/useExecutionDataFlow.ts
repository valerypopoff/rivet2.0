import { useLatest } from 'ahooks';
import { produce } from 'immer';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
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
import { markStreamingOutputWatchTerminal } from './streamingOutputWatchTerminal.js';
import { isLiveCalledProjectExecutionEvent } from '../utils/executionIdentity.js';
import {
  updateNodeRunData,
  isTerminalNodeRunStatus,
  prepareNodeRunDataForStorage,
  removeUserInputQuestionsForProcess,
} from './executionDataTransitions.js';

export type ExecutionDataFlowApi = {
  clearNodeRunDataPreservationForNextStart: () => void;
  consumeNodeRunDataPreservationForNextStart: () => NodeId[] | undefined;
  onEvaluationStart: () => void;
  onStreamingOutputWatchSummary: (data: ProcessEvents['streamingOutputWatchSummary']) => void;
  onUserInput: (data: ProcessEvents['userInput']) => void;
  onCalledProjectNodeTerminal: (data: Pick<ProcessEvents['nodeFinish'], 'node' | 'processId'>) => void;
  preserveNodeRunDataForNextStart: (nodeIds: NodeId[]) => void;
  setDataForNode: (
    nodeId: NodeId,
    processId: ProcessId,
    execution: GraphExecutionMetadata | undefined,
    data: Partial<NodeRunData>,
    options?: { ignoreIfTerminal?: boolean },
  ) => boolean;
  setSelectedNodePageLatest: (nodeId: NodeId, execution: GraphExecutionMetadata | undefined) => void;
  shouldSuppressPreloadedNodeEvent: (nodeId: NodeId, processId: ProcessId) => boolean;
  suppressPreloadedNodeEventsForCurrentRun: (nodeIds: NodeId[]) => void;
  evaluationRunningLatest: ReturnType<typeof useLatest<boolean>>;
};

export function useExecutionDataFlow(): ExecutionDataFlowApi {
  const dataRefs = useDataRefs();
  const store = useStore();
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
    options: { ignoreIfTerminal?: boolean } = {},
  ): boolean => {
    const isExistingProcessTerminal = () =>
      isTerminalNodeRunStatus(
        store.get(lastRunDataByNodeState)[nodeId]?.find((process) => process.processId === processId)?.data.status,
      );

    // A detached partial observer can outlive its terminal event. Check the
    // live store before allocating a stable output ref for such an update.
    if (options.ignoreIfTerminal && isExistingProcessTerminal()) {
      return false;
    }

    if (data.status && data.status.type !== 'running') {
      setUserInputQuestions((questions) => removeUserInputQuestionsForProcess(questions, nodeId, processId));
    }
    const storedData = storeNodeDataForHistory(prepareNodeRunDataForStorage(data), dataRefs, {
      nodeId,
      processId,
      projectId: project.metadata.id,
    });
    const result = updateNodeRunData(store.get(lastRunDataByNodeState), {
      nodeId,
      processId,
      execution,
      data: storedData,
      ignoreIfTerminal: options.ignoreIfTerminal,
      previousDataPerNodeToKeep,
    });
    if (!result.applied) {
      deleteStoredRefIds(dataRefs, collectStoredRefIds(storedData));
      return false;
    }
    store.set(lastRunDataByNodeState, result.runData);
    deleteStoredRefIds(dataRefs, result.obsoleteRefIds);
    const evictedProcessIds = result.evictedProcessIds;
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
    return true;
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

  const onStreamingOutputWatchSummary = (event: ProcessEvents['streamingOutputWatchSummary']) => {
    setLastRunData((previous) =>
      produce(previous, (draft) => {
        markStreamingOutputWatchTerminal(draft, event);
      }),
    );
  };

  const onUserInput = (data: ProcessEvents['userInput']) => {
    const { node, processId, inputStrings, execution, isReplay } = data;
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

    if (!isLiveCalledProjectExecutionEvent(data)) setSelectedNodePageLatest(node.id, execution);
  };

  const onCalledProjectNodeTerminal = ({
    node,
    processId,
  }: Pick<ProcessEvents['nodeFinish'], 'node' | 'processId'>) => {
    setUserInputQuestions((questions) => removeUserInputQuestionsForProcess(questions, node.id, processId));
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
    onStreamingOutputWatchSummary,
    onUserInput,
    onCalledProjectNodeTerminal,
    preserveNodeRunDataForNextStart,
    setDataForNode,
    setSelectedNodePageLatest,
    shouldSuppressPreloadedNodeEvent,
    suppressPreloadedNodeEventsForCurrentRun,
    evaluationRunningLatest,
  };
}
