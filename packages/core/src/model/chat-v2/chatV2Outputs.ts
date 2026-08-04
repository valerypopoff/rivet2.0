import type { LanguageModelUsage } from 'ai';
import { inferType } from '../../utils/coerceType.js';
import type { ChatMessage, DataValue } from '../DataValue.js';
import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import { createAssistantMessagesOutput, type StreamedFunctionCall } from '../chat/streamChatResponse.js';
import { materializeLLMResponse } from './llmResponseMaterializer.js';
import { calculateChatV2UsageCost } from './modelRegistry.js';
import { isChatV2FiniteNonNegativeNumber } from './chatV2UsageAccounting.js';
import {
  shouldOutputChatV2RequestBody,
  shouldOutputChatV2ResponseBody,
  type ChatV2NormalizedUsage,
  type ChatV2ReasoningOutput,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';

const CHAT_V2_REQUEST_BODY_PORT_ID = 'requestBody' as PortId;
const CHAT_V2_RESPONSE_BODY_PORT_ID = 'responseBody' as PortId;

type ControlFlowExcludedOutput = { type: 'control-flow-excluded'; value: undefined };

type ChatV2CommonOutputOptions = Pick<
  RunChatV2PipelineOptions,
  | 'outputUsage'
  | 'outputReasoning'
  | 'outputRequestBody'
  | 'outputResponseBody'
  | 'includeFunctionCalls'
  | 'functionCallMode'
  | 'responseFormat'
>;

type CreateChatV2CommonOutputsOptions = ChatV2CommonOutputOptions & {
  requestMessages: ChatMessage[];
  response: string;
  structuredOutput: unknown | undefined;
  functionCalls: StreamedFunctionCall[];
  usage: ChatV2NormalizedUsage | undefined;
  reasoning: ChatV2ReasoningOutput | undefined;
  requestBodies?: unknown[] | undefined;
  responseBodies?: unknown[] | undefined;
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

  // Provider usage metadata crosses a runtime boundary and can be malformed.
  // Keep the node's portable Usage output aligned with the physical-call
  // observer: only finite, non-negative token counts are meaningful.
  const promptTokens = isChatV2FiniteNonNegativeNumber(usage.inputTokens) ? usage.inputTokens : 0;
  const completionTokens = isChatV2FiniteNonNegativeNumber(usage.outputTokens) ? usage.outputTokens : 0;
  const totalTokens = isChatV2FiniteNonNegativeNumber(usage.totalTokens)
    ? usage.totalTokens
    : promptTokens + completionTokens;
  const cachedTokens =
    (isChatV2FiniteNonNegativeNumber(usage.inputTokenDetails?.cacheReadTokens)
      ? usage.inputTokenDetails.cacheReadTokens
      : 0) +
    (isChatV2FiniteNonNegativeNumber(usage.inputTokenDetails?.cacheWriteTokens)
      ? usage.inputTokenDetails.cacheWriteTokens
      : 0);
  const reasoningTokens = isChatV2FiniteNonNegativeNumber(usage.outputTokenDetails?.reasoningTokens)
    ? usage.outputTokenDetails.reasoningTokens
    : 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    totalCost: calculateChatV2UsageCost(options.provider, options.modelId, usage),
  };
}

export function createChatV2ResponseOutput(
  response: string,
  structuredOutput: unknown | undefined,
  responseFormat: RunChatV2PipelineOptions['responseFormat'],
): DataValue {
  return materializeLLMResponse({
    rawText: response,
    structuredOutput,
    responseFormat,
  }).value;
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

function createChatV2CapturedBodiesOutput(bodies: unknown[] | undefined): Outputs[PortId] {
  if (bodies == null || bodies.length === 0) {
    return createControlFlowExcludedOutput();
  }

  return inferType(bodies.length === 1 ? bodies[0] : bodies);
}

export function createChatV2CommonOutputs({
  requestMessages,
  response,
  structuredOutput,
  functionCalls,
  usage,
  reasoning,
  requestBodies,
  responseBodies,
  outputUsage,
  outputReasoning,
  outputRequestBody,
  outputResponseBody,
  includeFunctionCalls,
  functionCallMode,
  responseFormat,
}: CreateChatV2CommonOutputsOptions): Outputs {
  const outputs: Outputs = {
    ['response' as PortId]: createChatV2ResponseOutput(response, structuredOutput, responseFormat),
    ['in-messages' as PortId]: { type: 'chat-message[]', value: requestMessages },
    ['all-messages' as PortId]: createAssistantMessagesOutput(requestMessages, response, functionCalls, {
      functionCallMode,
    }),
  };

  if (includeFunctionCalls) {
    outputs['function-calls' as PortId] =
      functionCalls.length > 0
        ? {
            type: 'object[]',
            value: functionCalls.map(toFunctionCallOutputValue),
          }
        : createControlFlowExcludedOutput();
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

  if (shouldOutputChatV2RequestBody({ outputRequestBody })) {
    outputs[CHAT_V2_REQUEST_BODY_PORT_ID] = createChatV2CapturedBodiesOutput(requestBodies);
  }

  if (shouldOutputChatV2ResponseBody({ outputResponseBody })) {
    outputs[CHAT_V2_RESPONSE_BODY_PORT_ID] = createChatV2CapturedBodiesOutput(responseBodies);
  }

  return outputs;
}
