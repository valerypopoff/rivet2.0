import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import type { GptFunction } from '../DataValue.js';
import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coercePromptToChatMessages, prependSystemPrompt } from '../chat/chatMessages.js';
import { getInstructionMessageRoles } from './developerMessageRoles.js';
import {
  createChatV2ResponseOutput,
  resolveChatV2ResponseFormatParameters,
  type ChatV2ResponseFormatParameters,
} from './chatV2ResponseFormat.js';
import { resolveLLMChatV2ToolChoice } from './chatV2RuntimeOptions.js';
import { shouldIncludeLLMChatV2ToolCalls, type LLMChatV2NodeData } from './llmChatV2NodeData.js';
import {
  shouldOutputChatV2RequestBody,
  shouldOutputChatV2ResponseBody,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';
import type { parseChatV2Provider } from './providerOptions.js';
import { createChatV2ResponseBodyCapture, type ChatV2ResponseBodyCapture } from './chatV2ResponseBodyCapture.js';

/** Provider-neutral state assembled once per root LLM invocation. */
export type LLMInvocationPlan = {
  data: LLMChatV2NodeData;
  inputs: Inputs;
  context: InternalProcessContext;
  prompt: unknown;
  systemPrompt: unknown;
  functions: GptFunction[] | undefined;
  responseFormatParameters: ChatV2ResponseFormatParameters;
  toolChoice: ReturnType<typeof resolveLLMChatV2ToolChoice>;
  requestBodies: unknown[] | undefined;
  responseBodies: unknown[] | undefined;
  responseBodyCapture: ChatV2ResponseBodyCapture | undefined;
  instructionRoles: ReturnType<typeof getInstructionMessageRoles>;
};

export function resolveLLMChatV2BaseURL(data: LLMChatV2NodeData, inputs: Inputs): string | undefined {
  return data.provider === 'custom'
    ? getInputOrData(data, inputs, 'customProviderBaseURL', 'string', 'useCustomProviderBaseURLInput')?.trim() ||
        undefined
    : undefined;
}

export function buildLLMInvocationPlan(params: {
  data: LLMChatV2NodeData;
  inputs: Inputs;
  context: InternalProcessContext;
}): LLMInvocationPlan {
  const { data, inputs, context } = params;
  const prompt = inputs['prompt' as PortId];
  const systemPrompt = inputs['systemPrompt' as PortId];
  const responseBodyCapture = shouldOutputChatV2ResponseBody(data) ? createChatV2ResponseBodyCapture() : undefined;
  return {
    data,
    inputs,
    context,
    prompt,
    systemPrompt,
    functions:
      data.useToolCalling && inputs['functions' as PortId] != null
        ? (coerceTypeOptional(inputs['functions' as PortId], 'gpt-function[]') as GptFunction[] | undefined)
        : undefined,
    responseFormatParameters: resolveChatV2ResponseFormatParameters(data, inputs),
    toolChoice: resolveLLMChatV2ToolChoice(data),
    requestBodies: shouldOutputChatV2RequestBody(data) ? [] : undefined,
    responseBodies: responseBodyCapture?.bodies,
    responseBodyCapture,
    instructionRoles: getInstructionMessageRoles(prependSystemPrompt(coercePromptToChatMessages(prompt), systemPrompt)),
  };
}

/**
 * Build the provider-neutral portion of an executable round. A model is never
 * fabricated here; candidate resolution supplies it before this reaches the
 * request pipeline.
 */
export function buildLLMInvocationRunOptions(params: {
  plan: LLMInvocationPlan;
  provider: ReturnType<typeof parseChatV2Provider>;
  modelId: string;
}): Omit<RunChatV2PipelineOptions, 'model'> {
  const { plan, provider, modelId } = params;
  return {
    provider,
    modelId,
    prompt: plan.prompt,
    systemPrompt: plan.systemPrompt,
    functions: plan.functions,
    responseOutput: createChatV2ResponseOutput(plan.responseFormatParameters, provider, plan.data.customProviderApi),
    responseFormat: plan.responseFormatParameters?.responseFormat,
    outputUsage: plan.data.outputUsage,
    outputReasoning: plan.data.outputReasoning,
    outputRequestBody: shouldOutputChatV2RequestBody(plan.data),
    outputResponseBody: shouldOutputChatV2ResponseBody(plan.data),
    includeFunctionCalls: shouldIncludeLLMChatV2ToolCalls(plan.data),
    emitPartialOutputs: plan.data.useAsGraphPartialOutput,
    toolChoice: plan.toolChoice,
    requestBodies: plan.requestBodies,
    responseBodies: plan.responseBodies,
    responseBodyCapture: plan.responseBodyCapture,
    retryOnNon200: plan.data.retryOnNon200,
    retryOnNon200RepeatTimes: plan.data.retryOnNon200RepeatTimes,
    retryOnNon200CooldownMs: plan.data.retryOnNon200CooldownMs,
    context: plan.context,
  };
}
