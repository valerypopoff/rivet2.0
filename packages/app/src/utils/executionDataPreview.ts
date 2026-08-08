import {
  type ChatMessage,
  type ChatMessageMessagePart,
  type DataValue,
  getScalarTypeOf,
  isArrayDataType,
} from '@valerypopoff/rivet2-core';
import { match } from 'ts-pattern';
import type { StoredDataPreview } from '../state/dataFlow.js';
import { stringifyAnyJsonLikeForDisplay } from './dataValuePayloads.js';
import {
  COMPACT_PREVIEW_MAX_CHARS,
  COMPACT_PREVIEW_MAX_ITEMS,
  COMPACT_PREVIEW_MAX_LINES,
  REF_STORAGE_THRESHOLD_CHARS,
} from './outputStorageLimits.js';
import { buildTextPreviewExcerpt } from './textPreview.js';

export type StorageDecision =
  | {
      storage: 'inline';
    }
  | {
      storage: 'ref';
      preview: StoredDataPreview;
      sizeHint?: number;
    };

export function getStorageDecision(value: DataValue): StorageDecision {
  if (shouldAlwaysStoreByRef(value)) {
    return {
      storage: 'ref',
      preview: buildSummaryPreview(value),
      sizeHint: getDataValueSizeHint(value),
    };
  }

  switch (value.type) {
    case 'string': {
      if (typeof value.value !== 'string') {
        return { storage: 'inline' };
      }

      return value.value.length > REF_STORAGE_THRESHOLD_CHARS
        ? {
            storage: 'ref',
            preview: buildTextPreview(value.value),
            sizeHint: value.value.length,
          }
        : { storage: 'inline' };
    }
    case 'string[]': {
      if (!Array.isArray(value.value)) {
        return { storage: 'inline' };
      }

      const totalChars = value.value.reduce(
        (acc, current) => acc + (typeof current === 'string' ? current.length : 0),
        0,
      );
      return totalChars > REF_STORAGE_THRESHOLD_CHARS
        ? {
            storage: 'ref',
            preview: buildTextPreview(
              value.value
                .filter((current): current is string => typeof current === 'string')
                .slice(0, COMPACT_PREVIEW_MAX_ITEMS)
                .join('\n'),
            ),
            sizeHint: totalChars,
          }
        : { storage: 'inline' };
    }
    case 'object':
    case 'object[]': {
      const stringified = stringifyForPreview(value.value);
      return stringified.length > REF_STORAGE_THRESHOLD_CHARS
        ? {
            storage: 'ref',
            preview: buildJsonPreview(stringified, Array.isArray(value.value) ? value.value.length : undefined),
            sizeHint: stringified.length,
          }
        : { storage: 'inline' };
    }
    case 'any':
    case 'any[]': {
      return getAnyStorageDecision(value);
    }
    default: {
      if (isArrayDataType(value.type)) {
        // Structured, non-media arrays can still have a useful compact JSON
        // preview. Do not collapse them to only their data type: Run Activity
        // deliberately does not restore refs, so that would hide the actual
        // node output even though a safe excerpt can be retained here.
        const serialized = stringifyAnyJsonLikeForDisplay(value.value);
        return serialized.length > REF_STORAGE_THRESHOLD_CHARS
          ? {
              storage: 'ref',
              preview: buildJsonPreview(serialized, Array.isArray(value.value) ? value.value.length : undefined),
              sizeHint: serialized.length,
            }
          : { storage: 'inline' };
      }

      return { storage: 'inline' };
    }
  }
}

function getAnyStorageDecision(value: Extract<DataValue, { type: 'any' | 'any[]' }>): StorageDecision {
  if (typeof value.value === 'string') {
    return value.value.length > REF_STORAGE_THRESHOLD_CHARS
      ? {
          storage: 'ref',
          preview: buildTextPreview(value.value),
          sizeHint: value.value.length,
        }
      : { storage: 'inline' };
  }

  if (Array.isArray(value.value) || isPlainRecord(value.value)) {
    const stringified = Array.isArray(value.value)
      ? stringifyAnyJsonLikeForDisplay(value.value)
      : stringifyForPreview(value.value);
    return stringified.length > REF_STORAGE_THRESHOLD_CHARS
      ? {
          storage: 'ref',
          preview: buildJsonPreview(stringified, Array.isArray(value.value) ? value.value.length : undefined),
          sizeHint: stringified.length,
        }
      : { storage: 'inline' };
  }

  return { storage: 'inline' };
}

function shouldAlwaysStoreByRef(value: DataValue): boolean {
  const scalarType = getScalarTypeOf(value.type);
  const isFunctionValue = value.type.startsWith('fn<');

  if (isFunctionValue) {
    return (
      scalarType === 'audio' ||
      scalarType === 'binary' ||
      scalarType === 'image' ||
      scalarType === 'document' ||
      scalarType === 'chat-message'
    );
  }

  return canBuildSummaryPreview(value);
}

function canBuildSummaryPreview(value: DataValue): boolean {
  return match(value)
    .with({ type: 'binary' }, (binaryValue) => hasByteLength(binaryValue.value))
    .with(
      { type: 'binary[]' },
      (binaryValues) => Array.isArray(binaryValues.value) && binaryValues.value.every(hasByteLength),
    )
    .with({ type: 'image' }, (imageValue) => hasMediaByteLength(imageValue.value))
    .with(
      { type: 'image[]' },
      (imageValues) => Array.isArray(imageValues.value) && imageValues.value.every(hasMediaByteLength),
    )
    .with({ type: 'audio' }, (audioValue) => hasMediaByteLength(audioValue.value))
    .with(
      { type: 'audio[]' },
      (audioValues) => Array.isArray(audioValues.value) && audioValues.value.every(hasMediaByteLength),
    )
    .with({ type: 'document' }, (documentValue) => hasMediaByteLength(documentValue.value))
    .with(
      { type: 'document[]' },
      (documentValues) => Array.isArray(documentValues.value) && documentValues.value.every(hasMediaByteLength),
    )
    .with({ type: 'chat-message' }, (chatMessageValue) => isChatMessageLike(chatMessageValue.value))
    .with(
      { type: 'chat-message[]' },
      (chatMessageValues) => Array.isArray(chatMessageValues.value) && chatMessageValues.value.every(isChatMessageLike),
    )
    .otherwise(() => false);
}

function hasByteLength(value: unknown): value is { byteLength: number } {
  return isPlainRecord(value) && typeof value.byteLength === 'number';
}

function hasMediaByteLength(value: unknown): value is { data: { byteLength: number } } {
  return isPlainRecord(value) && hasByteLength(value.data);
}

function isChatMessageLike(value: unknown): value is ChatMessage {
  return isPlainRecord(value) && typeof value.type === 'string' && 'message' in value;
}

function buildTextPreview(text: string): StoredDataPreview {
  return {
    kind: 'text',
    excerpt: createExcerpt(text, COMPACT_PREVIEW_MAX_CHARS, COMPACT_PREVIEW_MAX_LINES),
    totalChars: text.length,
    lineCount: text.split('\n').length,
    encodedHint: getEncodedHint(text),
  };
}

function buildJsonPreview(text: string, itemCount?: number): StoredDataPreview {
  return {
    kind: 'json',
    excerpt: createExcerpt(text, COMPACT_PREVIEW_MAX_CHARS, COMPACT_PREVIEW_MAX_LINES),
    totalChars: text.length,
    itemCount,
  };
}

function buildSummaryPreview(value: DataValue): StoredDataPreview {
  return match(value)
    .with(
      { type: 'binary' },
      (binaryValue): StoredDataPreview => ({
        kind: 'summary',
        label: 'Binary',
        totalBytes: binaryValue.value.byteLength,
      }),
    )
    .with(
      { type: 'binary[]' },
      (binaryValues): StoredDataPreview => ({
        kind: 'summary',
        label: 'Binary Array',
        totalBytes: binaryValues.value.reduce((acc, current) => acc + current.byteLength, 0),
        itemCount: binaryValues.value.length,
      }),
    )
    .with(
      { type: 'image' },
      (imageValue): StoredDataPreview => ({
        kind: 'summary',
        label: `Image (${imageValue.value.mediaType})`,
        totalBytes: imageValue.value.data.byteLength,
      }),
    )
    .with(
      { type: 'image[]' },
      (imageValues): StoredDataPreview => ({
        kind: 'summary',
        label: 'Image Array',
        totalBytes: imageValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
        itemCount: imageValues.value.length,
      }),
    )
    .with(
      { type: 'audio' },
      (audioValue): StoredDataPreview => ({
        kind: 'summary',
        label: `Audio (${audioValue.value.mediaType ?? 'unknown'})`,
        totalBytes: audioValue.value.data.byteLength,
      }),
    )
    .with(
      { type: 'audio[]' },
      (audioValues): StoredDataPreview => ({
        kind: 'summary',
        label: 'Audio Array',
        totalBytes: audioValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
        itemCount: audioValues.value.length,
      }),
    )
    .with(
      { type: 'document' },
      (documentValue): StoredDataPreview => ({
        kind: 'summary',
        label: `Document (${documentValue.value.mediaType})`,
        totalBytes: documentValue.value.data.byteLength,
      }),
    )
    .with(
      { type: 'document[]' },
      (documentValues): StoredDataPreview => ({
        kind: 'summary',
        label: 'Document Array',
        totalBytes: documentValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
        itemCount: documentValues.value.length,
      }),
    )
    .with(
      { type: 'chat-message' },
      (chatMessageValue): StoredDataPreview => buildChatMessagePreview(chatMessageValue.value),
    )
    .with(
      { type: 'chat-message[]' },
      (chatMessageValues): StoredDataPreview => buildChatMessagesPreview(chatMessageValues.value),
    )
    .otherwise(
      (): StoredDataPreview => ({
        kind: 'summary',
        label: value.type,
        totalBytes: getDataValueSizeHint(value),
        itemCount: Array.isArray((value as { value?: unknown[] }).value)
          ? (value as { value: unknown[] }).value.length
          : undefined,
      }),
    );
}

function buildChatMessagePreview(message: ChatMessage): StoredDataPreview {
  // Keep the existing preview-only path for a large function result. Output
  // renderers intentionally treat that as a textual result rather than a
  // role-aware chat-message body.
  const functionResultText = getFunctionResultText(message);
  if (functionResultText != null && functionResultText.length > REF_STORAGE_THRESHOLD_CHARS) {
    return buildTextPreview(functionResultText);
  }

  const excerpt = getChatMessageExcerpt(message);
  return {
    kind: 'summary',
    label: `Chat Message (${message.type})`,
    ...(excerpt == null
      ? {}
      : { excerpt: createExcerpt(excerpt, COMPACT_PREVIEW_MAX_CHARS, COMPACT_PREVIEW_MAX_LINES) }),
    totalBytes: getChatMessageSize(message),
  };
}

function buildChatMessagesPreview(messages: ChatMessage[]): StoredDataPreview {
  const functionResultTexts = messages.map(getFunctionResultText);
  if (functionResultTexts.every((text): text is string => text !== undefined)) {
    const text = functionResultTexts.join('\n');
    if (text.length > REF_STORAGE_THRESHOLD_CHARS) {
      return buildTextPreview(text);
    }
  }

  const excerpt = messages
    .map((message) => {
      const messageExcerpt = getChatMessageExcerpt(message);
      return messageExcerpt == null ? undefined : `${message.type}: ${messageExcerpt}`;
    })
    .filter((value): value is string => value != null)
    .join('\n');

  return {
    kind: 'summary',
    label: 'Chat Message Array',
    ...(excerpt === ''
      ? {}
      : { excerpt: createExcerpt(excerpt, COMPACT_PREVIEW_MAX_CHARS, COMPACT_PREVIEW_MAX_LINES) }),
    totalBytes: messages.reduce((acc, current) => acc + getChatMessageSize(current), 0),
    itemCount: messages.length,
  };
}

/**
 * Produces a safe, bounded-text precursor for history previews without
 * restoring the ref payload. Message roles and non-text parts remain visible
 * enough to make the preview useful, while image/document bytes never enter
 * the metadata-only Run Activity projection.
 */
function getChatMessageExcerpt(message: ChatMessage): string | undefined {
  const parts = Array.isArray(message.message) ? message.message : [message.message];
  const content = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isPlainRecord(part) || typeof part.type !== 'string') return '[Unsupported message content]';

      // Treat this as a runtime record after validation rather than relying on
      // the static message-part union: stale/remote histories can contain an
      // unknown content type, which should produce a compact fallback instead
      // of breaking the activity drawer.
      const record = part as Record<string, unknown>;
      const contentType = record.type;

      switch (contentType) {
        case 'url':
          return typeof record.url === 'string' ? record.url : '[URL]';
        case 'image':
          return `[Image: ${typeof record.mediaType === 'string' ? record.mediaType : 'unknown'}]`;
        case 'document': {
          const title = typeof record.title === 'string' && record.title.trim() ? record.title : undefined;
          const mediaType = typeof record.mediaType === 'string' ? record.mediaType : 'unknown';
          return title ? `[Document: ${title}]` : `[Document: ${mediaType}]`;
        }
        default:
          return `[Unsupported message content: ${contentType}]`;
      }
    })
    .filter((part): part is string => part != null && part !== '');

  if (message.type !== 'assistant') {
    return content.length === 0 ? undefined : content.join('\n');
  }

  const toolCalls =
    Array.isArray(message.function_calls) && message.function_calls.length > 0
      ? message.function_calls
      : message.function_call == null
        ? []
        : [message.function_call];
  const toolCallText = toolCalls.map((call) =>
    typeof call?.name === 'string' && call.name.trim() ? `[Tool call: ${call.name}]` : '[Tool call]',
  );
  const excerpt = [...content, ...toolCallText].join('\n');
  return excerpt === '' ? undefined : excerpt;
}

function getFunctionResultText(message: ChatMessage): string | undefined {
  return message.type === 'function' && typeof message.message === 'string' ? message.message : undefined;
}

function getDataValueSizeHint(value: DataValue): number {
  return match(value)
    .with({ type: 'image' }, (imageValue) => imageValue.value.data.byteLength)
    .with({ type: 'binary' }, (binaryValue) => binaryValue.value.byteLength)
    .with({ type: 'audio' }, (audioValue) => audioValue.value.data.byteLength)
    .with({ type: 'document' }, (documentValue) => documentValue.value.data.byteLength)
    .with({ type: 'image[]' }, (imageValues) =>
      imageValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
    )
    .with({ type: 'binary[]' }, (binaryValues) =>
      binaryValues.value.reduce((acc, current) => acc + current.byteLength, 0),
    )
    .with({ type: 'audio[]' }, (audioValues) =>
      audioValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
    )
    .with({ type: 'document[]' }, (documentValues) =>
      documentValues.value.reduce((acc, current) => acc + current.data.byteLength, 0),
    )
    .with({ type: 'chat-message' }, (chatMessageValue) => getChatMessageSize(chatMessageValue.value))
    .with({ type: 'chat-message[]' }, (chatMessageValues) =>
      chatMessageValues.value.reduce((acc, current) => acc + getChatMessageSize(current), 0),
    )
    .with({ type: 'string' }, (stringValue) => (typeof stringValue.value === 'string' ? stringValue.value.length : 0))
    .with({ type: 'string[]' }, (stringValues) =>
      Array.isArray(stringValues.value)
        ? stringValues.value.reduce((acc, current) => acc + (typeof current === 'string' ? current.length : 0), 0)
        : 0,
    )
    .otherwise((otherValue) => stringifyForPreview(otherValue.value).length);
}

function createExcerpt(text: string, maxChars: number, maxLines: number): string {
  return buildTextPreviewExcerpt(text, {
    maxChars,
    maxLines,
  }).text;
}

function getEncodedHint(text: string): 'base64' | 'data-uri' | undefined {
  if (text.startsWith('data:') && text.includes(';base64,')) {
    return 'data-uri';
  }

  const compact = text.replace(/\s+/g, '');
  if (
    compact.length > 256 &&
    compact.length % 4 === 0 &&
    /^[A-Za-z0-9+/=]+$/.test(compact) &&
    !compact.includes('{') &&
    !compact.includes('}')
  ) {
    return 'base64';
  }

  return undefined;
}

function stringifyForPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function getChatMessageSize(value: ChatMessage): number {
  const parts = Array.isArray(value.message) ? value.message : [value.message];

  return parts.reduce((acc, part) => acc + getChatMessagePartSize(part), 0);
}

function getChatMessagePartSize(part: ChatMessageMessagePart): number {
  if (typeof part === 'string') {
    return part.length;
  }

  if (!isPlainRecord(part)) {
    return 0;
  }

  switch (part.type) {
    case 'document':
    case 'image':
      return hasByteLength(part.data) ? part.data.byteLength : 0;
    case 'url':
      return typeof part.url === 'string' ? part.url.length : 0;
    default:
      return 0;
  }
}
