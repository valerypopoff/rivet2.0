import { normalizeLLMChatV2RetryCooldownMs, normalizeLLMChatV2RetryCount } from './chatV2Retry.js';
import type {
  ChatV2MessageList,
  ChatV2Provider,
  ChatV2ToolSet,
  RunChatV2PipelineOptions,
  StreamChatV2Options,
} from './chatV2Types.js';
import {
  shouldOutputChatV2RequestBody,
  shouldOutputChatV2ResponseBody,
} from './chatV2Types.js';

export type ChatV2TransportMode = 'stream' | 'generate';

export type ChatV2RequestPlan = {
  provider: ChatV2Provider;
  modelId: string;
  transportMode: ChatV2TransportMode;
  retry: {
    enabled: boolean;
    repeatTimes: number;
    cooldownMs: number;
  };
  request: Omit<StreamChatV2Options, 'abortSignal' | 'executeStream' | 'executeGenerate' | 'onPartialOutput'>;
  output: Pick<
    RunChatV2PipelineOptions,
    | 'outputUsage'
    | 'outputReasoning'
    | 'outputRequestBody'
    | 'outputResponseBody'
    | 'includeFunctionCalls'
    | 'functionCallMode'
  >;
};

type BuildChatV2RequestPlanOptions = Pick<
  RunChatV2PipelineOptions,
  | 'provider'
  | 'model'
  | 'modelId'
  | 'maxTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'responseOutput'
  | 'responseFormat'
  | 'providerOptions'
  | 'toolChoice'
  | 'retryOnNon200'
  | 'retryOnNon200RepeatTimes'
  | 'retryOnNon200CooldownMs'
  | 'outputUsage'
  | 'outputReasoning'
  | 'outputRequestBody'
  | 'outputResponseBody'
  | 'includeFunctionCalls'
  | 'emitPartialOutputs'
  | 'functionCallMode'
> & {
  messages: ChatV2MessageList;
  tools?: ChatV2ToolSet | undefined;
};

export type ChatV2RequestPlanSummary = {
  provider: ChatV2Provider;
  modelId: string;
  transportMode: ChatV2TransportMode;
  sdkMaxRetries: 0;
  retry: ChatV2RequestPlan['retry'];
  messageCount: number;
  toolNames: string[];
  responseFormat: RunChatV2PipelineOptions['responseFormat'];
  generation: {
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    topP?: number | undefined;
    topK?: number | undefined;
    presencePenalty?: number | undefined;
    frequencyPenalty?: number | undefined;
    stopSequences?: string[] | undefined;
    seed?: number | undefined;
  };
  output: ChatV2RequestPlan['output'];
};

export function buildChatV2RequestPlan(options: BuildChatV2RequestPlanOptions): ChatV2RequestPlan {
  const shouldStream = options.emitPartialOutputs !== false;

  return {
    provider: options.provider,
    modelId: options.modelId,
    transportMode: shouldStream ? 'stream' : 'generate',
    retry: {
      enabled: options.retryOnNon200 === true,
      repeatTimes: options.retryOnNon200 ? normalizeLLMChatV2RetryCount(options.retryOnNon200RepeatTimes) : 0,
      cooldownMs: normalizeLLMChatV2RetryCooldownMs(options.retryOnNon200CooldownMs),
    },
    request: {
      model: options.model,
      messages: options.messages,
      maxRetries: 0,
      tools: options.tools,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      responseOutput: options.responseOutput,
      responseFormat: options.responseFormat,
      providerOptions: options.providerOptions,
      toolChoice: options.toolChoice,
    },
    output: {
      outputUsage: options.outputUsage,
      outputReasoning: options.outputReasoning,
      outputRequestBody: shouldOutputChatV2RequestBody(options),
      outputResponseBody: shouldOutputChatV2ResponseBody(options),
      includeFunctionCalls: options.includeFunctionCalls,
      functionCallMode: options.functionCallMode,
    },
  };
}

export function summarizeChatV2RequestPlan(plan: ChatV2RequestPlan): ChatV2RequestPlanSummary {
  return {
    provider: plan.provider,
    modelId: plan.modelId,
    transportMode: plan.transportMode,
    sdkMaxRetries: plan.request.maxRetries ?? 0,
    retry: { ...plan.retry },
    messageCount: plan.request.messages.length,
    toolNames: Object.keys(plan.request.tools ?? {}).sort(),
    responseFormat: plan.request.responseFormat,
    generation: {
      maxTokens: plan.request.maxTokens,
      temperature: plan.request.temperature,
      topP: plan.request.topP,
      topK: plan.request.topK,
      presencePenalty: plan.request.presencePenalty,
      frequencyPenalty: plan.request.frequencyPenalty,
      stopSequences: plan.request.stopSequences,
      seed: plan.request.seed,
    },
    output: { ...plan.output },
  };
}
