import type { ChatMessage, ParsedAssistantChatMessageFunctionCall } from '../DataValue.js';
import type { DelegatedToolCallRecord } from '../nodes/toolCallDelegation.js';

/** Provider/tool boundary codec shared by internal and connected delegation. */
export function normalizeToolCall(input: unknown): ParsedAssistantChatMessageFunctionCall {
  if (Array.isArray(input)) {
    if (input.length !== 1) {
      throw new Error(
        `Delegate Tool Call expected a single tool call, but received ${input.length}. Use Run per item or select one tool call before delegating.`,
      );
    }
    return normalizeToolCall(input[0]);
  }
  if (typeof input !== 'object' || input == null) {
    throw new Error('Delegate Tool Call expected a tool call object.');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('Delegate Tool Call expected the tool call to include a name.');
  }
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (raw.arguments == null) return { id, name: raw.name, arguments: {} };
  if (typeof raw.arguments === 'string') {
    try {
      const parsed = JSON.parse(raw.arguments);
      if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
        return { id, name: raw.name, arguments: parsed as Record<string, unknown> };
      }
    } catch {
      // Fall through to the explicit handler-facing error.
    }
    throw new Error(`Delegate Tool Call expected "${raw.name}" arguments to be a JSON object.`);
  }
  if (typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)) {
    return { id, name: raw.name, arguments: raw.arguments as Record<string, unknown> };
  }
  throw new Error(`Delegate Tool Call expected "${raw.name}" arguments to be an object.`);
}

export function createToolResultMessage(toolCall: ParsedAssistantChatMessageFunctionCall, output: string): ChatMessage {
  return { type: 'function', message: output, name: toolCall.id ?? '', toolName: toolCall.name };
}

export function createDelegatedToolCallRecord(
  toolCall: ParsedAssistantChatMessageFunctionCall,
  output: string,
  executionTimeMs?: number,
): DelegatedToolCallRecord {
  return {
    delegatedToolCall: true,
    name: toolCall.name,
    arguments: toolCall.arguments,
    id: toolCall.id,
    output,
    ...(executionTimeMs == null ? {} : { executionTimeMs }),
    message: createToolResultMessage(toolCall, output),
  };
}

export function stringifyToolResult(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output) ?? String(output);
}
