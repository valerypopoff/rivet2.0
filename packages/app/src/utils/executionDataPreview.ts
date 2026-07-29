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
        const serialized = stringifyForPreview(value.value);
        return serialized.length > REF_STORAGE_THRESHOLD_CHARS
          ? {
              storage: 'ref',
              preview: buildSummaryPreview(value),
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
  const functionResultText = getFunctionResultText(message);
  if (functionResultText && functionResultText.length > REF_STORAGE_THRESHOLD_CHARS) {
    return buildTextPreview(functionResultText);
  }

  return {
    kind: 'summary',
    label: `Chat Message (${message.type})`,
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

  return {
    kind: 'summary',
    label: 'Chat Message Array',
    totalBytes: messages.reduce((acc, current) => acc + getChatMessageSize(current), 0),
    itemCount: messages.length,
  };
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
