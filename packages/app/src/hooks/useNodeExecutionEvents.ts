import { type ProcessEvents } from '@valerypopoff/rivet2-core';
import { type ExecutionDataFlowApi } from './useExecutionDataFlow';
import { nodeExecutionData } from './nodeExecutionData.js';
import { handleError } from '../utils/errorHandling';
import { shouldToastAsyncBranchSafetyError } from '../utils/graphExecutionErrorPresentation';
import { useExecutionSnapshotWriter } from './useExecutionSnapshotWriter.js';

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
  const writer = useExecutionSnapshotWriter();

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
    writer.event('nodeOutputsCleared', { node, processId, execution }, { policy: { selectProcessPage: false } });
    setSelectedNodePageLatest(node.id, execution);
  };

  const onLlmChatOutputSnapshot = (data: ProcessEvents['llmChatOutputSnapshot']) => {
    writer.event('llmChatOutputSnapshot', data);
  };

  const onLlmCallFinished = (data: ProcessEvents['llmCallFinished']) => {
    writer.event('llmCallFinished', data);
  };

  const onLlmProfileAttempt = (data: ProcessEvents['llmProfileAttempt']) => {
    writer.event('llmProfileAttempt', data);
  };

  const onToolCallFinished = (data: ProcessEvents['toolCallFinished']) => {
    writer.event('toolCallFinished', data);
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
