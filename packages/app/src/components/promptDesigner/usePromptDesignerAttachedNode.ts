import { useEffect } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { promptDesignerAttachedChatNodeState, promptDesignerConfigurationState } from '../../state/promptDesigner.js';
import { graphState, nodesByIdState } from '../../state/graph.js';
import { projectState } from '../../state/savedGraphs.js';
import { lastRunDataByNodeState } from '../../state/dataFlow.js';
import { type LLMChatV2Node, type Inputs, getChatNodeMessages } from '@valerypopoff/rivet2-core';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { tryRestoreStoredPortMap } from '../../utils/executionDataReaders.js';
import { handleError } from '../../utils/errorHandling.js';

const lastPromptDesignerAttachedNodeState = atom<string | undefined>(undefined);

export const usePromptDesignerAttachedNode = ({
  setMessages,
}: {
  setMessages: (state: { messages: ReturnType<typeof getChatNodeMessages>['messages'] }) => void;
}) => {
  const attachedNodeId = useAtomValue(promptDesignerAttachedChatNodeState);
  const nodesById = useAtomValue(nodesByIdState);
  const projectId = useAtomValue(projectState).metadata.id;
  const graphId = useAtomValue(graphState).metadata?.id;
  const nodeOutput = useAtomValue(lastRunDataByNodeState);
  const [config, setConfig] = useAtom(promptDesignerConfigurationState);
  const [lastPromptDesignerAttachedNode, setLastPromptDesignerAttachedNode] = useAtom(
    lastPromptDesignerAttachedNodeState,
  );
  const dataRefs = useDataRefs();

  const candidate = attachedNodeId?.nodeId ? nodesById[attachedNodeId.nodeId] : undefined;
  const attachedNode = candidate?.type === 'llmChatV2' ? (candidate as LLMChatV2Node) : undefined;
  const attachmentKey = attachedNode
    ? JSON.stringify([projectId, graphId, attachedNode.id, attachedNodeId?.processId])
    : undefined;

  useEffect(() => {
    if (!attachedNode || lastPromptDesignerAttachedNode === attachmentKey) {
      return;
    }

    const { data } = attachedNode;
    setConfig({ data: { ...data, configurationMode: 'inline', useToolCalling: false, autoContinueToolCalls: false } });
    // A missing or unreadable run must not retain another attachment's prompts.
    setMessages({ messages: [] });

    const nodeDataForAttachedNode = attachedNodeId ? nodeOutput[attachedNodeId.nodeId] : undefined;
    const nodeDataForAttachedNodeProcess = attachedNodeId
      ? nodeDataForAttachedNode?.find((run) => run.processId === attachedNodeId.processId)?.data
      : undefined;

    if (nodeDataForAttachedNodeProcess?.inputData) {
      try {
        const inputData =
          (tryRestoreStoredPortMap(nodeDataForAttachedNodeProcess.inputData, dataRefs) as Inputs | undefined) ?? {};
        const { messages } = getChatNodeMessages(inputData);
        setMessages({ messages });
      } catch (error) {
        handleError(error, 'Failed to load prompt designer input data');
      }
    }

    setLastPromptDesignerAttachedNode(attachmentKey);
  }, [
    attachedNode,
    attachedNodeId,
    attachmentKey,
    dataRefs,
    lastPromptDesignerAttachedNode,
    nodeOutput,
    setConfig,
    setLastPromptDesignerAttachedNode,
    setMessages,
  ]);

  return {
    attachedNode,
    attachedNodeId,
    attachmentKey,
    config,
    setConfig,
  };
};
