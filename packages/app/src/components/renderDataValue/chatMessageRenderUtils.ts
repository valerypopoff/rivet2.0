import type {
  AssistantChatMessage,
  AssistantChatMessageFunctionCall,
  FunctionResponseChatMessage,
} from '@valerypopoff/rivet2-core';

export type RenderableAssistantFunctionCall =
  | {
      type: 'single';
      functionCall: AssistantChatMessageFunctionCall;
    }
  | {
      type: 'multiple';
      functionCalls: AssistantChatMessageFunctionCall[];
    };

export function getRenderableAssistantFunctionCall(
  message: AssistantChatMessage,
): RenderableAssistantFunctionCall | undefined {
  if (message.function_calls?.length) {
    return {
      type: 'multiple',
      functionCalls: message.function_calls,
    };
  }

  if (message.function_call) {
    return {
      type: 'single',
      functionCall: message.function_call,
    };
  }

  return undefined;
}

export function getFunctionResponseDisplayLabel(
  message: Partial<Pick<FunctionResponseChatMessage, 'name' | 'toolName'>>,
): string {
  const toolName = typeof message.toolName === 'string' ? message.toolName.trim() : '';
  const toolCallId = typeof message.name === 'string' ? message.name.trim() : '';

  if (toolName && toolCallId && toolCallId !== toolName) {
    return `${toolName} (tool call ID: ${toolCallId})`;
  }

  return toolName || toolCallId || 'unknown';
}
