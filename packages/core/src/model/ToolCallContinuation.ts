import type { ChatMessage } from './DataValue.js';
import type { StreamedFunctionCall } from './chat/streamChatResponse.js';
import type { DelegatedToolCallRecord } from './nodes/toolCallDelegation.js';

export type ToolCallContinuationResult = {
  message: ChatMessage;
  record: DelegatedToolCallRecord;
};

export type ToolCallContinuationRunner = (
  toolCalls: StreamedFunctionCall[],
  preToolMessage: string,
) => Promise<ToolCallContinuationResult[]>;

export type ToolCallContinuation = {
  run: ToolCallContinuationRunner;
  /** Restores ordinary downstream delegation when continuation stops on unresolved raw calls. */
  release: () => void;
};
