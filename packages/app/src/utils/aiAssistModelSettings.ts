import {
  getChatV2ModelOptions,
  getDefaultChatV2Model,
  type ChatV2Provider,
} from '@valerypopoff/rivet2-core';

export type AiAssistProvider = Extract<ChatV2Provider, 'openai' | 'anthropic' | 'google' | 'custom'>;
type BuiltInAiAssistProvider = Exclude<AiAssistProvider, 'custom'>;
export type AiAssistModelSelectorValue = `${BuiltInAiAssistProvider}:${string}` | 'custom';
export type AiAssistModelOption = {
  value: AiAssistModelSelectorValue;
  label: string;
};

export const customAiAssistModelOption = {
  label: 'Custom provider',
  value: 'custom',
} as const;

export const aiAssistProviderOptions = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
  customAiAssistModelOption,
] as const;

export const defaultAiAssistModelSelectorValue = getDefaultAiAssistModelForProvider('anthropic');

export type ResolvedAiAssistModelSettings = {
  displayName: string;
  provider: AiAssistProvider;
  graphApi: 'openai' | 'anthropic';
  model: string;
  customProviderBaseURL?: string;
  missingConfiguration?: string;
};

export function getAiAssistProviderFromModel(value: AiAssistModelSelectorValue | string | undefined): AiAssistProvider {
  if (value === 'custom') {
    return 'custom';
  }

  return getBuiltInProviderFromModel(value) ?? getBuiltInProviderFromModel(defaultAiAssistModelSelectorValue)!;
}

export function getAiAssistProviderOption(provider: AiAssistProvider) {
  return aiAssistProviderOptions.find((option) => option.value === provider) ?? aiAssistProviderOptions[0];
}

export function getAiAssistModelOptionsForProvider(provider: AiAssistProvider) {
  if (provider === 'custom') {
    return [];
  }

  return createAiAssistModelOptions(provider, getChatV2ModelOptions(provider));
}

export function getDefaultAiAssistModelForProvider(provider: AiAssistProvider): AiAssistModelSelectorValue {
  return provider === 'custom' ? 'custom' : createAiAssistModelValue(provider, getDefaultChatV2Model(provider));
}

export function getAiAssistModelOptionForProvider(
  value: AiAssistModelSelectorValue | string | undefined,
  provider: AiAssistProvider,
  options = getAiAssistModelOptionsForProvider(provider),
) {
  return (
    options.find((option) => option.value === value) ??
    options.find((option) => option.value === getDefaultAiAssistModelForProvider(provider)) ??
    options[0]
  );
}

function getExactAiAssistModelOption(value: AiAssistModelSelectorValue | string | undefined) {
  const provider = getBuiltInProviderFromModel(value);
  return provider == null
    ? undefined
    : getAiAssistModelOptionsForProvider(provider).find((option) => option.value === value);
}

export function createAiAssistModelValue(provider: BuiltInAiAssistProvider, model: string): AiAssistModelSelectorValue {
  return `${provider}:${model}`;
}

export function createAiAssistModelOptions(
  provider: BuiltInAiAssistProvider,
  modelOptions: { value: string; label: string }[],
): AiAssistModelOption[] {
  return modelOptions.map((option) => ({
    label: option.label,
    value: createAiAssistModelValue(provider, option.value),
  }));
}

export function includeCurrentAiAssistModelOption(
  options: AiAssistModelOption[],
  currentModel: AiAssistModelSelectorValue | string | undefined,
  provider: AiAssistProvider,
): AiAssistModelOption[] {
  if (provider === 'custom' || getAiAssistProviderFromModel(currentModel) !== provider) {
    return options;
  }

  const model = getAiAssistModelId(currentModel);
  if (!model || options.some((option) => option.value === currentModel)) {
    return options;
  }

  return [{ value: createAiAssistModelValue(provider, model), label: `${model} (Current)` }, ...options];
}

export function resolveAiAssistModelSettings({
  customModel,
  customProviderBaseURL,
  selectedModel,
}: {
  customModel: string;
  customProviderBaseURL: string;
  selectedModel: AiAssistModelSelectorValue | string;
}): ResolvedAiAssistModelSettings {
  if (selectedModel === 'custom') {
    const model = customModel.trim();
    const baseURL = customProviderBaseURL.trim();

    return {
      displayName: model ? `Custom: ${model}` : 'Custom provider',
      provider: 'custom',
      graphApi: 'openai',
      model,
      customProviderBaseURL: baseURL,
      missingConfiguration: !baseURL
        ? 'Set the custom provider API URL in Settings > LLM.'
        : !model
          ? 'Set the custom provider model in Settings > LLM.'
          : undefined,
    };
  }

  const api = getBuiltInProviderFromModel(selectedModel);
  const model = getAiAssistModelId(selectedModel);

  if (!api || !model) {
    return resolveAiAssistModelSettings({
      customModel,
      customProviderBaseURL,
      selectedModel: defaultAiAssistModelSelectorValue,
    });
  }

  const selectedOption = getExactAiAssistModelOption(selectedModel);

  return {
    displayName: selectedOption?.label ?? model,
    provider: api,
    graphApi: api === 'anthropic' ? 'anthropic' : 'openai',
    model,
  };
}

function getBuiltInProviderFromModel(value: string | undefined): BuiltInAiAssistProvider | undefined {
  const separatorIndex = value?.indexOf(':') ?? -1;
  const provider = separatorIndex === -1 ? undefined : value?.slice(0, separatorIndex);
  return provider === 'openai' || provider === 'anthropic' || provider === 'google' ? provider : undefined;
}

function getAiAssistModelId(value: string | undefined): string | undefined {
  const separatorIndex = value?.indexOf(':') ?? -1;
  const model = separatorIndex === -1 ? undefined : value?.slice(separatorIndex + 1).trim();
  return model || undefined;
}
