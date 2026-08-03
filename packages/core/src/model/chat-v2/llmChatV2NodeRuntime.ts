import { coerceTypeOptional } from '../../utils/coerceType.js';
import { cleanHeaders, getInputOrData } from '../../utils/inputs.js';
import type { GptFunction } from '../DataValue.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coercePromptToChatMessages, prependSystemPrompt } from '../chat/chatMessages.js';
import { getInstructionMessageRoles, restoreOpenAICompatibleInstructionRoles } from './developerMessageRoles.js';
import {
  createChatV2ResponseOutput,
  mergeCustomProviderResponseFormatOptions,
  resolveChatV2ResponseFormatParameters,
  type ChatV2ResponseFormatParameters,
} from './chatV2ResponseFormat.js';
import {
  hasLLMChatV2ToolResponseFormatConflict,
  LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY,
} from './chatV2FeatureCompatibility.js';
import { createLLMProfileFallbackRunner, type LLMProfileAttempt } from './llmProfileFallback.js';
import { applyLLMProfileToNodeData, normalizeLLMProfileChainInput } from './llmProfile.js';
import type { LLMProfileValue } from './llmProfileTypes.js';
import { parseChatV2Provider, resolveChatV2ProviderConfig } from './providerOptions.js';
import { createResolvedChatV2Provider, resolveChatV2Credential } from './chatV2ProviderProfile.js';
import type { ChatV2ProviderProfile } from './chatV2ProviderProfile.js';
import {
  shouldOutputChatV2RequestBody,
  shouldOutputChatV2RequestError,
  type ChatV2Model,
  type ChatV2PipelineResult,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';
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
  shouldIncludeLLMChatV2ToolCalls,
} from './llmChatV2NodeData.js';
import { runChatV2Pipeline } from './chatV2Pipeline.js';

export { buildLLMChatV2EditorCacheKey, cloneLLMChatV2EditorCacheOutputs };
export { resolveLLMChatV2RuntimeProviderOptions } from './chatV2RuntimeOptions.js';
export type { LLMProfileAttempt } from './llmProfileFallback.js';

export type LLMChatV2RuntimeConfig = {
  /**
   * Shared invocation values plus a profile-shaped placeholder in From profile
   * mode. The actual provider model is resolved lazily by `runPipeline` so a
   * broken primary candidate can advance to the next profile.
   */
  runOptions: RunChatV2PipelineOptions;
  /** A safe summary of the first configured candidate for editor/runtime consumers. */
  providerProfile: ChatV2ProviderProfile;
  runPipeline: (options: RunChatV2PipelineOptions) => Promise<ChatV2PipelineResult>;
  functions: GptFunction[] | undefined;
  cacheKey: string | undefined;
  cachedOutputs: Outputs | undefined;
  editorCache: Map<string, unknown> | undefined;
  shouldAutoContinueToolCalls: boolean;
  maxToolRounds: number;
  profileAttempts: LLMProfileAttempt[] | undefined;
  /** True only when the incoming LLM Profile value was an actual array. */
  profileChainUsesArray: boolean;
  /** Defined for From profile runs, including a scalar single-profile input. */
  profileChainLength: number | undefined;
  getProfileSummary: (() => string) | undefined;
  isProfileFallbackExhausted: () => boolean;
};

type SharedRuntimeValues = {
  data: LLMChatV2NodeData;
  inputs: Inputs;
  context: InternalProcessContext;
  prompt: unknown;
  systemPrompt: unknown;
  functions: GptFunction[] | undefined;
  responseFormatParameters: ChatV2ResponseFormatParameters;
  toolChoice: ReturnType<typeof resolveLLMChatV2ToolChoice>;
  requestBodies: unknown[] | undefined;
  instructionRoles: ReturnType<typeof getInstructionMessageRoles>;
};

function resolveLLMChatV2BaseURL(data: LLMChatV2NodeData, inputs: Inputs): string | undefined {
  return data.provider === 'custom'
    ? getInputOrData(data, inputs, 'customProviderBaseURL', 'string', 'useCustomProviderBaseURLInput')?.trim() ||
        undefined
    : undefined;
}

function createSharedRunOptions(params: {
  shared: SharedRuntimeValues;
  provider: ReturnType<typeof parseChatV2Provider>;
  modelId: string;
}): RunChatV2PipelineOptions {
  const { shared, provider, modelId } = params;
  return {
    provider,
    // From profile mode replaces this before a provider request. Keeping the
    // field populated preserves the established Tool Continuation contract.
    model: undefined as unknown as ChatV2Model,
    modelId,
    prompt: shared.prompt,
    systemPrompt: shared.systemPrompt,
    functions: shared.functions,
    responseOutput: createChatV2ResponseOutput(shared.responseFormatParameters, provider),
    responseFormat: shared.responseFormatParameters?.responseFormat,
    failProfileOnNonObjectResponse: shared.data.failProfileOnNonObjectResponse,
    outputUsage: shared.data.outputUsage,
    outputReasoning: shared.data.outputReasoning,
    outputRequestStatus: shared.data.outputRequestStatus,
    outputRequestError: shouldOutputChatV2RequestError(shared.data),
    outputRequestBody: shouldOutputChatV2RequestBody(shared.data),
    includeFunctionCalls: shouldIncludeLLMChatV2ToolCalls(shared.data),
    emitPartialOutputs: shared.data.useAsGraphPartialOutput,
    toolChoice: shared.toolChoice,
    requestBodies: shared.requestBodies,
    retryOnNon200: shared.data.retryOnNon200,
    retryOnNon200RepeatTimes: shared.data.retryOnNon200RepeatTimes,
    retryOnNon200CooldownMs: shared.data.retryOnNon200CooldownMs,
    context: shared.context,
  };
}

function createRuntimeProviderProfile(params: {
  data: LLMChatV2NodeData;
  inputs: Inputs;
  credential: ReturnType<typeof resolveChatV2Credential>;
}): ChatV2ProviderProfile {
  const provider = parseChatV2Provider(params.data.provider);
  return {
    provider,
    modelId: getInputOrData(params.data, params.inputs, 'model', 'string'),
    baseURL: resolveLLMChatV2BaseURL(params.data, params.inputs),
    hasCustomHeaders: Object.keys(resolveLLMChatV2Headers(params.data, params.inputs) ?? {}).length > 0,
    credential: params.credential.reference,
    capabilities: {
      builtInTools: provider === 'openai' || provider === 'google',
      structuredOutput: true,
    },
  };
}

async function resolveCandidateRunOptions(params: {
  shared: SharedRuntimeValues;
  profile: LLMProfileValue | undefined;
  roundOptions: RunChatV2PipelineOptions;
}): Promise<RunChatV2PipelineOptions> {
  const { shared, profile, roundOptions } = params;
  const effectiveData = profile ? applyLLMProfileToNodeData(shared.data, profile) : shared.data;

  if (hasLLMChatV2ToolResponseFormatConflict(effectiveData)) {
    throw new Error(LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.paragraphs[0]);
  }

  const provider = parseChatV2Provider(effectiveData.provider);
  const modelId = getInputOrData(effectiveData, shared.inputs, 'model', 'string');
  const baseURL = resolveLLMChatV2BaseURL(effectiveData, shared.inputs);
  const headers = resolveLLMChatV2Headers(effectiveData, shared.inputs);
  const credential =
    profile?.credential ??
    resolveChatV2Credential({
      provider,
      context: shared.context,
      apiKeySource: effectiveData.apiKeySource === 'input' ? 'input' : 'configured',
      inputs: shared.inputs,
      customProgrammaticName: effectiveData.customProviderApiKeyProgrammaticName,
      customEnvironmentName: effectiveData.customProviderApiKeyEnvVarName,
    });
  const transformRequestBody =
    (provider === 'openai' || provider === 'custom') && shared.instructionRoles.includes('developer')
      ? (body: unknown) => restoreOpenAICompatibleInstructionRoles(body, shared.instructionRoles)
      : undefined;
  const resolvedProvider = await createResolvedChatV2Provider({
    provider,
    modelId,
    context: shared.context,
    baseURL,
    headers,
    credential,
    onRequestBody: shared.requestBodies == null ? undefined : (body) => shared.requestBodies!.push(body),
    transformRequestBody,
  });
  const generationParameters = resolveLLMChatV2GenerationParameters(effectiveData, shared.inputs);
  const providerOptions = mergeCustomProviderResponseFormatOptions(
    provider,
    resolveLLMChatV2RuntimeProviderOptions(effectiveData, shared.inputs),
    shared.responseFormatParameters,
  );

  return {
    ...roundOptions,
    provider,
    model: resolvedProvider.model,
    modelId,
    additionalTools: resolveLLMChatV2BuiltInTools(
      effectiveData,
      shared.context,
      resolvedProvider.config,
      credential.value,
    ),
    ...generationParameters,
    responseOutput: createChatV2ResponseOutput(shared.responseFormatParameters, provider),
    responseFormat: shared.responseFormatParameters?.responseFormat,
    providerOptions,
    anthropicCacheControlTtl:
      provider === 'anthropic' ? effectiveData.anthropicCacheControlTtl || undefined : undefined,
    requestBodies: shared.requestBodies,
  };
}

function createSharedRuntimeValues(params: {
  data: LLMChatV2NodeData;
  inputs: Inputs;
  context: InternalProcessContext;
}): SharedRuntimeValues {
  const { data, inputs, context } = params;
  const prompt = inputs['prompt' as PortId];
  const systemPrompt = inputs['systemPrompt' as PortId];
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
    instructionRoles: getInstructionMessageRoles(prependSystemPrompt(coercePromptToChatMessages(prompt), systemPrompt)),
  };
}

export async function resolveLLMChatV2RuntimeConfig(params: {
  data: LLMChatV2NodeData;
  nodeId: LLMChatV2EditorCacheKeyParts['nodeId'];
  inputs: Inputs;
  context: InternalProcessContext;
}): Promise<LLMChatV2RuntimeConfig> {
  const { data, nodeId, inputs, context } = params;
  const profileInput = inputs['llmProfile' as PortId];
  if (data.configurationMode === 'profile' && profileInput == null) {
    throw new Error('LLM Profile input is required when Configuration is From profile.');
  }

  const shared = createSharedRuntimeValues({ data, inputs, context });
  const editorCache = data.cache ? context.editorExecutionCache : undefined;

  if (data.configurationMode !== 'profile') {
    const inlineRunOptions = await resolveCandidateRunOptions({
      shared,
      profile: undefined,
      roundOptions: createSharedRunOptions({
        shared,
        provider: parseChatV2Provider(data.provider),
        modelId: data.model,
      }),
    });
    const generationParameters = resolveLLMChatV2GenerationParameters(data, inputs);
    const inlineCredential = resolveChatV2Credential({
      provider: inlineRunOptions.provider,
      context,
      apiKeySource: data.apiKeySource === 'input' ? 'input' : 'configured',
      inputs,
      customProgrammaticName: data.customProviderApiKeyProgrammaticName,
      customEnvironmentName: data.customProviderApiKeyEnvVarName,
    });
    const inlineProviderConfig = await resolveChatV2ProviderConfig(
      inlineRunOptions.provider,
      inlineRunOptions.modelId,
      context,
      {
        baseURL: resolveLLMChatV2BaseURL(data, inputs),
        headers: resolveLLMChatV2Headers(data, inputs),
      },
    );
    const { cacheKey, cachedOutputs } = resolveLLMChatV2EditorCache({
      apiKey: inlineCredential.value,
      data,
      editorCache,
      functions: shared.functions,
      generationParameters,
      modelId: inlineRunOptions.modelId,
      nodeId,
      prompt: shared.prompt,
      provider: inlineRunOptions.provider,
      providerConfig: inlineProviderConfig,
      providerOptions: inlineRunOptions.providerOptions,
      responseFormatParameters: shared.responseFormatParameters,
      systemPrompt: shared.systemPrompt,
      toolChoice: shared.toolChoice,
    });

    return {
      runOptions: inlineRunOptions,
      providerProfile: createRuntimeProviderProfile({
        data,
        inputs,
        credential: inlineCredential,
      }),
      runPipeline: runChatV2Pipeline,
      functions: shared.functions,
      cacheKey,
      cachedOutputs,
      editorCache,
      shouldAutoContinueToolCalls: !!data.autoContinueToolCalls && data.useToolCalling,
      maxToolRounds: data.maxToolRounds ?? 3,
      profileAttempts: undefined,
      profileChainUsesArray: false,
      profileChainLength: undefined,
      getProfileSummary: undefined,
      isProfileFallbackExhausted: () => false,
    };
  }

  const profiles = normalizeLLMProfileChainInput(profileInput?.value);
  const firstProfile = profiles[0]!;
  const firstProvider = parseChatV2Provider(firstProfile.configuration.provider);
  const profileRunOptions = createSharedRunOptions({
    shared,
    provider: firstProvider,
    modelId: firstProfile.configuration.model,
  });
  const firstProfileData = applyLLMProfileToNodeData(data, firstProfile);
  Object.assign(profileRunOptions, {
    ...resolveLLMChatV2GenerationParameters(firstProfileData, inputs),
    providerOptions: mergeCustomProviderResponseFormatOptions(
      firstProvider,
      resolveLLMChatV2RuntimeProviderOptions(firstProfileData, inputs),
      shared.responseFormatParameters,
    ),
    anthropicCacheControlTtl:
      firstProvider === 'anthropic' ? firstProfileData.anthropicCacheControlTtl || undefined : undefined,
  });
  const fallbackRunner = createLLMProfileFallbackRunner({
    candidates: profiles.map((profile) => ({
      provider: parseChatV2Provider(profile.configuration.provider),
      model: profile.configuration.model,
      credential: profile.credential.value,
      redactionValues: [
        ...profile.configuration.headers.map((header) => header.value),
        ...Object.values(cleanHeaders(context.settings?.chatNodeHeaders ?? {})),
      ],
    })),
    resolveCandidate: (profileIndex, roundOptions) =>
      resolveCandidateRunOptions({
        shared,
        profile: profiles[profileIndex]!,
        roundOptions,
      }),
  });
  const { cacheKey, cachedOutputs } = resolveLLMChatV2EditorCache({
    apiKey: undefined,
    data: firstProfileData,
    editorCache,
    functions: shared.functions,
    generationParameters: undefined,
    modelId: firstProfile.configuration.model,
    nodeId,
    prompt: shared.prompt,
    provider: firstProvider,
    // Profile headers are part of the individual profile fingerprints, but
    // provider resolution also merges project-wide Chat headers. Include those
    // values through the existing redacted provider-config fingerprint so a
    // global-header edit cannot reuse a stale profile-mode editor cache entry.
    providerConfig: { headers: cleanHeaders(context.settings?.chatNodeHeaders ?? {}) },
    providerOptions: undefined,
    responseFormatParameters: shared.responseFormatParameters,
    systemPrompt: shared.systemPrompt,
    toolChoice: shared.toolChoice,
    profileChain: profiles,
    profileChainUsesArray: Array.isArray(profileInput?.value),
  });

  return {
    runOptions: profileRunOptions,
    providerProfile: createRuntimeProviderProfile({
      data: firstProfileData,
      inputs,
      credential: firstProfile.credential,
    }),
    runPipeline: fallbackRunner.run,
    functions: shared.functions,
    cacheKey,
    cachedOutputs,
    editorCache,
    shouldAutoContinueToolCalls: !!data.autoContinueToolCalls && data.useToolCalling,
    maxToolRounds: data.maxToolRounds ?? 3,
    profileAttempts: fallbackRunner.attempts,
    profileChainUsesArray: Array.isArray(profileInput?.value),
    profileChainLength: profiles.length,
    getProfileSummary: fallbackRunner.summary,
    isProfileFallbackExhausted: fallbackRunner.wasExhausted,
  };
}
