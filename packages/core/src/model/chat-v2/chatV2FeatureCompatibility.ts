import { isChatV2StructuredResponseFormat, type ChatV2StructuredResponseFormat } from './chatV2ResponseFormat.js';
import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';

export type LLMChatV2StructuredResponseFormat = ChatV2StructuredResponseFormat;

export const LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY = {
  title: '"Tool use" conflicts with "Structured outputs"',
  paragraphs: [
    '"Tool use" and "Structured outputs" cannot be used at the same time.',
    'Use "Tool use" with Default/Text response format, or turn "Tool use" off before choosing JSON object/JSON schema.',
  ],
} as const;

type LLMChatV2ToolResponseFormatData = Pick<LLMChatV2NodeData, 'useToolCalling' | 'responseFormat'>;

export function isLLMChatV2StructuredResponseFormat(
  responseFormat: unknown,
): responseFormat is LLMChatV2StructuredResponseFormat {
  return isChatV2StructuredResponseFormat(responseFormat);
}

export function hasLLMChatV2ToolResponseFormatConflict(data: LLMChatV2ToolResponseFormatData): boolean {
  return !!data.useToolCalling && isLLMChatV2StructuredResponseFormat(data.responseFormat);
}

export function createsLLMChatV2ToolResponseFormatConflictForEdit(
  previousData: LLMChatV2ToolResponseFormatData,
  nextData: LLMChatV2ToolResponseFormatData,
): boolean {
  return hasLLMChatV2ToolResponseFormatConflict(nextData) && !hasLLMChatV2ToolResponseFormatConflict(previousData);
}
