import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import type { GptFunction } from '../DataValue.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  createChatV2ResponseOutput,
  mergeCustomProviderResponseFormatOptions,
  resolveChatV2ResponseFormatParameters,
} from './chatV2ResponseFormat.js';
import {
  hasLLMChatV2ToolResponseFormatConflict,
  LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY,
} from './chatV2FeatureCompatibility.js';
import { parseChatV2Provider } from './providerOptions.js';
import { createResolvedChatV2Provider, resolveChatV2Credential } from './chatV2ProviderProfile.js';
import type { ChatV2ProviderProfile } from './chatV2ProviderProfile.js';
import type { RunChatV2PipelineOptions } from './chatV2Types.js';
import {
  buildLLMChatV2EditorCacheKey,
  cloneLLMChatV2EditorCacheOutputs,
  resolveLLMChatV2EditorCache,
} from './chatV2EditorCache.js';
import {
  resolveLLMChatV2BuiltInTools,
  resolveLLMChatV2GenerationParameters,
  resolveLLMChatV2Headers,
  resolveLLMChatV2RuntimeProviderOptions,
  resolveLLMChatV2ToolChoice,
} from './chatV2RuntimeOptions.js';
import {
  type LLMChatV2EditorCacheKeyParts,
  type LLMChatV2NodeData,
  hasLLMChatV2BuiltInToolsEnabled,
} from './llmChatV2NodeData.js';

export { buildLLMChatV2EditorCacheKey, cloneLLMChatV2EditorCacheOutputs };
export { resolveLLMChatV2RuntimeProviderOptions } from './chatV2RuntimeOptions.js';

export type LLMChatV2RuntimeConfig = {
  providerProfile: ChatV2ProviderProfile;
  runOptions: RunChatV2PipelineOptions;
  functions: GptFunction[] | undefined;
  cacheKey: string | undefined;
  cachedOutputs: Outputs | undefined;
  editorCache: Map<string, unknown> | undefined;
  shouldAutoContinueToolCalls: boolean;
  maxToolRounds: number;
};

function resolveLLMChatV2BaseURL(data: LLMChatV2NodeData, inputs: Inputs): string | undefined {
  return data.provider === 'custom'
    ? getInputOrData(data, inputs, 'customProviderBaseURL', 'string', 'useCustomProviderBaseURLInput')?.trim() ||
        undefined
    : undefined;
}

export async function resolveLLMChatV2RuntimeConfig(params: {
  data: LLMChatV2NodeData;
  nodeId: LLMChatV2EditorCacheKeyParts['nodeId'];
  inputs: Inputs;
  context: InternalProcessContext;
}): Promise<LLMChatV2RuntimeConfig> {
  const { data, nodeId, inputs, context } = params;

  if (hasLLMChatV2ToolResponseFormatConflict(data)) {
    throw new Error(LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.paragraphs[0]);
  }

  const provider = parseChatV2Provider(data.provider);
  const modelId = getInputOrData(data, inputs, 'model', 'string');
  const baseURL = resolveLLMChatV2BaseURL(data, inputs);
  const nodeHeaders = resolveLLMChatV2Headers(data, inputs);
  const credential = resolveChatV2Credential({
    provider,
    context,
    apiKeySource: data.apiKeySource === 'input' ? 'input' : 'configured',
    inputs,
    customProgrammaticName: data.customProviderApiKeyProgrammaticName,
    customEnvironmentName: data.customProviderApiKeyEnvVarName,
  });
  const apiKey = credential.value;
  const requestBodies: unknown[] | undefined = data.outputRequestStatus ? [] : undefined;
  const resolvedProvider = await createResolvedChatV2Provider({
    provider,
    modelId,
    context,
    baseURL,
    headers: nodeHeaders,
    credential,
    onRequestBody: requestBodies == null ? undefined : (body) => requestBodies.push(body),
  });
  const providerConfig = resolvedProvider.config;
  const model = resolvedProvider.model;
  const prompt = inputs['prompt' as PortId];
  const systemPrompt = inputs['systemPrompt' as PortId];
  const functions =
    data.useToolCalling && inputs['functions' as PortId] != null
      ? (coerceTypeOptional(inputs['functions' as PortId], 'gpt-function[]') as GptFunction[] | undefined)
      : undefined;
  const toolChoice = resolveLLMChatV2ToolChoice(data);
  const responseFormatParameters = resolveChatV2ResponseFormatParameters(data, inputs);
  const providerOptions = mergeCustomProviderResponseFormatOptions(
    provider,
    resolveLLMChatV2RuntimeProviderOptions(data, inputs),
    responseFormatParameters,
  );
  const generationParameters = resolveLLMChatV2GenerationParameters(data, inputs);
  const runOptions: RunChatV2PipelineOptions = {
    provider,
    model,
    modelId,
    prompt,
    systemPrompt,
    functions,
    additionalTools: resolveLLMChatV2BuiltInTools(data, context, providerConfig, apiKey),
    ...generationParameters,
    responseOutput: createChatV2ResponseOutput(responseFormatParameters, provider),
    responseFormat: responseFormatParameters?.responseFormat,
    outputUsage: data.outputUsage,
    outputReasoning: data.outputReasoning,
    outputRequestStatus: data.outputRequestStatus,
    includeFunctionCalls: data.useToolCalling || hasLLMChatV2BuiltInToolsEnabled(data),
    emitPartialOutputs: data.useAsGraphPartialOutput,
    providerOptions,
    toolChoice,
    anthropicCacheControlTtl: provider === 'anthropic' ? data.anthropicCacheControlTtl || undefined : undefined,
    requestBodies,
    retryOnNon200: data.retryOnNon200,
    retryOnNon200RepeatTimes: data.retryOnNon200RepeatTimes,
    retryOnNon200CooldownMs: data.retryOnNon200CooldownMs,
    context,
  };

  const editorCache = data.cache ? context.editorExecutionCache : undefined;
  const { cacheKey, cachedOutputs } = resolveLLMChatV2EditorCache({
    apiKey,
    data,
    editorCache,
    functions,
    generationParameters,
    modelId,
    nodeId,
    prompt,
    provider,
    providerConfig,
    providerOptions,
    responseFormatParameters,
    systemPrompt,
    toolChoice,
  });

  return {
    providerProfile: resolvedProvider.profile,
    runOptions,
    functions,
    cacheKey,
    cachedOutputs,
    editorCache,
    shouldAutoContinueToolCalls: !!data.autoContinueToolCalls && data.useToolCalling,
    maxToolRounds: data.maxToolRounds ?? 3,
  };
}
