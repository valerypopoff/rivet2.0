import { atom } from 'jotai';
import {
  createLLMChatV2NodeData,
  type ChatMessage,
  type LLMChatV2NodeData,
  type NodeId,
  type ProcessId,
} from '@valerypopoff/rivet2-core';

export type PromptDesignerMessagesState = {
  messages: ChatMessage[];
};

export const promptDesignerMessagesState = atom<PromptDesignerMessagesState>({
  messages: [],
});

export type PromptDesignerResponseState = {
  response?: string;
};

export const promptDesignerResponseState = atom<PromptDesignerResponseState>({});

export type PromptDesignerConfigurationState = {
  /**
   * Prompt Designer previews the same current LLM Chat implementation that a
   * graph executes. Repeated evaluation belongs to Evaluations; this is only
   * the editable, one-off preview configuration.
   */
  data: LLMChatV2NodeData;
};

export const promptDesignerConfigurationState = atom<PromptDesignerConfigurationState>({
  data: createLLMChatV2NodeData(),
});

export const promptDesignerAttachedChatNodeState = atom<
  | {
      nodeId: NodeId;
      processId: ProcessId;
    }
  | undefined
>(undefined);
