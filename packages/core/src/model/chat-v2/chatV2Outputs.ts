import type { LanguageModelUsage } from 'ai';
import { inferType } from '../../utils/coerceType.js';
import type { ChatMessage, DataValue } from '../DataValue.js';
import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import { createAssistantMessagesOutput, type StreamedFunctionCall } from '../chat/streamChatResponse.js';
import { isChatV2StructuredResponseFormat } from './chatV2ResponseFormat.js';
import { calculateChatV2Cost } from './modelRegistry.js';
import type { ChatV2NormalizedUsage, ChatV2ReasoningOutput, RunChatV2PipelineOptions } from './chatV2Types.js';

const CHAT_V2_REQUEST_STATUS_PORT_ID = 'requestStatus' as PortId;
const CHAT_V2_REQUEST_ERROR_PORT_ID = 'requestError' as PortId;
const CHAT_V2_REQUEST_BODY_PORT_ID = 'requestBody' as PortId;

type ControlFlowExcludedOutput = { type: 'control-flow-excluded'; value: undefined };

type ChatV2CommonOutputOptions = Pick<
  RunChatV2PipelineOptions,
  | 'outputUsage'
  | 'outputReasoning'
  | 'outputRequestStatus'
  | 'includeFunctionCalls'
  | 'functionCallMode'
  | 'retryOnNon200'
  | 'responseFormat'
>;

type CreateChatV2CommonOutputsOptions = ChatV2CommonOutputOptions & {
  requestMessages: ChatMessage[];
  response: string;
  structuredOutput: unknown | undefined;
  functionCalls: StreamedFunctionCall[];
  usage: ChatV2NormalizedUsage | undefined;
  reasoning: ChatV2ReasoningOutput | undefined;
  requestStatus: number | undefined;
  responseError: string | undefined;
  requestStatuses: number[];
  requestErrors: string[];
  requestBodies?: unknown[] | undefined;
};

type CreateChatV2ProviderFailureOutputsOptions = Pick<
  RunChatV2PipelineOptions,
  'outputUsage' | 'outputReasoning' | 'includeFunctionCalls' | 'retryOnNon200'
> & {
  requestMessages: ChatMessage[];
  responseStatus: number | undefined;
  responseError: string;
  requestStatuses: number[];
  requestErrors: string[];
  requestBodies?: unknown[] | undefined;
};

function toFunctionCallOutputValue(functionCall: StreamedFunctionCall) {
  let argumentsValue = functionCall.lastParsedArguments;

  if (argumentsValue == null) {
    try {
      argumentsValue = JSON.parse(functionCall.arguments);
    } catch {
      argumentsValue = functionCall.arguments;
    }
  }

  return {
    name: functionCall.name,
    arguments: argumentsValue,
    id: functionCall.id,
  };
}

function createControlFlowExcludedOutput(): ControlFlowExcludedOutput {
  return {
    type: 'control-flow-excluded',
    value: undefined,
  };
}

export function normalizeChatV2Usage(
  usage: LanguageModelUsage | undefined,
  options: Pick<RunChatV2PipelineOptions, 'provider' | 'modelId'>,
): ChatV2NormalizedUsage | undefined {
  if (usage == null) {
    return undefined;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
  const cachedTokens =
    (usage.inputTokenDetails?.cacheReadTokens ?? 0) + (usage.inputTokenDetails?.cacheWriteTokens ?? 0);
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    totalCost: calculateChatV2Cost(options.provider, options.modelId, promptTokens, completionTokens),
  };
}

function tryParseStructuredResponseText(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch {
    return undefined;
  }
}

function createChatV2ResponseOutput(
  response: string,
  structuredOutput: unknown | undefined,
  responseFormat: RunChatV2PipelineOptions['responseFormat'],
): DataValue {
  if (!isChatV2StructuredResponseFormat(responseFormat)) {
    return { type: 'string', value: response };
  }

  const parsedOutput = structuredOutput !== undefined ? structuredOutput : tryParseStructuredResponseText(response);

  return parsedOutput !== undefined ? inferType(parsedOutput) : { type: 'string', value: response };
}

function createChatV2ReasoningOutput(reasoning: ChatV2ReasoningOutput | undefined): Outputs[PortId] {
  if (Array.isArray(reasoning)) {
    const nonEmptyReasoning = reasoning.filter((part) => typeof part === 'string' && part.trim().length > 0);

    return nonEmptyReasoning.length > 0
      ? {
          type: 'string[]',
          value: nonEmptyReasoning,
        }
      : createControlFlowExcludedOutput();
  }

  const reasoningText = typeof reasoning === 'string' ? reasoning : '';

  return reasoningText.trim().length > 0
    ? {
        type: 'string',
        value: reasoningText,
      }
    : createControlFlowExcludedOutput();
}

function createChatV2RequestBodyOutput(requestBodies: unknown[] | undefined): Outputs[PortId] {
  if (requestBodies == null || requestBodies.length === 0) {
    return createControlFlowExcludedOutput();
  }

  return inferType(requestBodies.length === 1 ? requestBodies[0] : requestBodies);
}

function createChatV2RetryAttemptOutput(
  type: 'number[]',
  values: number[],
): { type: 'number[]'; value: number[] } | { type: 'control-flow-excluded'; value: undefined };
function createChatV2RetryAttemptOutput(
  type: 'string[]',
  values: string[],
): { type: 'string[]'; value: string[] } | { type: 'control-flow-excluded'; value: undefined };
function createChatV2RetryAttemptOutput(type: 'number[]' | 'string[]', values: number[] | string[]) {
  return values.length > 0
    ? {
        type,
        value: values,
      }
    : createControlFlowExcludedOutput();
}

export function createChatV2CommonOutputs({
  requestMessages,
  response,
  structuredOutput,
  functionCalls,
  usage,
  reasoning,
  requestStatus,
  responseError,
  requestStatuses,
  requestErrors,
  requestBodies,
  outputUsage,
  outputReasoning,
  outputRequestStatus,
  includeFunctionCalls,
  functionCallMode,
  retryOnNon200,
  responseFormat,
}: CreateChatV2CommonOutputsOptions): Outputs {
  const outputs: Outputs = {
    ['response' as PortId]: createChatV2ResponseOutput(response, structuredOutput, responseFormat),
    ['in-messages' as PortId]: { type: 'chat-message[]', value: requestMessages },
    ['all-messages' as PortId]: createAssistantMessagesOutput(requestMessages, response, functionCalls, {
      functionCallMode,
    }),
    ['responseTokens' as PortId]: { type: 'number', value: usage?.completionTokens ?? 0 },
  };

  if (functionCalls.length > 0) {
    outputs['function-calls' as PortId] = {
      type: 'object[]',
      value: functionCalls.map(toFunctionCallOutputValue),
    };
  } else if (includeFunctionCalls) {
    outputs['function-calls' as PortId] = createControlFlowExcludedOutput();
  }

  if (outputUsage) {
    outputs['usage' as PortId] = {
      type: 'object',
      value: usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalCost: undefined,
      },
    };
  }

  if (outputReasoning) {
    outputs['reasoning' as PortId] = createChatV2ReasoningOutput(reasoning);
  }

  if (outputRequestStatus) {
    if (retryOnNon200) {
      outputs[CHAT_V2_REQUEST_STATUS_PORT_ID] = createChatV2RetryAttemptOutput(
        'number[]',
        requestStatuses.length > 0 ? requestStatuses : [requestStatus ?? 200],
      );
      outputs[CHAT_V2_REQUEST_ERROR_PORT_ID] = createChatV2RetryAttemptOutput('string[]', requestErrors);
    } else {
      outputs[CHAT_V2_REQUEST_STATUS_PORT_ID] = {
        type: 'number',
        value: requestStatus ?? 200,
      };
      outputs[CHAT_V2_REQUEST_ERROR_PORT_ID] =
        responseError != null
          ? {
              type: 'string',
              value: responseError,
            }
          : createControlFlowExcludedOutput();
    }

    outputs[CHAT_V2_REQUEST_BODY_PORT_ID] = createChatV2RequestBodyOutput(requestBodies);
  }

  return outputs;
}

export function createChatV2ProviderFailureOutputs({
  requestMessages,
  responseStatus,
  responseError,
  requestStatuses,
  requestErrors,
  requestBodies,
  outputUsage,
  outputReasoning,
  includeFunctionCalls,
  retryOnNon200,
}: CreateChatV2ProviderFailureOutputsOptions): Outputs {
  const outputs: Outputs = {
    [CHAT_V2_REQUEST_ERROR_PORT_ID]: retryOnNon200
      ? createChatV2RetryAttemptOutput('string[]', requestErrors)
      : {
          type: 'string',
          value: responseError,
        },
    [CHAT_V2_REQUEST_STATUS_PORT_ID]: retryOnNon200
      ? createChatV2RetryAttemptOutput('number[]', requestStatuses)
      : responseStatus == null
        ? {
            type: 'control-flow-excluded',
            value: undefined,
          }
        : {
          type: 'number',
          value: responseStatus,
        },
    ['response' as PortId]: createControlFlowExcludedOutput(),
    ['in-messages' as PortId]: {
      type: 'chat-message[]',
      value: requestMessages,
    },
    ['all-messages' as PortId]: {
      type: 'chat-message[]',
      value: requestMessages,
    },
    ['responseTokens' as PortId]: createControlFlowExcludedOutput(),
  };

  outputs[CHAT_V2_REQUEST_BODY_PORT_ID] = createChatV2RequestBodyOutput(requestBodies);

  if (includeFunctionCalls) {
    outputs['function-calls' as PortId] = createControlFlowExcludedOutput();
  }

  if (outputUsage) {
    outputs['usage' as PortId] = createControlFlowExcludedOutput();
  }

  if (outputReasoning) {
    outputs['reasoning' as PortId] = createControlFlowExcludedOutput();
  }

  return outputs;
}
