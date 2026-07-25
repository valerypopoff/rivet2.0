import {
  type ChatMessage,
  type DataType,
  type DataValue,
  type GetDataValue,
  type ScalarDataType,
  type ScalarOrArrayDataValue,
  getScalarTypeOf,
  isArrayDataType,
  isArrayDataValue,
  isFunctionDataType,
  isScalarDataType,
  unwrapDataValue,
} from '../model/DataValue.js';
import { expectTypeOptional } from './expectType.js';
import type { GraphId } from '../index.js';
import {
  normalizeKnowledgeDocument,
  normalizeKnowledgeEvidence,
  normalizeKnowledgeSourceReference,
} from '../integrations/KnowledgeStoreValidation.js';
import { normalizeLLMProfileValue } from '../model/chat-v2/llmProfile.js';

type ScalarCoercer = (value: ScalarOrArrayDataValue | undefined) => unknown;

type ScalarCoercionRule = {
  readonly coerce?: ScalarCoercer;
  readonly canAttempt: (from: DataType) => boolean;
};

type ScalarCoercionRuleRegistry = {
  readonly [T in ScalarDataType]: ScalarCoercionRule;
};

function isValidatedObjectValueType(type: DataType): boolean {
  return (
    type === 'knowledge-source' ||
    type === 'knowledge-document' ||
    type === 'knowledge-evidence' ||
    type === 'llm-config'
  );
}

function canAttemptGeneralCoercion(from: DataType, to: DataType): boolean {
  return !isValidatedObjectValueType(from) || to === 'object' || to === 'string';
}

function generalScalarRule(target: ScalarDataType, coerce?: ScalarCoercer): ScalarCoercionRule {
  return {
    ...(coerce ? { coerce } : {}),
    canAttempt: (from) => canAttemptGeneralCoercion(from, target),
  };
}

function sameTypeOrObjectScalarRule(target: ScalarDataType, coerce?: ScalarCoercer): ScalarCoercionRule {
  return {
    ...(coerce ? { coerce } : {}),
    canAttempt: (from) => from === target || from === 'object',
  };
}

/**
 * The single scalar coercion policy used by both runtime conversion and
 * type-level port compatibility. Array, function, and `any` wrappers are
 * handled once around this registry because their behavior is structural.
 */
const scalarCoercionRules: ScalarCoercionRuleRegistry = {
  any: {
    canAttempt: () => true,
  },
  boolean: generalScalarRule('boolean', coerceToBoolean),
  string: generalScalarRule('string', coerceToString),
  number: generalScalarRule('number', coerceToNumber),
  date: generalScalarRule('date'),
  time: generalScalarRule('time'),
  datetime: generalScalarRule('datetime'),
  'chat-message': generalScalarRule('chat-message', coerceToChatMessage),
  'control-flow-excluded': generalScalarRule('control-flow-excluded'),
  object: generalScalarRule('object', coerceToObject),
  'gpt-function': {
    canAttempt: (from) => from === 'object',
  },
  vector: generalScalarRule('vector'),
  image: sameTypeOrObjectScalarRule('image'),
  binary: sameTypeOrObjectScalarRule('binary', coerceToBinary),
  audio: sameTypeOrObjectScalarRule('audio'),
  'graph-reference': generalScalarRule('graph-reference', coerceToGraphReference),
  'knowledge-source': sameTypeOrObjectScalarRule('knowledge-source', (value) =>
    coerceValidatedObjectValue(value, normalizeKnowledgeSourceReference),
  ),
  'knowledge-document': sameTypeOrObjectScalarRule('knowledge-document', (value) =>
    coerceValidatedObjectValue(value, normalizeKnowledgeDocument),
  ),
  'knowledge-evidence': sameTypeOrObjectScalarRule('knowledge-evidence', (value) =>
    coerceValidatedObjectValue(value, normalizeKnowledgeEvidence),
  ),
  'llm-config': sameTypeOrObjectScalarRule('llm-config', (value) =>
    coerceValidatedObjectValue(value, normalizeLLMProfileValue),
  ),
  document: generalScalarRule('document'),
};

export function coerceTypeOptional<T extends DataType>(
  wrapped: DataValue | undefined,
  type: T,
): GetDataValue<T>['value'] | undefined {
  if (wrapped && isFunctionDataType(type)) {
    return expectTypeOptional(wrapped, type) as GetDataValue<T>['value'] | undefined;
  }

  const value = wrapped ? unwrapDataValue(wrapped) : undefined;

  // Coerce 'true' to [true] for example
  if (isArrayDataType(type) && !isArrayDataValue(value)) {
    const coerced = coerceTypeOptional(value, getScalarTypeOf(type));
    if (coerced === undefined) {
      return undefined;
    }

    const coercedArray = [coerced] as unknown;
    // @ts-expect-error Generic T is not narrowed to its array subtype within this runtime-guarded branch.
    return coercedArray as GetDataValue<T>['value'];
  }

  // Preserve arrays whose runtime shape is carried by an any/object wrapper,
  // or coerce each item when the scalar families differ.
  if (isArrayDataType(type) && isArrayDataValue(value)) {
    if (getScalarTypeOf(type) === getScalarTypeOf(value.type)) {
      // @ts-expect-error Generic T is not narrowed to its array subtype within this runtime-guarded branch.
      return value.value as unknown as GetDataValue<T>['value'];
    }

    const coercedArray = value.value.map((v) =>
      coerceTypeOptional({ type: getScalarTypeOf(value.type), value: v } as DataValue, getScalarTypeOf(type)),
    ) as unknown;

    // @ts-expect-error Generic T is not narrowed to its array subtype within this runtime-guarded branch.
    return coercedArray as GetDataValue<T>['value'];
  }

  const scalarRule = isScalarDataType(type) ? scalarCoercionRules[type] : undefined;
  const result = scalarRule?.coerce ? scalarRule.coerce(value) : coerceWithoutSpecializedRule(value, type);

  return result as GetDataValue<T>['value'] | undefined;
}

function coerceWithoutSpecializedRule(value: ScalarOrArrayDataValue | undefined, type: DataType): unknown {
  if (!value) {
    return value;
  }

  if (getScalarTypeOf(value.type) === 'any' || getScalarTypeOf(type) === 'any') {
    return value.value;
  }

  return expectTypeOptional(value, type);
}

export function coerceType<T extends DataType>(value: DataValue | undefined, type: T): GetDataValue<T>['value'] {
  const result = coerceTypeOptional(value, type);
  if (result === undefined) {
    throw new Error(`Expected value of type ${type} but got undefined`);
  }
  return result as GetDataValue<T>['value'];
}

export function inferType(value: unknown): DataValue {
  if (value === undefined) {
    return { type: 'any', value: undefined };
  }

  if (value === null) {
    return { type: 'any', value: null };
  }

  if (typeof value === 'function') {
    return { type: 'fn<any>', value: value as () => unknown };
  }

  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }

  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  if (value instanceof Date) {
    return { type: 'datetime', value: value.toISOString() };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'any[]', value: [] };
    }

    const inferredType = inferType(value[0]);

    return { type: inferredType.type + '[]', value } as DataValue;
  }

  if (typeof value === 'object') {
    return { type: 'object', value: value as Record<string, unknown> };
  }

  throw new Error(`Cannot infer type of value: ${value}`);
}

function coerceToString(value: DataValue | undefined): string | undefined {
  if (!value) {
    return '';
  }

  if (isArrayDataValue(value)) {
    return value.value
      .map((v) => coerceTypeOptional({ type: getScalarTypeOf(value.type), value: v } as DataValue, 'string'))
      .join('\n');
  }

  if (value.type === 'string') {
    return value.value;
  }

  if (value.type === 'boolean') {
    return value.value.toString();
  }

  if (value.type === 'number') {
    return value.value.toString();
  }

  if (value.type === 'date') {
    return value.value;
  }

  if (value.type === 'time') {
    return value.value;
  }

  if (value.type === 'datetime') {
    return value.value;
  }

  if (value.type === 'chat-message') {
    const messageParts = Array.isArray(value.value.message) ? value.value.message : [value.value.message];
    const singleString = messageParts
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        return part.type === 'url' ? `(Image: ${part.url})` : '(Image)';
      })
      .join('\n\n');
    return singleString;
  }

  if (value.value === undefined) {
    return undefined;
  }

  if (value.value === null) {
    return undefined;
  }

  if (typeof value.value === 'object' && !Array.isArray(value.value)) {
    return JSON.stringify(value.value);
  }

  // Don't know, so try to infer it from the type of the value
  // Any and object are basically the same...
  if (value.type === 'any' || value.type === 'object') {
    const inferred = inferType(value.value);
    return coerceTypeOptional(inferred, 'string');
  }

  return JSON.stringify(value.value);
}

function coerceToChatMessage(value: DataValue | undefined): ChatMessage | undefined {
  const chatMessage = coerceToChatMessageRaw(value);

  if (chatMessage?.type === 'assistant') {
    // Double check that arguments is a string, stringify if needed
    if (chatMessage.function_call?.arguments && typeof chatMessage.function_call.arguments !== 'string') {
      chatMessage.function_call.arguments = JSON.stringify(chatMessage.function_call.arguments);
    }
  }

  return chatMessage;
}

function coerceToChatMessageRaw(value: DataValue | undefined): ChatMessage | undefined {
  if (!value || value.value == null) {
    return undefined;
  }

  if (value.type === 'chat-message') {
    return value.value;
  }

  if (value.type === 'string') {
    return { type: 'user', message: value.value };
  }

  if (
    value.type === 'object' &&
    'type' in value.value &&
    'message' in value.value &&
    typeof value.value.type === 'string' &&
    typeof value.value.message === 'string'
  ) {
    return value.value as ChatMessage;
  }

  if (value.type === 'any') {
    const inferred = inferType(value.value);
    return coerceTypeOptional(inferred, 'chat-message');
  }
}

function coerceToBoolean(value: DataValue | undefined) {
  if (!value || !value.value) {
    return false;
  }

  if (isArrayDataValue(value)) {
    return value.value
      .map((v) => coerceTypeOptional({ type: value.type.replace('[]', ''), value: v } as DataValue, 'boolean'))
      .every((v) => v);
  }

  if (value.type === 'string') {
    return value.value.length > 0 && value.value !== 'false';
  }

  if (value.type === 'boolean') {
    return value.value;
  }

  if (value.type === 'number') {
    return value.value !== 0;
  }

  if (value.type === 'date') {
    return true;
  }

  if (value.type === 'time') {
    return true;
  }

  if (value.type === 'datetime') {
    return true;
  }

  if (value.type === 'chat-message') {
    const hasValue =
      (Array.isArray(value.value.message) && value.value.message.length > 0) ||
      (typeof value.value.message === 'string' && value.value.message.length > 0) ||
      (typeof value.value.message === 'object' &&
        'type' in value.value.message &&
        value.value.message.type === 'url' &&
        value.value.message.url.length > 0);

    return hasValue;
  }

  return !!value.value;
}

function coerceToNumber(value: DataValue | undefined): number | undefined {
  if (!value || value.value == null) {
    return undefined;
  }

  if (isArrayDataValue(value)) {
    return undefined;
  }

  if (value.type === 'string') {
    return parseFloat(value.value);
  }

  if (value.type === 'boolean') {
    return value.value ? 1 : 0;
  }

  if (value.type === 'number') {
    return value.value;
  }

  if (value.type === 'date') {
    return new Date(value.value).valueOf();
  }

  if (value.type === 'time') {
    return new Date(value.value).valueOf();
  }

  if (value.type === 'datetime') {
    return new Date(value.value).valueOf();
  }

  if (value.type === 'chat-message') {
    if (typeof value.value.message === 'string') {
      return parseFloat(value.value.message);
    }

    if (
      Array.isArray(value.value.message) &&
      value.value.message.length === 1 &&
      typeof value.value.message[0] === 'string'
    ) {
      return parseFloat(value.value.message[0]);
    }

    return undefined;
  }

  if (value.type === 'any' || value.type === 'object') {
    const inferred = inferType(value.value);
    if (inferred.type === 'any' || inferred.type === 'object') {
      return undefined;
    }
    return coerceTypeOptional(inferred, 'number');
  }

  return undefined;
}

function coerceToObject(value: DataValue | undefined): object | undefined {
  if (!value || value.value == null) {
    return undefined;
  }

  return value.value; // Whatever, consider anything an object
}

function coerceToBinary(value: DataValue | undefined): Uint8Array | undefined {
  if (!value || value.value == null) {
    return undefined;
  }

  if (value.type === 'binary') {
    return value.value;
  }

  if (value.type === 'string') {
    return new TextEncoder().encode(value.value);
  }

  if (value.type === 'boolean') {
    return new TextEncoder().encode(value.value.toString());
  }

  if (value.type === 'vector' || value.type === 'number[]') {
    return new Uint8Array(value.value);
  }

  if (value.type === 'number') {
    return new Uint8Array([value.value]);
  }

  if (value.type === 'audio' || value.type === 'image' || value.type === 'document') {
    return value.value.data;
  }

  return new TextEncoder().encode(JSON.stringify(value.value));
}

function coerceToGraphReference(value: DataValue | undefined): { graphName: string; graphId: GraphId } | undefined {
  if (!value || value.value == null) {
    return undefined;
  }

  if (value.type === 'graph-reference') {
    return value.value;
  }

  if (value.type === 'string') {
    return { graphName: value.value, graphId: '' as GraphId };
  }

  if (value.type === 'object' && 'graphName' in value.value && 'graphId' in value.value) {
    return value.value as { graphName: string; graphId: GraphId };
  }

  return undefined;
}

function coerceValidatedObjectValue<T>(value: DataValue | undefined, normalize: (value: unknown) => T): T | undefined {
  if (!value || value.value == null || isArrayDataValue(value)) return undefined;
  try {
    return normalize(value.value);
  } catch {
    return undefined;
  }
}

export function canBeCoercedAny(from: DataType | Readonly<DataType[]>, to: DataType | Readonly<DataType[]>) {
  for (const fromType of Array.isArray(from) ? from : [from]) {
    for (const toType of Array.isArray(to) ? to : [to]) {
      if (canBeCoerced(fromType, toType)) {
        return true;
      }
    }
  }
  return false;
}

export function canBeCoerced(from: DataType, to: DataType) {
  if (to === 'any') {
    return scalarCoercionRules.any.canAttempt(from);
  }

  if (from === 'any') {
    return true;
  }

  if (isArrayDataType(to) && isArrayDataType(from)) {
    return canBeCoerced(getScalarTypeOf(from), getScalarTypeOf(to));
  }

  if (isArrayDataType(to) && !isArrayDataType(from)) {
    return canBeCoerced(from, getScalarTypeOf(to));
  }

  if (isArrayDataType(from) && !isArrayDataType(to)) {
    return to === 'string' || to === 'object';
  }

  if (isScalarDataType(to)) {
    return scalarCoercionRules[to].canAttempt(from);
  }

  return canAttemptGeneralCoercion(from, to);
}
