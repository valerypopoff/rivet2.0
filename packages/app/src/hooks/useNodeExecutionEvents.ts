import { produce } from 'immer';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  type CodeNode,
  type CodeNewNode,
  type ExpressionNode,
  type ExtractObjectPathNode,
  type JSFilterNode,
  type JSMapNode,
  type ProcessEvents,
  type AgentTraceEvent,
} from '@valerypopoff/rivet2-core';
import { type ExecutionDataFlowApi } from './useExecutionDataFlow';
import { lastRunDataByNodeState, selectedLLMChatOutputPageByInvocationState } from '../state/dataFlow';
import {
  collectStoredRefIds,
  deleteStoredRefIds,
  storeInputsOrOutputsForHistory,
} from '../utils/executionDataStorage';
import { sanitizeInputsOrOutputs, sanitizeSplitOutputs } from '../utils/executionDataSanitization';
import { getRecordedNodeTimingPatch } from '../utils/recordedNodeTiming.js';
import { handleError } from '../utils/errorHandling';
import { shouldToastAsyncBranchSafetyError } from '../utils/graphExecutionErrorPresentation';
import { useDataRefs } from '../providers/ProvidersContext';
import { projectState } from '../state/savedGraphs';
import { upsertAgentTraceEventForInvocation } from './agentTraceEventStorage.js';
import {
  removeLLMChatOutputHistorySelectionsForProcess,
  toLLMChatOutputHistoryEntry,
  upsertLLMChatOutputHistoryEntry,
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
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const setLLMChatOutputPageSelections = useSetAtom(selectedLLMChatOutputPageByInvocationState);
  const project = useAtomValue(projectState);

  const onNodeStart = (event: ProcessEvents['nodeStart']) => {
    const { node, inputs, processId, execution } = event;
    if (shouldSuppressPreloadedNodeEvent(node.id, processId)) {
      return;
    }

    setDataForNode(node.id, processId, execution, {
      ...getNodeRunDebugData(node),
      inputData: sanitizeInputsOrOutputs(inputs),
      ...getRecordedNodeTimingPatch(event, 'start'),
      status: { type: 'running' },
      startedAt: Date.now(),
    });
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeFinish = (event: ProcessEvents['nodeFinish']) => {
    const { node, outputs, processId, durationMs, splitRunDurationMs, execution } = event;
    if (shouldSuppressPreloadedNodeEvent(node.id, processId)) {
      return;
    }

    setDataForNode(node.id, processId, execution, {
      outputData: sanitizeInputsOrOutputs(outputs),
      status: { type: 'ok' },
      finishedAt: Date.now(),
      durationMs,
      ...getRecordedNodeTimingPatch(event, 'terminal'),
      splitRunDurationMs,
    });
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeExcluded = (event: ProcessEvents['nodeExcluded']) => {
    const { node, processId, inputs, outputs, reason, execution } = event;
    setDataForNode(node.id, processId, execution, {
      ...getNodeRunDebugData(node),
      inputData: sanitizeInputsOrOutputs(inputs),
      outputData: sanitizeInputsOrOutputs(outputs),
      ...getRecordedNodeTimingPatch(event, 'excluded'),
      status: { type: 'notRan', reason },
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
    setSelectedNodePageLatest(node.id, execution);
  };

  const onNodeError = (event: ProcessEvents['nodeError']) => {
    const { node, error, processId, durationMs, splitRunDurationMs, outputs, splitOutputs, execution } = event;
    setDataForNode(node.id, processId, execution, {
      status: { type: 'error', error: typeof error === 'string' ? error : error.toString() },
      finishedAt: Date.now(),
      durationMs,
      ...getRecordedNodeTimingPatch(event, 'terminal'),
      splitRunDurationMs,
      ...(outputs === undefined ? {} : { outputData: sanitizeInputsOrOutputs(outputs) }),
      ...(splitOutputs === undefined ? {} : { splitOutputData: sanitizeSplitOutputs(splitOutputs) }),
    });
    setSelectedNodePageLatest(node.id, execution);

    if (shouldToastAsyncBranchSafetyError(error)) {
      handleError(error, 'Graph execution error');
    }
  };

  const onPartialOutput = ({ node, outputs, index, processId, execution }: ProcessEvents['partialOutput']) => {
    const sanitizedOutputs = sanitizeInputsOrOutputs(outputs);
    const applied = setDataForNode(
      node.id,
      processId,
      execution,
      node.isSplitRun
        ? { splitOutputData: { [index]: sanitizedOutputs } }
        : { outputData: sanitizedOutputs },
      { ignoreIfTerminal: true },
    );
    if (applied) {
      setSelectedNodePageLatest(node.id, execution);
    }
  };

  const onNodeOutputsCleared = ({ node, processId, execution }: ProcessEvents['nodeOutputsCleared']) => {
    const refIdsToDelete: string[] = [];

    setLastRunData((prev) =>
      produce(prev, (draft) => {
        if (processId) {
          const index = draft[node.id]?.findIndex((process) => process.processId === processId);
          if (index !== undefined && index !== -1) {
            refIdsToDelete.push(...collectStoredRefIds(draft[node.id]![index]!.data));
            draft[node.id]!.splice(index, 1);
          }
        } else {
          refIdsToDelete.push(...(draft[node.id] ?? []).flatMap((process) => collectStoredRefIds(process.data)));
          delete draft[node.id];
        }
      }),
    );

    deleteStoredRefIds(dataRefs, refIdsToDelete);
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

    const refIdsToDelete: string[] = [];
    setLastRunData((previous) =>
      produce(previous, (draft) => {
        draft[data.nodeId] ??= [];
        let process = draft[data.nodeId]!.find((candidate) => candidate.processId === data.processId);
        if (!process) {
          process = {
            data: {},
            graphId: data.execution.graphId,
            graphRunId: data.execution.graphRunId,
            processId: data.processId,
            rootRunId: data.execution.rootRunId,
          };
          draft[data.nodeId]!.push(process);
        }
        const updated = upsertLLMChatOutputHistoryEntry(process.data, storedEntry);
        refIdsToDelete.push(...updated.replacedRefIds);
        process.data = updated.data;
      }),
    );
    deleteStoredRefIds(dataRefs, refIdsToDelete);
  };

  const appendAgentTraceEvent = (event: AgentTraceEvent) => {
    setLastRunData((prev) =>
      produce(prev, (draft) => {
        upsertAgentTraceEventForInvocation(draft, event);
      }),
    );
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

function getNodeRunDebugData(node: ProcessEvents['nodeStart']['node']) {
  if (node.type === 'code') {
    return {
      debugData: {
        codeSource: (node as CodeNode).data.code,
      },
    };
  }

  if (node.type === 'codeNew') {
    return {
      debugData: {
        codeSource: (node as CodeNewNode).data.code,
      },
    };
  }

  if (node.type === 'expression') {
    return {
      debugData: {
        expressionSource: (node as ExpressionNode).data.expression,
      },
    };
  }

  if (node.type === 'extractObjectPath') {
    return {
      debugData: {
        extractObjectPathSource: (node as ExtractObjectPathNode).data.path,
        extractObjectPathUsePathInput: (node as ExtractObjectPathNode).data.usePathInput,
      },
    };
  }

  if (node.type === 'jsFilter' || node.type === 'jsMap') {
    return {
      debugData: {
        jsListCallbackBodySource: (node as JSFilterNode | JSMapNode).data.callbackBody,
      },
    };
  }

  return {};
}
