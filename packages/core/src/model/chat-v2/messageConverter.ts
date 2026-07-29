import type { FilePart, ImagePart, ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai';
import type { ChatMessage, ChatMessageMessagePart } from '../DataValue.js';
import type { ChatV2MessageList, ChatV2Provider, ChatV2ProviderOptions } from './chatV2Types.js';

type ChatV2MessageConversionOptions = {
  provider: ChatV2Provider;
  anthropicCacheControlTtl?: '5m' | '1h' | undefined;
};

function mergeProviderMetadata(
  base: ChatV2ProviderOptions | undefined,
  extra: ChatV2ProviderOptions | undefined,
): ChatV2ProviderOptions | undefined {
  if (base == null) {
    return extra;
  }

  if (extra == null) {
    return base;
  }

  return {
    ...base,
    ...extra,
    anthropic: {
      ...(base.anthropic ?? {}),
      ...(extra.anthropic ?? {}),
    },
    google: {
      ...(base.google ?? {}),
      ...(extra.google ?? {}),
    },
    openai: {
      ...(base.openai ?? {}),
      ...(extra.openai ?? {}),
    },
  };
}

function getAnthropicCacheMetadata(
  enabled: boolean,
  ttl: ChatV2MessageConversionOptions['anthropicCacheControlTtl'],
): ChatV2ProviderOptions | undefined {
  if (!enabled) {
    return undefined;
  }

  return {
    anthropic: {
      cacheControl: {
        type: 'ephemeral',
        ...(ttl ? { ttl } : {}),
      },
    },
  };
}

async function partToUserContent(
  part: ChatMessageMessagePart,
  options: ChatV2MessageConversionOptions,
): Promise<TextPart | ImagePart | FilePart> {
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
        filename: part.title?.trim() || undefined,
        providerOptions:
          options.provider === 'anthropic'
            ? {
                anthropic: {
                  ...(part.enableCitations ? { citations: { enabled: true } } : {}),
                  ...(part.title?.trim() ? { title: part.title.trim() } : {}),
                  ...(part.context?.trim() ? { context: part.context.trim() } : {}),
                },
              }
            : undefined,
      };
  }
}

function stringifyParts(parts: ChatMessage['message']): string {
  const arr = Array.isArray(parts) ? parts : [parts];
  return arr
    .map((p) => {
      if (typeof p === 'string') return p;
      throw new Error(`Expected string content, got ${p.type}`);
    })
    .join('\n\n');
}

function applyAnthropicCacheBreakpoint<T extends { providerOptions?: ChatV2ProviderOptions | undefined }>(
  parts: T[],
  enabled: boolean,
  ttl: ChatV2MessageConversionOptions['anthropicCacheControlTtl'],
): T[] {
  if (!enabled || parts.length === 0) {
    return parts;
  }

  const lastPart = parts[parts.length - 1];

  if (lastPart == null) {
    return parts;
  }

  lastPart.providerOptions = mergeProviderMetadata(lastPart.providerOptions, getAnthropicCacheMetadata(true, ttl));

  return parts;
}

export async function chatMessagesToModelMessages(
  messages: ChatMessage[],
  options: ChatV2MessageConversionOptions,
): Promise<ChatV2MessageList> {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    switch (msg.type) {
      case 'system': {
        result.push({
          role: 'system',
          content: stringifyParts(msg.message),
          providerOptions:
            options.provider === 'anthropic'
              ? getAnthropicCacheMetadata(!!msg.isCacheBreakpoint, options.anthropicCacheControlTtl)
              : undefined,
        });
        break;
      }

      case 'developer': {
        // AI SDK ModelMessage is provider-neutral and currently exposes only
        // `system` for instruction messages. OpenAI and OpenAI-compatible
        // transports restore the explicit role at the request-body boundary.
        // Providers without a developer role receive it as a system instruction.
        result.push({
          role: 'system',
          content: stringifyParts(msg.message),
          providerOptions:
            options.provider === 'anthropic'
              ? getAnthropicCacheMetadata(!!msg.isCacheBreakpoint, options.anthropicCacheControlTtl)
              : undefined,
        });
        break;
      }

      case 'user': {
        const parts = Array.isArray(msg.message) ? msg.message : [msg.message];

        if (parts.length === 1 && typeof parts[0] === 'string' && !msg.isCacheBreakpoint) {
          result.push({ role: 'user', content: parts[0] });
        } else {
          const content = await Promise.all(parts.map((part) => partToUserContent(part, options)));
          result.push({
            role: 'user',
            content: applyAnthropicCacheBreakpoint(
              content,
              options.provider === 'anthropic' && !!msg.isCacheBreakpoint,
              options.anthropicCacheControlTtl,
            ),
          });
        }
        break;
      }

      case 'assistant': {
        const textContent = stringifyParts(msg.message);
        const toolCalls = msg.function_calls ?? (msg.function_call ? [msg.function_call] : []);

        if (toolCalls.length === 0 && !msg.isCacheBreakpoint) {
          result.push({ role: 'assistant', content: textContent });
        } else {
          const content: Array<TextPart | ToolCallPart> = [];

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

          result.push({
            role: 'assistant',
            content: applyAnthropicCacheBreakpoint(
              content,
              options.provider === 'anthropic' && !!msg.isCacheBreakpoint,
              options.anthropicCacheControlTtl,
            ),
          });
        }
        break;
      }

      case 'function': {
        const textContent = stringifyParts(msg.message);
        const content: ToolResultPart[] = [
          {
            type: 'tool-result',
            toolCallId: msg.name,
            toolName: msg.toolName ?? msg.name,
            output: { type: 'text', value: textContent },
          },
        ];

        result.push({
          role: 'tool',
          content: applyAnthropicCacheBreakpoint(
            content,
            options.provider === 'anthropic' && !!msg.isCacheBreakpoint,
            options.anthropicCacheControlTtl,
          ),
        });
        break;
      }
    }
  }

  return result;
}
