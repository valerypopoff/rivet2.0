import {
  arrayizeDataValue,
  type ChatMessage,
  type ChatMessageMessagePart,
  type DataValue,
  isArrayDataValue,
  type Inputs,
  type Outputs,
} from '@valerypopoff/rivet2-core';
import { match } from 'ts-pattern';
import { entries } from './typeSafety.js';

export function sanitizeInputsOrOutputs<T extends Inputs | Outputs>(data: T): T {
  const sanitized: Partial<Record<keyof T, DataValue>> = {};

  for (const [key, value] of entries(data)) {
    sanitized[key as keyof T] = fixDataValueUint8Arrays(value) as DataValue;
  }

  return sanitized as T;
}

/** Applies the same transport-safe value normalization to each split result. */
export function sanitizeSplitOutputs<T extends Outputs>(splitOutputs: Record<number, T>): Record<number, T> {
  return Object.fromEntries(
    Object.entries(splitOutputs).map(([index, outputs]) => [Number(index), sanitizeInputsOrOutputs(outputs)]),
  ) as Record<number, T>;
}

export function fixDataValueUint8Arrays(value: DataValue | undefined): DataValue | undefined {
  if (!value) {
    return undefined;
  }

  if (isArrayDataValue(value)) {
    if (!Array.isArray(value.value)) {
      return value;
    }

    const arrayized = arrayizeDataValue(value);

    return {
      ...value,
      value: arrayized.map((item) => fixDataValueUint8Arrays(item)!.value),
    } as DataValue;
  }

  return match(value)
    .with({ type: 'binary' }, (binaryValue): DataValue => {
      const fixedData = fixUint8ArrayLike(binaryValue.value);
      return fixedData ? { ...binaryValue, value: fixedData } : binaryValue;
    })
    .with({ type: 'audio' }, (audioValue): DataValue => {
      const fixedData = isPlainRecord(audioValue.value) ? fixUint8ArrayLike(audioValue.value.data) : undefined;
      return fixedData ? { ...audioValue, value: { ...audioValue.value, data: fixedData } } : audioValue;
    })
    .with({ type: 'document' }, (documentValue): DataValue => {
      const fixedData = isPlainRecord(documentValue.value) ? fixUint8ArrayLike(documentValue.value.data) : undefined;
      return fixedData ? { ...documentValue, value: { ...documentValue.value, data: fixedData } } : documentValue;
    })
    .with({ type: 'image' }, (imageValue): DataValue => {
      const fixedData = isPlainRecord(imageValue.value) ? fixUint8ArrayLike(imageValue.value.data) : undefined;
      return fixedData ? { ...imageValue, value: { ...imageValue.value, data: fixedData } } : imageValue;
    })
    .with({ type: 'chat-message' }, (chatMessageValue): DataValue => {
      if (!isChatMessageLike(chatMessageValue.value)) {
        return chatMessageValue;
      }

      return {
        ...chatMessageValue,
        value: {
          ...chatMessageValue.value,
          message: Array.isArray(chatMessageValue.value.message)
            ? chatMessageValue.value.message.map((part) => fixChatMessagePartUint8Arrays(part))
            : fixChatMessagePartUint8Arrays(chatMessageValue.value.message),
        },
      };
    })
    .otherwise((otherValue): DataValue => otherValue);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function fixUint8ArrayLike(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value) || isPlainRecord(value)) {
    return Uint8Array.from(Object.values(value));
  }

  return undefined;
}

function isChatMessageLike(value: unknown): value is ChatMessage {
  return isPlainRecord(value) && typeof value.type === 'string' && 'message' in value;
}

function fixChatMessagePartUint8Arrays(part: ChatMessageMessagePart): ChatMessageMessagePart {
  if (typeof part === 'string' || !isPlainRecord(part)) {
    return part;
  }

  if (part.type !== 'document') {
    return part as ChatMessageMessagePart;
  }

  const fixedData = fixUint8ArrayLike(part.data);

  return fixedData ? ({ ...part, data: fixedData } as ChatMessageMessagePart) : (part as ChatMessageMessagePart);
}
