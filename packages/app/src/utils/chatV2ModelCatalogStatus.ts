import {
  getPluginConfig,
  type ChatV2Provider,
  type RivetPlugin,
  type Settings,
} from '@valerypopoff/rivet2-core';

export type ChatV2ModelRefreshStatus =
  | {
      tone: 'success' | 'warning';
      message: string;
    }
  | undefined;

type ModelRefreshResult = {
  options: { value: string; label: string }[];
  source: 'api' | 'fallback';
  error?: string;
};

export function getChatV2MissingCredentialMessage(
  provider: ChatV2Provider,
  resolvedSettings: Settings,
  plugins: RivetPlugin[],
  apiKey?: string,
): string | undefined {
  const plugin = plugins.find((candidate) => candidate.id === provider);

  switch (provider) {
    case 'openai':
      return apiKey || resolvedSettings.openAiApiKey || resolvedSettings.openAiKey
        ? undefined
        : 'OpenAI API key is not configured.';
    case 'anthropic':
      return apiKey || resolvedSettings.anthropicApiKey || getPluginConfig(plugin, resolvedSettings, 'anthropicApiKey')
        ? undefined
        : 'Anthropic API key is not configured.';
    case 'google':
      return apiKey || resolvedSettings.googleApiKey || getPluginConfig(plugin, resolvedSettings, 'googleApiKey')
        ? undefined
        : 'Google API key is not configured.';
    case 'custom':
      return undefined;
  }
}

export function getChatV2ModelRefreshStatus(
  provider: ChatV2Provider,
  result: ModelRefreshResult,
  resolvedSettings: Settings,
  plugins: RivetPlugin[],
  apiKey?: string,
): ChatV2ModelRefreshStatus {
  if (result.source === 'api') {
    return {
      tone: 'success',
      message: `Loaded ${result.options.length} models from ${provider}.`,
    };
  }

  return {
    tone: 'warning',
    message: `Using built-in ${provider} model list (${result.options.length}). ${
      getChatV2MissingCredentialMessage(provider, resolvedSettings, plugins, apiKey) ??
      result.error ??
      'API fetch failed.'
    }`,
  };
}
