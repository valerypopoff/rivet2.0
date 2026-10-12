import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { type ProcessEvents, type AgentTraceEvent } from '@valerypopoff/rivet2-core';
import { type ExecutionDataFlowApi } from './useExecutionDataFlow';
import { lastRunDataByNodeState, selectedLLMChatOutputPageByInvocationState } from '../state/dataFlow';
import { deleteStoredRefIds, storeInputsOrOutputsForHistory } from '../utils/executionDataStorage';
import { sanitizeInputsOrOutputs } from '../utils/executionDataSanitization';
import { nodeExecutionData } from './nodeExecutionData.js';
import { clearNodeRunData, updateLLMChatOutputHistory } from './executionDataTransitions.js';
import { handleError } from '../utils/errorHandling';
import { shouldToastAsyncBranchSafetyError } from '../utils/graphExecutionErrorPresentation';
import { useDataRefs } from '../providers/ProvidersContext';
import { projectState } from '../state/savedGraphs';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { updateAgentTraceEventForInvocation } from './agentTraceEventStorage.js';
import {
  removeLLMChatOutputHistorySelectionsForProcess,
  toLLMChatOutputHistoryEntry,
} from '../utils/llmChatOutputHistory.js';

export type NodeExecutionEventsApi = {
  onNodeError: (data: ProcessEvents['nodeError']) => void;
  onNodeExcluded: (data: ProcessEvents['nodeExcluded']) => void;
  onNodeFinish: (data: ProcessEvents['nodeFinish']) => void;
  onNodeOutputsCleared: (data: ProcessEvents['nodeOutputsCleared']) => void;
  onNodeStart: (data: ProcessEvents['nodeStart']) => void;
  onPartialOutput: (data: ProcessEvents['partialOutput']) => void;
  onLlmCallFinished: (data: ProcessEvents['llmCallFinished']) => void;
  onLlmChatOutputSnapshot: (data: ProcessEvents['llmChatOutputSnapshot']) => void;
  onLlmProfileAttempt: (data: ProcessEvents['llmProfileAttempt']) => void;
  onToolCallFinished: (data: ProcessEvents['toolCallFinished']) => void;
};

export function useNodeExecutionEvents({
  setDataForNode,
  setSelectedNodePageLatest,
  shouldSuppressPreloadedNodeEvent,
}: Pick<
  ExecutionDataFlowApi,
  'setDataForNode' | 'setSelectedNodePageLatest' | 'shouldSuppressPreloadedNodeEvent'
>): NodeExecutionEventsApi {
  const dataRefs = useDataRefs();
  const store = useStore();
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const setLLMChatOutputPageSelections = useSetAtom(selectedLLMChatOutputPageByInvocationState);
  const project = useAtomValue(projectState);
  const previousDataPerNodeToKeep = useAtomValue(previousDataPerNodeToKeepState);

  const onNodeStart = (event: ProcessEvents['nodeStart']) => {
    const { node, processId, execution } = event;
    if (shouldSuppressPreloadedNodeEvent(node.id, processId)) {
      return;
    }

    setDataForNode(node.id, processId, execution, nodeExecutionData.start(event));
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeFinish = (event: ProcessEvents['nodeFinish']) => {
    const { node, processId, execution } = event;
    if (shouldSuppressPreloadedNodeEvent(node.id, processId)) {
      return;
    }

    setDataForNode(node.id, processId, execution, nodeExecutionData.finish(event));
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeExcluded = (event: ProcessEvents['nodeExcluded']) => {
    const { node, processId, execution } = event;
    setDataForNode(node.id, processId, execution, nodeExecutionData.excluded(event));
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeError = (event: ProcessEvents['nodeError']) => {
    const { node, error, processId, execution } = event;
    setDataForNode(node.id, processId, execution, nodeExecutionData.error(event));
    setSelectedNodePageLatest(node.id, execution);

    if (shouldToastAsyncBranchSafetyError(error)) {
      handleError(error, 'Graph execution error');
    }
  };

  const onPartialOutput = (event: ProcessEvents['partialOutput']) => {
    const { node, processId, execution } = event;
    const applied = setDataForNode(node.id, processId, execution, nodeExecutionData.partial(event), {
      ignoreIfTerminal: true,
    });
    if (applied) {
      setSelectedNodePageLatest(node.id, execution);
    }
  };

  const onNodeOutputsCleared = ({ node, processId, execution }: ProcessEvents['nodeOutputsCleared']) => {
    let obsoleteRefIds: string[] = [];
    setLastRunData((previous) => {
      const result = clearNodeRunData(previous, node.id, processId);
      obsoleteRefIds = result.obsoleteRefIds;
      return result.runData;
    });
    deleteStoredRefIds(dataRefs, obsoleteRefIds);
    setLLMChatOutputPageSelections((previous) =>
      removeLLMChatOutputHistorySelectionsForProcess({
        nodeId: node.id,
        processId,
        selections: previous,
      }),
    );
    setSelectedNodePageLatest(node.id, execution);
  };

  const onLlmChatOutputSnapshot = (data: ProcessEvents['llmChatOutputSnapshot']) => {
    const outputData = storeInputsOrOutputsForHistory(sanitizeInputsOrOutputs(data.outputs), dataRefs, {
      channel: 'llm-chat-output-history',
      historyEntryId: data.entryId,
      nodeId: data.nodeId,
      processId: data.processId,
      projectId: project.metadata.id,
      splitIndex: data.splitIndex,
    })!;
    const storedEntry = toLLMChatOutputHistoryEntry(data, outputData);

    let obsoleteRefIds: string[] = [];
    let evictedProcessIds: ProcessEvents['llmChatOutputSnapshot']['processId'][] = [];
    setLastRunData((previous) => {
      const result = updateLLMChatOutputHistory(previous, data, storedEntry, previousDataPerNodeToKeep);
      obsoleteRefIds = result.obsoleteRefIds;
      evictedProcessIds = result.evictedProcessIds;
      return result.runData;
    });
    deleteStoredRefIds(dataRefs, obsoleteRefIds);
    if (evictedProcessIds.length > 0) {
      setLLMChatOutputPageSelections((previous) =>
        evictedProcessIds.reduce(
          (selections, processId) =>
            removeLLMChatOutputHistorySelectionsForProcess({
              nodeId: data.nodeId,
              processId,
              selections,
            }),
          previous,
        ),
      );
    }
  };

  const appendAgentTraceEvent = (event: AgentTraceEvent) => {
    const result = updateAgentTraceEventForInvocation(
      store.get(lastRunDataByNodeState),
      event,
      previousDataPerNodeToKeep,
    );
    store.set(lastRunDataByNodeState, result.runData);
    const { nodeId, obsoleteRefIds, evictedProcessIds } = result;
    deleteStoredRefIds(dataRefs, obsoleteRefIds);
    if (evictedProcessIds.length > 0) {
      setLLMChatOutputPageSelections((previous) =>
        evictedProcessIds.reduce(
          (selections, processId) => removeLLMChatOutputHistorySelectionsForProcess({ nodeId, processId, selections }),
          previous,
        ),
      );
    }
  };

  const onLlmCallFinished = (data: ProcessEvents['llmCallFinished']) => {
    appendAgentTraceEvent({
      type: 'llm-call-finished',
      ...data,
    });
  };

  const onLlmProfileAttempt = (data: ProcessEvents['llmProfileAttempt']) => {
    appendAgentTraceEvent({
      type: 'llm-profile-attempt',
      ...data,
    });
  };

  const onToolCallFinished = (data: ProcessEvents['toolCallFinished']) => {
    appendAgentTraceEvent({
      type: 'tool-call-finished',
      ...data,
    });
  };

  return {
    onNodeError,
    onNodeExcluded,
    onNodeFinish,
    onNodeOutputsCleared,
    onNodeStart,
    onPartialOutput,
    onLlmCallFinished,
    onLlmChatOutputSnapshot,
    onLlmProfileAttempt,
    onToolCallFinished,
  };
}
