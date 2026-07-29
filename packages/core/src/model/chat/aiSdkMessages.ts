import type {
  ModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  UserContent,
  AssistantContent,
} from 'ai';
import type { ChatMessage, ChatMessageMessagePart } from '../DataValue.js';

async function partToUserContent(part: ChatMessageMessagePart): Promise<TextPart | ImagePart | FilePart> {
  if (typeof part === 'string') {
    return { type: 'text', text: part };
  }

  switch (part.type) {
    case 'image':
      return {
        type: 'image',
        image: part.data,
        mediaType: part.mediaType,
      };
    case 'url':
      return {
        type: 'image',
        image: new URL(part.url),
      };
    case 'document':
      return {
        type: 'file',
        data: part.data,
        mediaType: part.mediaType,
      };
  }
}

function stringifyParts(parts: ChatMessageMessagePart | ChatMessageMessagePart[]): string {
  const arr = Array.isArray(parts) ? parts : [parts];
  return arr
    .map((p) => {
      if (typeof p === 'string') return p;
      throw new Error(`Expected string content, got ${p.type}`);
    })
    .join('\n\n');
}

export async function rivetMessagesToAiSdk(messages: ChatMessage[]): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    switch (msg.type) {
      case 'system': {
        result.push({
          role: 'system',
          content: stringifyParts(msg.message),
        });
        break;
      }

      case 'developer': {
        // ModelMessage has no provider-neutral developer role.
        result.push({
          role: 'system',
          content: stringifyParts(msg.message),
        });
        break;
      }

      case 'user': {
        const parts = Array.isArray(msg.message) ? msg.message : [msg.message];

        if (parts.length === 1 && typeof parts[0] === 'string') {
          result.push({ role: 'user', content: parts[0] });
        } else {
          const content: UserContent = await Promise.all(parts.map(partToUserContent));
          result.push({ role: 'user', content });
        }
        break;
      }

      case 'assistant': {
        const textContent = stringifyParts(msg.message);
        const toolCalls = msg.function_calls ?? (msg.function_call ? [msg.function_call] : []);

        if (toolCalls.length === 0) {
          result.push({ role: 'assistant', content: textContent });
        } else {
          const content: AssistantContent = [];

          if (textContent) {
            content.push({ type: 'text', text: textContent });
          }

          for (const fc of toolCalls) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(fc.arguments);
            } catch {
              parsedArgs = {};
            }

            content.push({
              type: 'tool-call',
              toolCallId: fc.id ?? 'unknown_function_call',
              toolName: fc.name,
              input: parsedArgs,
            } satisfies ToolCallPart);
          }

          result.push({ role: 'assistant', content });
        }
        break;
      }

      case 'function': {
        const textContent = stringifyParts(msg.message);

        result.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.name,
              toolName: msg.toolName ?? msg.name,
              output: { type: 'text', value: textContent },
            } satisfies ToolResultPart,
          ],
        });
        break;
      }
    }
  }

  return result;
}
