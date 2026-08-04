import { getInputOrData } from '../../utils/inputs.js';
import {
  hasLLMChatV2ToolResponseFormatConflict,
  LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY,
} from './chatV2FeatureCompatibility.js';
import type { LLMInvocationPlan } from './llmInvocationPlan.js';
import { buildLLMInvocationRunOptions, resolveLLMChatV2BaseURL } from './llmInvocationPlan.js';
import { applyLLMProfileToNodeData } from './llmProfile.js';
import type { LLMProfileValue } from './llmProfileTypes.js';
import {
  createResolvedChatV2Provider,
  resolveChatV2Credential,
  type ChatV2CredentialResult,
} from './chatV2ProviderProfile.js';
import {
  resolveLLMChatV2BuiltInTools,
  resolveLLMChatV2GenerationParameters,
  resolveLLMChatV2Headers,
  resolveLLMChatV2RuntimeProviderOptions,
} from './chatV2RuntimeOptions.js';
import { createChatV2ResponseOutput, mergeCustomProviderResponseFormatOptions } from './chatV2ResponseFormat.js';
import type { ChatV2PipelineRoundOptions, RunChatV2PipelineOptions } from './chatV2Types.js';
import { parseChatV2Provider, type ResolvedChatV2ProviderConfig } from './providerOptions.js';
import { restoreOpenAICompatibleInstructionRoles } from './developerMessageRoles.js';

/** A fully executable model/profile selection plus safe configuration facts. */
export type ResolvedLLMModelCandidate = {
  effectiveData: ReturnType<typeof applyLLMProfileToNodeData>;
  credential: ChatV2CredentialResult;
  providerConfig: ResolvedChatV2ProviderConfig;
  runOptions: RunChatV2PipelineOptions;
};

export async function resolveLLMModelCandidate(params: {
  plan: LLMInvocationPlan;
  profile?: LLMProfileValue | undefined;
  roundOptions?: ChatV2PipelineRoundOptions | undefined;
}): Promise<ResolvedLLMModelCandidate> {
  const { plan, profile } = params;
  const effectiveData = profile ? applyLLMProfileToNodeData(plan.data, profile) : plan.data;
  if (hasLLMChatV2ToolResponseFormatConflict(effectiveData)) {
    throw new Error(LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.paragraphs[0]);
  }

  const provider = parseChatV2Provider(effectiveData.provider);
  const modelId = getInputOrData(effectiveData, plan.inputs, 'model', 'string');
  const baseURL = resolveLLMChatV2BaseURL(effectiveData, plan.inputs);
  const headers = resolveLLMChatV2Headers(effectiveData, plan.inputs);
  const credential =
    profile?.credential ??
    resolveChatV2Credential({
      provider,
      context: plan.context,
      apiKeySource: effectiveData.apiKeySource === 'input' ? 'input' : 'configured',
      inputs: plan.inputs,
      customProgrammaticName: effectiveData.customProviderApiKeyProgrammaticName,
      customEnvironmentName: effectiveData.customProviderApiKeyEnvVarName,
    });
  const transformRequestBody =
    (provider === 'openai' || provider === 'custom') && plan.instructionRoles.includes('developer')
      ? (body: unknown) => restoreOpenAICompatibleInstructionRoles(body, plan.instructionRoles)
      : undefined;
  const resolvedProvider = await createResolvedChatV2Provider({
    provider,
    modelId,
    context: plan.context,
    baseURL,
    headers,
    credential,
    onRequestBody: plan.requestBodies == null ? undefined : (body) => plan.requestBodies!.push(body),
    onResponseBody:
      plan.responseBodyCapture == null
        ? undefined
        : (response) => plan.responseBodyCapture!.capture(response),
    transformRequestBody,
  });
  const generationParameters = resolveLLMChatV2GenerationParameters(effectiveData, plan.inputs);
  const providerOptions = mergeCustomProviderResponseFormatOptions(
    provider,
    resolveLLMChatV2RuntimeProviderOptions(effectiveData, plan.inputs),
    plan.responseFormatParameters,
  );
  const baseRunOptions =
    params.roundOptions ??
    buildLLMInvocationRunOptions({
      plan,
      provider,
      modelId,
    });

  return {
    effectiveData,
    credential,
    providerConfig: resolvedProvider.config,
    runOptions: {
      ...baseRunOptions,
      provider,
      model: resolvedProvider.model,
      modelId,
      additionalTools: resolveLLMChatV2BuiltInTools(
        effectiveData,
        plan.context,
        resolvedProvider.config,
        credential.value,
      ),
      ...generationParameters,
      responseOutput: createChatV2ResponseOutput(plan.responseFormatParameters, provider),
      responseFormat: plan.responseFormatParameters?.responseFormat,
      providerOptions,
      anthropicCacheControlTtl:
        provider === 'anthropic' ? effectiveData.anthropicCacheControlTtl || undefined : undefined,
      requestBodies: plan.requestBodies,
      responseBodies: plan.responseBodies,
      responseBodyCapture: plan.responseBodyCapture,
    },
  };
}
