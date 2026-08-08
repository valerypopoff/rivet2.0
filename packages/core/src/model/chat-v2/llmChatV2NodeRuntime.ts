import { cleanHeaders } from '../../utils/inputs.js';
import type { GptFunction } from '../DataValue.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { createLLMProfileFallbackRunner, getLLMAttemptErrorMessage, type LLMAttempt } from './llmProfileFallback.js';
import { applyLLMProfileToNodeData, normalizeLLMProfileChainInput } from './llmProfile.js';
import { buildLLMInvocationPlan, buildLLMInvocationRunOptions } from './llmInvocationPlan.js';
import { resolveLLMModelCandidate } from './llmModelCandidate.js';
import { mergeCustomProviderResponseFormatOptions } from './chatV2ResponseFormat.js';
import { getLLMChatV2EditorCacheEligibility } from './llmChatV2CachePolicy.js';
import { parseChatV2Provider } from './providerOptions.js';
import { parseCustomProviderApi } from './customProviderApi.js';
import type { ChatV2Model, ChatV2PipelineRoundOptions, ChatV2PipelineResult } from './chatV2Types.js';
import {
  buildLLMChatV2EditorCacheKey,
  cloneLLMChatV2EditorCacheOutputs,
  resolveLLMChatV2EditorCache,
} from './chatV2EditorCache.js';
import {
  resolveLLMChatV2GenerationParameters,
  resolveLLMChatV2RuntimeProviderOptions,
} from './chatV2RuntimeOptions.js';
import { type LLMChatV2EditorCacheKeyParts, type LLMChatV2NodeData } from './llmChatV2NodeData.js';
import { isChatV2ResponseValidationError, runChatV2Pipeline } from './chatV2Pipeline.js';

export { buildLLMChatV2EditorCacheKey, cloneLLMChatV2EditorCacheOutputs };
export { resolveLLMChatV2RuntimeProviderOptions } from './chatV2RuntimeOptions.js';
export type { LLMAttempt } from './llmProfileFallback.js';

export type LLMChatV2RuntimeConfig = {
  /**
   * Initial continuation-round settings. In From profile mode, `runPipeline`
   * resolves the actual provider model lazily so a broken primary candidate
   * can advance to the next profile before any provider request is made.
   */
  /** Inline keeps its resolved model for compatibility/inspection; profile mode intentionally omits it. */
  runOptions: ChatV2PipelineRoundOptions & { model?: ChatV2Model | undefined };
  runPipeline: (options: ChatV2PipelineRoundOptions) => Promise<ChatV2PipelineResult>;
  functions: GptFunction[] | undefined;
  cacheKey: string | undefined;
  cachedOutputs: Outputs | undefined;
  editorCache: Map<string, unknown> | undefined;
  shouldAutoContinueToolCalls: boolean;
  maxToolRounds: number;
  outputLLMAttempts: boolean;
  getProfileSummary: (() => string) | undefined;
  isProfileFallbackExhausted: () => boolean;
};

export async function resolveLLMChatV2RuntimeConfig(params: {
  data: LLMChatV2NodeData;
  nodeId: LLMChatV2EditorCacheKeyParts['nodeId'];
  inputs: Inputs;
  context: InternalProcessContext;
  /** Invocation-owned observer; it must not affect fallback recovery. */
  onLLMAttempt?: ((attempt: LLMAttempt) => void) | undefined;
}): Promise<LLMChatV2RuntimeConfig> {
  const { data, nodeId, inputs, context } = params;
  const profileInput = inputs['llmProfile' as PortId];
  if (data.configurationMode === 'profile' && profileInput == null) {
    throw new Error('LLM Profile input is required when Configuration is From profile.');
  }

  const plan = buildLLMInvocationPlan({ data, inputs, context });
  if (data.configurationMode !== 'profile') {
    // The editor cache cannot faithfully replay tool handlers, connected
    // Delegate runs, provider-native tools, or their side effects. A legacy
    // cache-enabled node therefore remains cacheable only for ordinary model
    // calls without tool use.
    const editorCache = getEligibleEditorCache(data, context);
    const inlineCandidate = await resolveLLMModelCandidate({
      plan,
      profile: undefined,
      roundOptions: buildLLMInvocationRunOptions({
        plan,
        provider: parseChatV2Provider(data.provider),
        modelId: data.model,
      }),
    });
    const inlineRunOptions = inlineCandidate.runOptions;
    const generationParameters = resolveLLMChatV2GenerationParameters(data, inputs);
    const { cacheKey, cachedOutputs } = resolveLLMChatV2EditorCache({
      apiKey: inlineCandidate.credential.value,
      data,
      editorCache,
      functions: plan.functions,
      generationParameters,
      modelId: inlineRunOptions.modelId,
      nodeId,
      prompt: plan.prompt,
      provider: inlineRunOptions.provider,
      providerConfig: inlineCandidate.providerConfig,
      providerOptions: inlineRunOptions.providerOptions,
      responseFormatParameters: plan.responseFormatParameters,
      systemPrompt: plan.systemPrompt,
      toolChoice: plan.toolChoice,
    });

    return {
      runOptions: inlineRunOptions,
      runPipeline: async (roundOptions) => {
        try {
          return await runChatV2Pipeline({
            ...roundOptions,
            model: inlineRunOptions.model,
            onProviderAttempt: (attempt) => {
              try {
                roundOptions.onProviderAttempt?.(attempt);
              } catch {
                // A caller-owned observer must not affect the physical request.
              }
              try {
                params.onLLMAttempt?.({
                  roundIndex: roundOptions.roundIndex ?? 0,
                  provider: inlineRunOptions.provider,
                  model: inlineRunOptions.modelId,
                  ...(inlineRunOptions.customProviderApi == null
                    ? {}
                    : { customProviderApi: inlineRunOptions.customProviderApi }),
                  stage: 'request',
                  outcome:
                    attempt.outcome === 'success' ? 'success' : attempt.outcome === 'aborted' ? 'aborted' : 'failure',
                  attemptIndex: attempt.attemptIndex,
                  ...(attempt.status == null ? {} : { status: attempt.status }),
                  ...(attempt.error == null ? {} : { error: getLLMAttemptErrorMessage(attempt.error) }),
                });
              } catch {
                // Diagnostics must never affect a model invocation.
              }
            },
          });
        } catch (error) {
          if (isChatV2ResponseValidationError(error)) {
            try {
              params.onLLMAttempt?.({
                roundIndex: roundOptions.roundIndex ?? 0,
                provider: inlineRunOptions.provider,
                model: inlineRunOptions.modelId,
                ...(inlineRunOptions.customProviderApi == null
                  ? {}
                  : { customProviderApi: inlineRunOptions.customProviderApi }),
                stage: 'response-validation',
                outcome: 'failure',
                error: getLLMAttemptErrorMessage(error),
              });
            } catch {
              // Diagnostics must never affect a model invocation.
            }
          }
          throw error;
        }
      },
      functions: plan.functions,
      cacheKey,
      cachedOutputs,
      editorCache,
      shouldAutoContinueToolCalls: !!data.autoContinueToolCalls && data.useToolCalling,
      maxToolRounds: data.maxToolRounds ?? 3,
      outputLLMAttempts: data.outputLLMAttempts === true,
      getProfileSummary: undefined,
      isProfileFallbackExhausted: () => false,
    };
  }

  const profiles = normalizeLLMProfileChainInput(profileInput?.value);
  // Profile-owned provider-native capabilities are resolved only after the
  // input profile is normalized. One cache entry covers the complete fallback
  // chain, so every possible candidate must be replay-safe.
  const editorCache = profiles.every(
    (profile) => getLLMChatV2EditorCacheEligibility({ ...data, ...profile.configuration }).eligible,
  )
    ? context.editorExecutionCache
    : undefined;
  const firstProfile = profiles[0]!;
  const firstProvider = parseChatV2Provider(firstProfile.configuration.provider);
  // The fallback runner resolves a real model before every physical request.
  // This is deliberately a provider-neutral round template, never a fake
  // executable model state.
  const profileRunOptions = {
    ...buildLLMInvocationRunOptions({
      plan,
      provider: firstProvider,
      modelId: firstProfile.configuration.model,
    }),
  } satisfies ChatV2PipelineRoundOptions;
  const firstProfileData = applyLLMProfileToNodeData(data, firstProfile);
  Object.assign(profileRunOptions, {
    ...resolveLLMChatV2GenerationParameters(firstProfileData, inputs),
    providerOptions: mergeCustomProviderResponseFormatOptions(
      firstProvider,
      resolveLLMChatV2RuntimeProviderOptions(firstProfileData, inputs),
      plan.responseFormatParameters,
      firstProfileData.customProviderApi,
    ),
    anthropicCacheControlTtl:
      firstProvider === 'anthropic' ? firstProfileData.anthropicCacheControlTtl || undefined : undefined,
  });
  const fallbackRunner = createLLMProfileFallbackRunner({
    candidates: profiles.map((profile) => ({
      provider: parseChatV2Provider(profile.configuration.provider),
      model: profile.configuration.model,
      ...(profile.configuration.provider === 'custom'
        ? { customProviderApi: parseCustomProviderApi(profile.configuration.customProviderApi) }
        : {}),
    })),
    resolveCandidate: (profileIndex, roundOptions) =>
      resolveLLMModelCandidate({
        plan,
        profile: profiles[profileIndex]!,
        roundOptions,
      }).then((candidate) => candidate.runOptions),
    onAttempt: params.onLLMAttempt,
  });
  const { cacheKey, cachedOutputs } = resolveLLMChatV2EditorCache({
    apiKey: undefined,
    data: firstProfileData,
    editorCache,
    functions: plan.functions,
    generationParameters: undefined,
    modelId: firstProfile.configuration.model,
    nodeId,
    prompt: plan.prompt,
    provider: firstProvider,
    // Profile headers are part of the individual profile fingerprints, but
    // provider resolution also merges project-wide Chat headers. Include those
    // values through the normalized provider-config fingerprint so a
    // global-header edit cannot reuse a stale profile-mode editor cache entry.
    providerConfig: { headers: cleanHeaders(context.settings?.chatNodeHeaders ?? {}) },
    providerOptions: undefined,
    responseFormatParameters: plan.responseFormatParameters,
    systemPrompt: plan.systemPrompt,
    toolChoice: plan.toolChoice,
    profileChain: profiles,
  });

  return {
    runOptions: profileRunOptions,
    runPipeline: fallbackRunner.run,
    functions: plan.functions,
    cacheKey,
    cachedOutputs,
    editorCache,
    shouldAutoContinueToolCalls: !!data.autoContinueToolCalls && data.useToolCalling,
    maxToolRounds: data.maxToolRounds ?? 3,
    outputLLMAttempts: data.outputLLMAttempts === true,
    getProfileSummary: fallbackRunner.summary,
    isProfileFallbackExhausted: fallbackRunner.wasExhausted,
  };
}

function getEligibleEditorCache(data: LLMChatV2NodeData, context: InternalProcessContext) {
  return getLLMChatV2EditorCacheEligibility(data).eligible ? context.editorExecutionCache : undefined;
}
