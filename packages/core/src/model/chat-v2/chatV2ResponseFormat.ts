import { Output, jsonSchema } from 'ai';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import type { GptFunction } from '../DataValue.js';
import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2Provider, ChatV2ProviderOptions, ChatV2ResponseOutput } from './chatV2Types.js';

export type ChatV2ResponseFormat = '' | 'text' | 'json' | 'json_schema';

export type ChatV2StructuredResponseFormat = Extract<ChatV2ResponseFormat, 'json' | 'json_schema'>;

export type ChatV2ResponseFormatData = {
  responseFormat?: ChatV2ResponseFormat;
  responseSchemaName?: string;
  useResponseSchemaNameInput?: boolean;
  responseSchemaDescription?: string;
  useResponseSchemaDescriptionInput?: boolean;
};

export type ChatV2ResponseFormatParameters =
  | undefined
  | {
      responseFormat: 'text';
    }
  | {
      responseFormat: 'json';
      schemaName?: string;
      schemaDescription?: string;
    }
  | {
      responseFormat: 'json_schema';
      schema: unknown;
      schemaName: string;
      schemaDescription?: string;
    };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export function isChatV2StructuredResponseFormat(
  responseFormat: unknown,
): responseFormat is ChatV2StructuredResponseFormat {
  return responseFormat === 'json' || responseFormat === 'json_schema';
}

function getResponseSchema(inputs: Inputs): unknown {
  const responseSchemaInput = inputs['responseSchema' as PortId];

  if (responseSchemaInput?.type === 'gpt-function') {
    return (responseSchemaInput.value as GptFunction).parameters;
  }

  return responseSchemaInput != null ? coerceTypeOptional(responseSchemaInput, 'object') ?? {} : {};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toJsonValue(value: unknown, path = 'Response Schema', seen = new WeakSet<object>()): JsonValue {
  if (value === undefined) {
    throw new Error(`${path} must be JSON-compatible; undefined values are not supported.`);
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be JSON-compatible; non-finite numbers are not supported.`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}[${index}]`, seen));
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be JSON-compatible; only plain objects are supported.`);
    }

    if (seen.has(value)) {
      throw new Error(`${path} must be JSON-compatible; circular references are not supported.`);
    }

    seen.add(value);

    const jsonObject: JsonObject = {};

    for (const [key, item] of Object.entries(value)) {
      jsonObject[key] = toJsonValue(item, `${path}.${key}`, seen);
    }

    seen.delete(value);
    return jsonObject;
  }

  throw new Error(`${path} must be JSON-compatible; ${typeof value} values are not supported.`);
}

export function resolveChatV2ResponseFormatParameters(
  data: ChatV2ResponseFormatData,
  inputs: Inputs,
): ChatV2ResponseFormatParameters {
  const responseFormat = data.responseFormat ?? '';

  if (!responseFormat) {
    return undefined;
  }

  if (responseFormat === 'text') {
    return { responseFormat };
  }

  const schemaName = normalizeOptionalString(getInputOrData(data, inputs, 'responseSchemaName', 'string'));
  const schemaDescription = normalizeOptionalString(
    getInputOrData(data, inputs, 'responseSchemaDescription', 'string'),
  );

  if (responseFormat === 'json') {
    return {
      responseFormat,
      schemaName,
      schemaDescription,
    };
  }

  return {
    responseFormat,
    schema: getResponseSchema(inputs),
    schemaName: schemaName ?? 'response_schema',
    schemaDescription,
  };
}

export function createChatV2ResponseOutput(
  parameters: ChatV2ResponseFormatParameters,
  provider?: ChatV2Provider,
): ChatV2ResponseOutput | undefined {
  if (parameters == null) {
    return undefined;
  }

  if (parameters.responseFormat === 'text') {
    return Output.text();
  }

  if (parameters.responseFormat === 'json') {
    if (provider === 'custom') {
      return undefined;
    }

    return Output.json({
      name: parameters.schemaName,
      description: parameters.schemaDescription,
    });
  }

  return Output.object({
    schema: jsonSchema(toJsonValue(parameters.schema) as any),
    name: parameters.schemaName,
    description: parameters.schemaDescription,
  });
}

export function mergeCustomProviderResponseFormatOptions(
  provider: ChatV2Provider,
  providerOptions: ChatV2ProviderOptions | undefined,
  parameters: ChatV2ResponseFormatParameters,
): ChatV2ProviderOptions | undefined {
  if (provider !== 'custom' || parameters == null) {
    return providerOptions;
  }

  const customOptions = providerOptions?.custom ?? {};

  if (parameters.responseFormat === 'json') {
    return {
      ...providerOptions,
      custom: {
        ...customOptions,
        response_format: { type: 'json_object' },
      },
    };
  }

  if (parameters.responseFormat !== 'json_schema') {
    return providerOptions;
  }

  const jsonSchemaOptions: JsonObject = {
    name: parameters.schemaName,
    strict: true,
    schema: toJsonValue(parameters.schema),
  };

  if (parameters.schemaDescription != null) {
    jsonSchemaOptions.description = parameters.schemaDescription;
  }

  return {
    ...providerOptions,
    custom: {
      ...customOptions,
      response_format: {
        type: 'json_schema',
        json_schema: jsonSchemaOptions,
      },
    },
  };
}
