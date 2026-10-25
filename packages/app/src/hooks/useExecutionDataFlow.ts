import { useLatest } from 'ahooks';
import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import {
  type GraphExecutionMetadata,
  type NodeId,
  type ProcessEvents,
  type ProcessId,
} from '@valerypopoff/rivet2-core';
import { currentGraphViewState, type NodeRunData } from '../state/dataFlow';
import { previousDataPerNodeToKeepState } from '../state/settings';
import { evaluationsRunningState } from '../state/evaluations';
import { clearExecutionDataRefs } from '../utils/executionDataStorage';
import { projectState } from '../state/savedGraphs';
import { shouldFollowLatestNodeProcess } from '../state/selectors/executionSelectors.js';
import { isLiveCalledProjectExecutionEvent } from '../utils/executionIdentity.js';
import { removeUserInputQuestionsForProcess } from './executionDataTransitions.js';
import { setDataForNodeInSnapshot } from './projectExecutionSnapshotEvents.js';
import { useExecutionSnapshotWriter } from './useExecutionSnapshotWriter.js';

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
  const writer = useExecutionSnapshotWriter();
  const { store, refStore: dataRefs } = writer;
  const evaluationRunning = useAtomValue(evaluationsRunningState);
  const evaluationRunningLatest = useLatest(evaluationRunning);
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
    let applied = false;
    writer.mutate((snapshot) => {
      const next = setDataForNodeInSnapshot(
        snapshot,
        { node: { id: nodeId } as ProcessEvents['nodeStart']['node'], processId, execution },
        data,
        {
          projectId: store.get(projectState).metadata.id,
          refStore: dataRefs,
          previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
          ignoreIfTerminal: options.ignoreIfTerminal,
          policy: { selectProcessPage: false },
        },
      );
      applied = next !== snapshot;
      return next;
    });
    return applied;
  };

  const setSelectedNodePageLatest = (nodeId: NodeId, execution: GraphExecutionMetadata | undefined) => {
    const view = store.get(currentGraphViewState);
    writer.mutate((snapshot) =>
      view &&
      execution?.graphId === view.graphId &&
      shouldFollowLatestNodeProcess(snapshot.selectedGraphRunByView[view.key], execution)
        ? { ...snapshot, selectedProcessPageNodes: { ...snapshot.selectedProcessPageNodes, [nodeId]: 'latest' } }
        : snapshot,
    );
  };

  const onStreamingOutputWatchSummary = (event: ProcessEvents['streamingOutputWatchSummary']) => {
    writer.event('streamingOutputWatchSummary', event);
  };

  const onUserInput = (data: ProcessEvents['userInput']) => {
    const { node, execution, isReplay } = data;
    // RecordingPlayer re-emits historical prompts for observability. Their
    // recorded answers are already part of the replay, so they must never
    // create an interactive modal even if a future caller bypasses the normal
    // dispatcher-level observer-only route.
    if (isReplay) {
      return;
    }

    writer.event('userInput', data, { policy: { selectProcessPage: false } });

    if (!isLiveCalledProjectExecutionEvent(data)) setSelectedNodePageLatest(node.id, execution);
  };

  const onCalledProjectNodeTerminal = ({
    node,
    processId,
  }: Pick<ProcessEvents['nodeFinish'], 'node' | 'processId'>) => {
    writer.mutate((snapshot) => ({
      ...snapshot,
      userInputQuestions: removeUserInputQuestionsForProcess(snapshot.userInputQuestions ?? {}, node.id, processId),
    }));
  };

  const onEvaluationStart = () => {
    clearNodeRunDataPreservationForNextStart();
    writer.mutate((snapshot) => {
      clearExecutionDataRefs(dataRefs, snapshot.lastRunDataByNode);
      return {
        ...snapshot,
        lastRecording: undefined,
        userInputQuestions: {},
        lastRunDataByNode: {},
        selectedLLMChatOutputPageByInvocation: {},
      };
    });
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
