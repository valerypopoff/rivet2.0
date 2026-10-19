import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useRef } from 'react';
import { type NodeId, type ProcessEvents, type RootRunId } from '@valerypopoff/rivet2-core';
import { useLatest } from 'ahooks';
import { lastRecordingState } from '../state/execution';
import {
  graphRunHistoryByViewState,
  graphPausedState,
  graphRunningState,
  graphStartTimeState,
  lastRunDataByNodeState,
  rootGraphState,
  runningGraphsState,
  selectedGraphRunByViewState,
  selectedLLMChatOutputPageByInvocationState,
  type GraphRunRecord,
} from '../state/dataFlow';
import { userInputModalQuestionsState } from '../state/userInput';
import { handleError } from '../utils/errorHandling.js';
import { buildGraphViewKeyFromExecution } from '../utils/executionIdentity';
import type { ExecutionDataFlowApi } from './useExecutionDataFlow';
import { useDataRefs } from '../providers/ProvidersContext.js';
import {
  clearExecutionDataRefs,
  clearRemovedExecutionDataRefs,
  splitRunDataByPreservedNodes,
} from '../utils/executionDataStorage.js';
import {
  appendRootRunIdOnce,
  startGraphRunHistory,
  finishGraphRunState,
  interruptRunningProcesses,
  type MissingDebuggerTerminalEvent,
  reconcileRunningProcessesAfterSuccessfulDone,
  updateSelectedGraphRunForGraphStart,
} from './graphExecutionEventHelpers.js';
import { removeLLMChatOutputHistorySelectionsForProcess } from '../utils/llmChatOutputHistory.js';

export type GraphExecutionEventsApi = {
  onAbort: (data: ProcessEvents['abort']) => void;
  onDone: (data: ProcessEvents['done']) => void;
  onError: (data: ProcessEvents['error']) => void;
  onGraphAbort: (data: ProcessEvents['graphAbort']) => void;
  onGraphError: (data: ProcessEvents['graphError']) => void;
  onGraphFinish: (data: ProcessEvents['graphFinish']) => void;
  onGraphStart: (data: ProcessEvents['graphStart']) => void;
  onPause: () => void;
  onResume: () => void;
  onStart: (data: ProcessEvents['start']) => void;
  onStop: () => void;
};

export type GraphExecutionEventsOptions = {
  onMissingDebuggerTerminalEvent?: (event: MissingDebuggerTerminalEvent) => void;
};

export function useGraphExecutionEvents(
  {
    clearNodeRunDataPreservationForNextStart,
    consumeNodeRunDataPreservationForNextStart,
    evaluationRunningLatest,
  }: Pick<
    ExecutionDataFlowApi,
    | 'clearNodeRunDataPreservationForNextStart'
    | 'consumeNodeRunDataPreservationForNextStart'
    | 'evaluationRunningLatest'
  >,
  options: GraphExecutionEventsOptions = {},
): GraphExecutionEventsApi {
  const store = useStore();
  const dataRefs = useDataRefs();
  const setLastRecordingState = useSetAtom(lastRecordingState);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const setGraphRunning = useSetAtom(graphRunningState);
  const setGraphPaused = useSetAtom(graphPausedState);
  const setRunningGraphsState = useSetAtom(runningGraphsState);
  const setRootGraph = useSetAtom(rootGraphState);
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const setGraphStartTime = useSetAtom(graphStartTimeState);
  const setGraphRunHistoryByView = useSetAtom(graphRunHistoryByViewState);
  const setSelectedGraphRunByView = useSetAtom(selectedGraphRunByViewState);
  const setLLMChatOutputPageSelections = useSetAtom(selectedLLMChatOutputPageByInvocationState);
  const lastRunDataLatest = useLatest(lastRunData);
  const rootRunIdsForDoneReconciliationRef = useRef<RootRunId[]>([]);

  const stopAll = () => {
    setGraphRunning(false);
    setGraphPaused(false);
    setUserInputQuestions({});
    setRunningGraphsState([]);
  };

  const interruptAll = () => setLastRunData(interruptRunningProcesses);

  const onStart = ({ startGraph }: ProcessEvents['start']) => {
    const nodeIdsToPreserve = consumeNodeRunDataPreservationForNextStart();

    rootRunIdsForDoneReconciliationRef.current = [];
    setLastRecordingState(undefined);
    setUserInputQuestions({});
    setGraphRunning(true);
    setRootGraph(startGraph.metadata!.id);
    setGraphStartTime(Date.now());

    if (!evaluationRunningLatest.current) {
      resetLastRunDataForRunStart(nodeIdsToPreserve);
      setGraphRunHistoryByView({});
      setSelectedGraphRunByView({});
    }
  };

  const onStop = () => {
    rootRunIdsForDoneReconciliationRef.current = [];
    clearNodeRunDataPreservationForNextStart();
    stopAll();
  };

  const onDone = (_data: ProcessEvents['done']) => {
    const rootRunId = rootRunIdsForDoneReconciliationRef.current.shift();
    clearNodeRunDataPreservationForNextStart();
    stopAll();
    setLastRunData((lastRun) =>
      reconcileRunningProcessesAfterSuccessfulDone(lastRun, {
        onMissingTerminalEvent: options.onMissingDebuggerTerminalEvent,
        rootRunId,
      }),
    );
  };

  const onAbort = (_data: ProcessEvents['abort']) => {
    rootRunIdsForDoneReconciliationRef.current = [];
    clearNodeRunDataPreservationForNextStart();
    stopAll();
    interruptAll();
  };

  const onGraphAbort = (data: ProcessEvents['graphAbort']) => {
    finishGraphRun(data, 'aborted');
  };

  const onGraphError = (data: ProcessEvents['graphError']) => {
    finishGraphRun(data, 'error');
  };

  const onError = (data: ProcessEvents['error']) => {
    rootRunIdsForDoneReconciliationRef.current = [];
    clearNodeRunDataPreservationForNextStart();
    stopAll();
    // A terminal failure may happen before any node has visible error output
    // (for example, cross-project preflight). Do not gate this on error text.
    // handleError deduplicates matching node/root notifications.
    handleError(data.error, 'Graph execution error');
  };

  const onGraphStart = (data: ProcessEvents['graphStart']) => {
    const graphViewKey = buildGraphViewKeyFromExecution({
      execution: data.execution,
      graphIdFallback: data.graph.metadata!.id!,
    });

    if (
      data.execution &&
      store.get(graphRunHistoryByViewState)[graphViewKey]?.some((run) => run.graphRunId === data.execution.graphRunId)
    )
      return;
    setRunningGraphsState((running) => [...running, data.graph.metadata!.id!]);

    if (!data.execution) {
      setSelectedGraphRunByView((prev) => updateSelectedGraphRunForGraphStart(prev, graphViewKey));
      return;
    }

    setGraphRunHistoryByView((previous) => startGraphRunHistory(previous, graphViewKey, data.execution));
    setSelectedGraphRunByView((prev) => updateSelectedGraphRunForGraphStart(prev, graphViewKey));
  };

  const onGraphFinish = (data: ProcessEvents['graphFinish']) => {
    if (data.execution && data.execution.parentGraphRunId == null) {
      rootRunIdsForDoneReconciliationRef.current = appendRootRunIdOnce(
        rootRunIdsForDoneReconciliationRef.current,
        data.execution.rootRunId,
      );
    }
    finishGraphRun(data, 'ok');
  };

  const onPause = () => {
    setGraphPaused(true);
  };

  const onResume = () => {
    setGraphPaused(false);
  };

  const finishGraphRun = (
    data: ProcessEvents['graphFinish'] | ProcessEvents['graphError'] | ProcessEvents['graphAbort'],
    status: GraphRunRecord['status'],
  ) => {
    const next = finishGraphRunState(
      { graphRunHistoryByView: store.get(graphRunHistoryByViewState), runningGraphs: store.get(runningGraphsState) },
      buildGraphViewKeyFromExecution({ execution: data.execution, graphIdFallback: data.graph.metadata!.id! }),
      data.graph.metadata!.id!,
      data.execution?.graphRunId,
      status,
    );
    setGraphRunHistoryByView(next.graphRunHistoryByView);
    setRunningGraphsState(next.runningGraphs);
  };

  const resetLastRunDataForRunStart = (nodeIdsToPreserve: NodeId[] | undefined) => {
    const currentLastRunData = lastRunDataLatest.current ?? {};

    if (!nodeIdsToPreserve?.length) {
      setLastRunData({});
      setLLMChatOutputPageSelections({});
      clearExecutionDataRefs(dataRefs, currentLastRunData);
      return;
    }

    const { preservedRunData, removedRunData } = splitRunDataByPreservedNodes(currentLastRunData, nodeIdsToPreserve);

    setLastRunData(preservedRunData);
    const preservedNodeIds = new Set(nodeIdsToPreserve);
    setLLMChatOutputPageSelections((previous) => {
      let selections = previous;
      for (const nodeId of Object.keys(removedRunData)) {
        if (!preservedNodeIds.has(nodeId as NodeId)) {
          selections = removeLLMChatOutputHistorySelectionsForProcess({ nodeId, selections });
        }
      }
      return selections;
    });
    clearRemovedExecutionDataRefs(dataRefs, removedRunData, preservedRunData);
  };

  return {
    onAbort,
    onDone,
    onError,
    onGraphAbort,
    onGraphError,
    onGraphFinish,
    onGraphStart,
    onPause,
    onResume,
    onStart,
    onStop,
  };
}
