import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { resolveChatV2Credential } from './chatV2ProviderProfile.js';
import {
  resolveLLMChatV2ExtraProviderOptions,
  resolveLLMChatV2GenerationParameters,
  resolveLLMChatV2Headers,
} from './chatV2RuntimeOptions.js';
import type { LLMChatV2NodeData, LLMChatV2ProfileData } from './llmChatV2NodeData.js';
import { LLM_PROFILE_VALUE_VERSION, type LLMProfileValue } from './llmProfileTypes.js';
import { parseCustomProviderApi } from './customProviderApi.js';
import { createRivetLLMProfileHealthIdentity } from './llmProfileHealthStore.js';

export function resolveLLMProfileNodeValue(params: {
  data: LLMChatV2ProfileData;
  inputs: Inputs;
  context: Pick<InternalProcessContext, 'getPluginConfig' | 'settings' | 'node' | 'project'>;
}): LLMProfileValue {
  const { data, inputs, context } = params;
  const runtimeData = data as LLMChatV2NodeData;
  const generation = resolveLLMChatV2GenerationParameters(runtimeData, inputs);
  const headers = resolveLLMChatV2Headers(runtimeData, inputs);
  const extraProviderOptions = resolveLLMChatV2ExtraProviderOptions(runtimeData, inputs);
  const model = getInputOrData(runtimeData, inputs, 'model', 'string')?.trim();
  if (!model) {
    throw new Error('LLM Profile model must be a non-empty string.');
  }

  const customProviderBaseURL =
    data.provider === 'custom'
      ? getInputOrData(
          runtimeData,
          inputs,
          'customProviderBaseURL',
          'string',
          'useCustomProviderBaseURLInput',
        )?.trim() ?? ''
      : '';
  const openAIPreviousResponseId =
    data.provider === 'openai' && data.useOpenAIPreviousResponseIdInput
      ? coerceTypeOptional(inputs['previousResponseId' as PortId], 'string') ?? data.openAIPreviousResponseId ?? ''
      : data.openAIPreviousResponseId ?? '';
  const anthropicThinkingBudget =
    data.provider === 'anthropic' && data.useAnthropicThinkingBudgetInput
      ? coerceTypeOptional(inputs['anthropicThinkingBudget' as PortId], 'number') ?? data.anthropicThinkingBudget
      : data.anthropicThinkingBudget;
  const googleThinkingBudget =
    data.provider === 'google' && data.useGoogleThinkingBudgetInput
      ? coerceTypeOptional(inputs['googleThinkingBudget' as PortId], 'number') ?? data.googleThinkingBudget
      : data.googleThinkingBudget;
  const customProviderApi = parseCustomProviderApi(data.customProviderApi);
  const credential = resolveChatV2Credential({
    provider: data.provider,
    context,
    apiKeySource: data.apiKeySource === 'input' ? 'input' : 'configured',
    inputs,
    customProgrammaticName: data.customProviderApiKeyProgrammaticName,
    customEnvironmentName: data.customProviderApiKeyEnvVarName,
  });

  const configuration: LLMChatV2ProfileData = {
    ...data,
    model,
    useModelInput: false,
    temperature: generation.temperature ?? data.temperature,
    useTemperatureInput: false,
    maxTokens: generation.maxTokens ?? data.maxTokens,
    useMaxTokensInput: false,
    topP: generation.topP,
    useTopPInput: false,
    topK: generation.topK,
    useTopKInput: false,
    presencePenalty: generation.presencePenalty,
    usePresencePenaltyInput: false,
    frequencyPenalty: generation.frequencyPenalty,
    useFrequencyPenaltyInput: false,
    stopSequences: generation.stopSequences ?? [],
    useStopSequencesInput: false,
    seed: generation.seed,
    useSeedInput: false,
    customProviderBaseURL,
    useCustomProviderBaseURLInput: false,
    customProviderApi,
    openAIPreviousResponseId,
    useOpenAIPreviousResponseIdInput: false,
    headers: Object.entries(headers ?? {}).map(([key, value]) => ({ key, value })),
    useHeadersInput: false,
    extraProviderOptions: extraProviderOptions == null ? '' : JSON.stringify(extraProviderOptions),
    useExtraProviderOptionsInput: false,
    anthropicThinkingBudget,
    useAnthropicThinkingBudgetInput: false,
    googleThinkingBudget,
    useGoogleThinkingBudgetInput: false,
  };

  // A profile can be resolved outside a loaded project, for example by a
  // programmatic caller or a focused node test. Its health identity is
  // project-scoped, so defer attaching it until LLM Chat binds the profile to
  // the executing project in that case.
  const projectId = context.project?.metadata?.id;

  return {
    version: LLM_PROFILE_VALUE_VERSION,
    credential,
    configuration,
    ...(projectId == null
      ? {}
      : {
          healthIdentity: createRivetLLMProfileHealthIdentity({
            configuration,
            credential,
            chatNodeHeaders: context.settings.chatNodeHeaders,
            projectId,
            profileNodeId: context.node.id,
          }),
        }),
  };
}
