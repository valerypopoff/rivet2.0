import type { GraphId } from '../index.js';
import { exhaustiveTuple } from '../utils/genericUtilFunctions.js';
import type { DataId } from './Project.js';
import type {
  RivetKnowledgeDocument,
  RivetKnowledgeEvidence,
  RivetKnowledgeSourceReference,
} from '../integrations/KnowledgeStore.js';
import { createDefaultLLMProfileValue, type LLMProfileValue } from './chat-v2/llmProfileTypes.js';

export type DataValueDef<Type extends string, RuntimeType> = {
  type: Type;
  value: RuntimeType;
};

export type StringDataValue = DataValueDef<'string', string>;
export type NumberDataValue = DataValueDef<'number', number>;
export type BoolDataValue = DataValueDef<'boolean', boolean>;

export type SystemChatMessage = {
  type: 'system';
  message: ChatMessageMessagePart | ChatMessageMessagePart[];

  /** If true, this message marks a breakpoint when used with prompt caching (as of right now, Anthropic-only). */
  isCacheBreakpoint?: boolean;
};

export type UserChatMessage = {
  type: 'user';
  message: ChatMessageMessagePart | ChatMessageMessagePart[];

  /** If true, this message marks a breakpoint when used with prompt caching (as of right now, Anthropic-only). */
  isCacheBreakpoint?: boolean;
};

export type AssistantChatMessageFunctionCall = {
  id: string | undefined;
  name: string;
  arguments: string; // JSON string
};

export type ParsedAssistantChatMessageFunctionCall = {
  id: string | undefined;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantChatMessage = {
  type: 'assistant';
  message: ChatMessageMessagePart | ChatMessageMessagePart[];

  /** @deprecated use function_calls instead */
  function_call: AssistantChatMessageFunctionCall | undefined;

  function_calls: AssistantChatMessageFunctionCall[] | undefined;

  /** If true, this message marks a breakpoint when used with prompt caching (as of right now, Anthropic-only). */
  isCacheBreakpoint?: boolean;
};

export type FunctionResponseChatMessage = {
  type: 'function';
  message: ChatMessageMessagePart | ChatMessageMessagePart[];
  name: string;
  toolName?: string;

  /** If true, this message marks a breakpoint when used with prompt caching (as of right now, Anthropic-only). */
  isCacheBreakpoint?: boolean;
};

export type ChatMessage = SystemChatMessage | UserChatMessage | AssistantChatMessage | FunctionResponseChatMessage;

export type ChatMessageMessagePart =
  | string
  | { type: 'image'; mediaType: SupportedImageMediaTypes; data: Uint8Array }
  | { type: 'url'; url: string }
  | {
      type: 'document';
      title: string | undefined;
      context: string | undefined;
      mediaType: SupportedDocumentMediaTypes;
      data: Uint8Array;
      enableCitations: boolean;
    };

export type SupportedImageMediaTypes = 'image/jpeg' | 'image/png' | 'image/gif';
export type SupportedDocumentMediaTypes = 'application/pdf' | 'text/plain';

export type ChatMessageDataValue = DataValueDef<'chat-message', ChatMessage>;

export type DateDataValue = DataValueDef<'date', string>;
export type TimeDataValue = DataValueDef<'time', string>;
export type DateTimeDataValue = DataValueDef<'datetime', string>;
export type AnyDataValue = DataValueDef<'any', unknown>;
export type ObjectDataValue = DataValueDef<'object', Record<string, unknown>>;
export type VectorDataValue = DataValueDef<'vector', number[]>;
export type BinaryDataValue = DataValueDef<'binary', Uint8Array>;
export type ImageDataValue = DataValueDef<'image', { mediaType: SupportedImageMediaTypes; data: Uint8Array }>;
export type AudioDataValue = DataValueDef<'audio', { mediaType?: string; data: Uint8Array }>;
export type GraphReferenceValue = DataValueDef<'graph-reference', { graphId: GraphId; graphName: string }>;
export type KnowledgeSourceDataValue = DataValueDef<'knowledge-source', RivetKnowledgeSourceReference>;
export type KnowledgeDocumentDataValue = DataValueDef<'knowledge-document', RivetKnowledgeDocument>;
export type KnowledgeEvidenceDataValue = DataValueDef<'knowledge-evidence', RivetKnowledgeEvidence>;
export type LLMProfileDataValue = DataValueDef<'llm-config', LLMProfileValue>;
export type DocumentDataValue = DataValueDef<
  'document',
  {
    mediaType: SupportedDocumentMediaTypes;
    data: Uint8Array;
    title: string | undefined;
    context: string | undefined;
    enableCitations: boolean;
  }
>;

export type GptFunctionResultHandling = 'continue' | 'return-direct';

/** GPT function definition */
export type GptFunction = {
  name: string;
  namespace?: string;
  description: string;
  parameters: object;
  strict: boolean;
  /** Rivet-only handling for the function result. This is not sent to the model provider. */
  resultHandling?: GptFunctionResultHandling;
};

export type GptFunctionDataValue = DataValueDef<'gpt-function', GptFunction>;

export type ControlFlowExcludedDataValue = DataValueDef<'control-flow-excluded', undefined | 'loop-not-broken'>;

export type ScalarDataValue =
  | StringDataValue
  | NumberDataValue
  | DateDataValue
  | TimeDataValue
  | DateTimeDataValue
  | BoolDataValue
  | ChatMessageDataValue
  | ControlFlowExcludedDataValue
  | AnyDataValue
  | ObjectDataValue
  | GptFunctionDataValue
  | VectorDataValue
  | ImageDataValue
  | BinaryDataValue
  | AudioDataValue
  | GraphReferenceValue
  | KnowledgeSourceDataValue
  | KnowledgeDocumentDataValue
  | KnowledgeEvidenceDataValue
  | LLMProfileDataValue
  | DocumentDataValue;

export type ScalarType = ScalarDataValue['type'];

export type ArrayDataValue<T extends ScalarDataValue> = DataValueDef<`${T['type']}[]`, T['value'][]>;

export type FunctionDataValue<T extends ScalarOrArrayDataValue> = DataValueDef<`fn<${T['type']}>`, () => T['value']>;

export type StringArrayDataValue = ArrayDataValue<StringDataValue>;

export type ArrayDataValues = {
  [P in ScalarDataValue['type']]: ArrayDataValue<Extract<ScalarDataValue, { type: P }>>;
}[ScalarDataValue['type']];

export type ArrayLikeDataValue =
  | ArrayDataValues
  | (AnyDataValue & { value: unknown[] })
  | (ObjectDataValue & { value: unknown[] });

export type ScalarOrArrayDataValue = ScalarDataValue | ArrayDataValues;

export type FunctionDataValues = {
  [P in ScalarOrArrayDataValue['type']]: FunctionDataValue<Extract<ScalarOrArrayDataValue, { type: P }>>;
}[ScalarOrArrayDataValue['type']];

export type DataValue = ScalarDataValue | ArrayDataValues | FunctionDataValues;

export type DataType = DataValue['type'];
export type ScalarDataType = ScalarDataValue['type'];
export type ArrayDataType = ArrayDataValues['type'];
export type FunctionDataType = FunctionDataValues['type'];
export type ScalarOrArrayDataType = ScalarOrArrayDataValue['type'];

export type GetDataValue<Type extends DataType> = Extract<DataValue, { type: Type }>;

/** A reference to large data stored outside the graphs themselves. */
export type DataRef = {
  refId: DataId;
};

export const dataTypes = exhaustiveTuple<DataType>()(
  'any',
  'any[]',
  'boolean',
  'boolean[]',
  'string',
  'string[]',
  'number',
  'number[]',
  'date',
  'date[]',
  'time',
  'time[]',
  'datetime',
  'datetime[]',
  'chat-message',
  'chat-message[]',
  'control-flow-excluded',
  'control-flow-excluded[]',
  'object',
  'object[]',
  'fn<string>',
  'fn<number>',
  'fn<boolean>',
  'fn<date>',
  'fn<time>',
  'fn<datetime>',
  'fn<any>',
  'fn<object>',
  'fn<chat-message>',
  'fn<control-flow-excluded>',
  'fn<string[]>',
  'fn<number[]>',
  'fn<boolean[]>',
  'fn<date[]>',
  'fn<time[]>',
  'fn<datetime[]>',
  'fn<any[]>',
  'fn<object[]>',
  'fn<chat-message[]>',
  'fn<control-flow-excluded[]>',
  'gpt-function',
  'gpt-function[]',
  'fn<gpt-function[]>',
  'fn<gpt-function>',
  'vector',
  'vector[]',
  'fn<vector>',
  'fn<vector[]>',
  'image',
  'image[]',
  'fn<image>',
  'fn<image[]>',
  'binary',
  'binary[]',
  'fn<binary>',
  'fn<binary[]>',
  'audio',
  'audio[]',
  'fn<audio>',
  'fn<audio[]>',
  'graph-reference',
  'graph-reference[]',
  'fn<graph-reference>',
  'fn<graph-reference[]>',
  'knowledge-source',
  'knowledge-source[]',
  'fn<knowledge-source>',
  'fn<knowledge-source[]>',
  'knowledge-document',
  'knowledge-document[]',
  'fn<knowledge-document>',
  'fn<knowledge-document[]>',
  'knowledge-evidence',
  'knowledge-evidence[]',
  'fn<knowledge-evidence>',
  'fn<knowledge-evidence[]>',
  'llm-config',
  'llm-config[]',
  'fn<llm-config>',
  'fn<llm-config[]>',
  'document',
  'document[]',
  'fn<document>',
  'fn<document[]>',
);

export const scalarTypes = exhaustiveTuple<ScalarType>()(
  'any',
  'boolean',
  'string',
  'number',
  'date',
  'time',
  'datetime',
  'chat-message',
  'control-flow-excluded',
  'object',
  'gpt-function',
  'vector',
  'image',
  'binary',
  'audio',
  'graph-reference',
  'knowledge-source',
  'knowledge-document',
  'knowledge-evidence',
  'llm-config',
  'document',
);

export const dataTypeDisplayNames: Record<DataType, string> = {
  any: 'Any',
  'any[]': 'Any Array',
  boolean: 'Boolean',
  'boolean[]': 'Boolean Array',
  string: 'String',
  'string[]': 'String Array',
  number: 'Number',
  'number[]': 'Number Array',
  date: 'Date',
  'date[]': 'Date Array',
  time: 'Time',
  'time[]': 'Time Array',
  datetime: 'DateTime',
  'datetime[]': 'DateTime Array',
  'chat-message': 'ChatMessage',
  'chat-message[]': 'ChatMessage Array',
  'control-flow-excluded': 'ControlFlowExcluded',
  'control-flow-excluded[]': 'ControlFlowExcluded Array',
  object: 'Object',
  'object[]': 'Object Array',
  'gpt-function': 'GPT Function',
  'gpt-function[]': 'GPT Function Array',
  'fn<string>': 'Function<String>',
  'fn<number>': 'Function<Number>',
  'fn<boolean>': 'Function<Boolean>',
  'fn<date>': 'Function<Date>',
  'fn<time>': 'Function<Time>',
  'fn<datetime>': 'Function<DateTime>',
  'fn<any>': 'Function<Any>',
  'fn<object>': 'Function<Object>',
  'fn<chat-message>': 'Function<ChatMessage>',
  'fn<control-flow-excluded>': 'Function<ControlFlowExcluded>',
  'fn<gpt-function>': 'Function<GPT Function>',
  'fn<string[]>': 'Function<String Array>',
  'fn<number[]>': 'Function<Number Array>',
  'fn<boolean[]>': 'Function<Boolean Array>',
  'fn<date[]>': 'Function<Date Array>',
  'fn<time[]>': 'Function<Time Array>',
  'fn<datetime[]>': 'Function<DateTime Array>',
  'fn<any[]>': 'Function<Any Array>',
  'fn<object[]>': 'Function<Object Array>',
  'fn<chat-message[]>': 'Function<ChatMessage Array>',
  'fn<control-flow-excluded[]>': 'Function<ControlFlowExcluded Array>',
  'fn<gpt-function[]>': 'Function<GPT Function Array>',
  vector: 'Vector',
  'vector[]': 'Vector Array',
  'fn<vector>': 'Function<Vector>',
  'fn<vector[]>': 'Function<Vector Array>',
  image: 'Image',
  'image[]': 'Image Array',
  'fn<image>': 'Function<Image>',
  'fn<image[]>': 'Function<Image Array>',
  binary: 'Binary',
  'binary[]': 'Binary Array',
  'fn<binary>': 'Function<Binary>',
  'fn<binary[]>': 'Function<Binary Array>',
  audio: 'Audio',
  'audio[]': 'Audio Array',
  'fn<audio>': 'Function<Audio>',
  'fn<audio[]>': 'Function<Audio Array>',
  'graph-reference': 'Graph Reference',
  'graph-reference[]': 'Graph Reference Array',
  'fn<graph-reference>': 'Function<Graph Reference>',
  'fn<graph-reference[]>': 'Function<Graph Reference Array>',
  'knowledge-source': 'Knowledge Source',
  'knowledge-source[]': 'Knowledge Source Array',
  'fn<knowledge-source>': 'Function<Knowledge Source>',
  'fn<knowledge-source[]>': 'Function<Knowledge Source Array>',
  'knowledge-document': 'Knowledge Document',
  'knowledge-document[]': 'Knowledge Document Array',
  'fn<knowledge-document>': 'Function<Knowledge Document>',
  'fn<knowledge-document[]>': 'Function<Knowledge Document Array>',
  'knowledge-evidence': 'Knowledge Evidence',
  'knowledge-evidence[]': 'Knowledge Evidence Array',
  'fn<knowledge-evidence>': 'Function<Knowledge Evidence>',
  'fn<knowledge-evidence[]>': 'Function<Knowledge Evidence Array>',
  'llm-config': 'LLM Profile',
  'llm-config[]': 'LLM Profile Array',
  'fn<llm-config>': 'Function<LLM Profile>',
  'fn<llm-config[]>': 'Function<LLM Profile Array>',
  document: 'Document',
  'document[]': 'Document Array',
  'fn<document>': 'Function<Document>',
  'fn<document[]>': 'Function<Document Array>',
};

export function isScalarDataValue(value: DataValue | undefined): value is ScalarDataValue {
  if (!value) {
    return false;
  }

  return !isArrayDataType(value.type) && !isFunctionDataType(value.type);
}

export function isScalarDataType(type: DataType): type is ScalarDataType {
  return !isArrayDataType(type) && !isFunctionDataType(type);
}

export function isArrayDataValue(value: DataValue | undefined): value is ArrayLikeDataValue {
  if (!value) {
    return false;
  }

  return (
    isArrayDataType(value.type) || ((value.type === 'any' || value.type === 'object') && Array.isArray(value.value))
  );
}

export function isArrayDataType(type: DataType): type is ArrayDataType {
  return type.endsWith('[]');
}

export function isFunctionDataType(type: DataType): type is FunctionDataType {
  return type.startsWith('fn<');
}

export function isFunctionDataValue(
  value: DataValue | undefined,
): value is FunctionDataValues | (AnyDataValue & { value: () => unknown }) {
  if (!value) {
    return false;
  }
  return isFunctionDataType(value.type) || (value.type === 'any' && typeof value.value === 'function');
}

export function isNotFunctionDataValue(value: DataValue | undefined): value is ScalarOrArrayDataValue {
  return value !== undefined && !isFunctionDataValue(value);
}

export function functionTypeToReturnType(functionType: FunctionDataType): ScalarOrArrayDataType {
  return functionType.slice(3, -1) as ScalarOrArrayDataType;
}

export function functionTypeToScalarType(functionType: FunctionDataType): ScalarDataType {
  const returnType = functionTypeToReturnType(functionType);
  return isArrayDataType(returnType) ? arrayTypeToScalarType(returnType) : returnType;
}

export function arrayTypeToScalarType(arrayType: ArrayDataType): ScalarDataType {
  return arrayType.slice(0, -2) as ScalarDataType;
}

export function getScalarTypeOf(type: DataType): ScalarDataType {
  if (isArrayDataType(type)) {
    return arrayTypeToScalarType(type);
  }

  if (isFunctionDataType(type)) {
    return functionTypeToScalarType(type);
  }

  return type;
}

/** Unwraps a potentially function data value to a concrete value. I.e., evaluates on-demand values. */
export function unwrapDataValue(value: DataValue): ScalarOrArrayDataValue;
export function unwrapDataValue(value: DataValue | undefined): ScalarOrArrayDataValue | undefined {
  if (!value) {
    return undefined;
  }

  if (isFunctionDataValue(value)) {
    const evaluated = value.value();
    if (value.type === 'any') {
      return { type: 'any', value: evaluated };
    }
    return { type: functionTypeToReturnType(value.type), value: evaluated } as ScalarOrArrayDataValue;
  }

  return value;
}

/**
 * Turns a { type: 'string[]', value: string[] } into { type: 'string', value: string }[]
 * or a { type: 'object', value: something[] } into { type: 'object', value: something }[]
 * or a { type: 'any', value: something[] } into { type: 'any', value: something }[]
 * or a { type: 'string', value: string } into [{ type: 'string', value: string }]
 */
export const arrayizeDataValue = (value: ScalarOrArrayDataValue): ScalarDataValue[] => {
  const isArray =
    value.type.endsWith('[]') || ((value.type === 'any' || value.type === 'object') && Array.isArray(value.value));
  if (!isArray) {
    return [value as ScalarDataValue];
  }

  const unwrappedType = value.type.endsWith('[]') ? value.type.slice(0, -2) : value.type;

  return (value.value as unknown[]).map((v) => ({ type: unwrappedType as ScalarType, value: v })) as ScalarDataValue[];
};

export const scalarDefaults: { [P in ScalarDataType]: Extract<ScalarDataValue, { type: P }>['value'] } = {
  string: '',
  number: 0,
  boolean: false,
  any: undefined,
  'chat-message': {
    type: 'user',
    message: '',
    isCacheBreakpoint: undefined,
  },
  'control-flow-excluded': undefined,
  date: new Date().toISOString(),
  time: new Date().toISOString(),
  datetime: new Date().toISOString(),
  object: {},
  'gpt-function': {
    name: 'unknown',
    description: '',
    parameters: {},
    namespace: undefined,
    strict: false,
  },
  vector: [],
  image: {
    mediaType: 'image/jpeg',
    data: new Uint8Array(),
  },
  binary: new Uint8Array(),
  audio: { data: new Uint8Array() },
  'graph-reference': { graphId: '' as GraphId, graphName: '' },
  'knowledge-source': { connectionId: '', sourceId: '' },
  'knowledge-document': { text: '' },
  'knowledge-evidence': {
    id: '',
    text: '',
    source: { connectionId: '', sourceId: '' },
    documentId: '',
  },
  'llm-config': createDefaultLLMProfileValue(),
  document: {
    mediaType: 'text/plain',
    data: new Uint8Array(),
    title: undefined,
    context: undefined,
    enableCitations: false,
  },
};

export function getDefaultValue<T extends DataType>(type: T): GetDataValue<T>['value'] {
  if (isArrayDataType(type)) {
    return [] as unknown as GetDataValue<T>['value'];
  }

  if (isFunctionDataType(type)) {
    const returnType = functionTypeToReturnType(type);
    return (() => getDefaultValue(returnType)) as unknown as GetDataValue<T>['value'];
  }

  return structuredClone(scalarDefaults[getScalarTypeOf(type)]) as unknown as GetDataValue<T>['value'];
}
