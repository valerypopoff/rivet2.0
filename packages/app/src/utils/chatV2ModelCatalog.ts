import {
  DEFAULT_CHAT_ENDPOINT,
  type RivetPlugin,
  getChatV2ModelOptions,
  getPluginConfig,
  type Settings,
} from '@valerypopoff/rivet2-core';

type ChatV2Provider = 'openai' | 'anthropic' | 'google' | 'custom';
type ChatModelOption = { value: string; label: string };

type ChatModelCatalogContext = {
  settings: Settings;
  plugins: RivetPlugin[];
  apiKey?: string;
};

type ChatModelCatalogResult = {
  options: ChatModelOption[];
  source: 'api' | 'fallback';
  error?: string;
};

type OpenAIModelResponse = {
  data?: Array<{
    id?: string;
  }>;
};

type AnthropicModelResponse = {
  data?: Array<{
    id?: string;
    display_name?: string;
  }>;
};

type GoogleModelResponse = {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
};

const modelCatalogCache = new Map<string, Promise<ChatModelCatalogResult>>();

function removeTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function openAIEndpointToBaseURL(endpoint: string): string {
  const normalized = endpoint.replace(/\/(chat\/completions|responses)\/?$/i, '');

  try {
    return removeTrailingSlash(new URL(normalized).toString());
  } catch {
    return removeTrailingSlash(normalized);
  }
}

function isOpenAIChatLikeModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized.startsWith('gpt') || normalized.startsWith('o');
}

function logModelCatalogDebug(provider: ChatV2Provider, message: string, details?: unknown): void {
  const prefix = `[LLM Chat][${provider} models]`;
  if (details === undefined) {
    console.info(`${prefix} ${message}`);
  } else {
    console.info(`${prefix} ${message}`, details);
  }
}

function sortModelOptions(options: ChatModelOption[]): ChatModelOption[] {
  return [...options].sort((a, b) => a.label.localeCompare(b.label));
}

function mergeWithStaticFallback(provider: ChatV2Provider, discovered: ChatModelOption[]): ChatModelOption[] {
  const merged = new Map<string, ChatModelOption>();

  for (const option of getChatV2ModelOptions(provider)) {
    merged.set(option.value, option);
  }

  for (const option of discovered) {
    merged.set(option.value, option);
  }

  return sortModelOptions([...merged.values()]);
}

function getPluginById(plugins: RivetPlugin[], id: string): RivetPlugin | undefined {
  return plugins.find((plugin) => plugin.id === id);
}

function fingerprintSecret(secret: string | undefined): string {
  if (!secret) {
    return '';
  }

  let hash = 2166136261;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `${secret.length}:${(hash >>> 0).toString(36)}`;
}

async function fetchOpenAIModels(context: ChatModelCatalogContext): Promise<ChatModelOption[]> {
  const apiKey = context.apiKey || context.settings.openAiApiKey || context.settings.openAiKey;

  if (!apiKey) {
    logModelCatalogDebug('openai', 'No API key configured. Using built-in fallback list.');
    throw new Error('OpenAI API key is not configured.');
  }

  const baseURL = openAIEndpointToBaseURL(context.settings.openAiEndpoint || DEFAULT_CHAT_ENDPOINT);
  const requestURL = `${baseURL}/models`;
  logModelCatalogDebug('openai', `Fetching model catalog from ${requestURL}`);
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(context.settings.openAiOrganization ? { 'OpenAI-Organization': context.settings.openAiOrganization } : {}),
      ...(context.settings.chatNodeHeaders ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAI models request failed with ${response.status}`);
  }

  const data = (await response.json()) as OpenAIModelResponse;
  const discovered = (data.data ?? [])
    .map((model) => model.id?.trim())
    .filter((modelId): modelId is string => !!modelId && isOpenAIChatLikeModelId(modelId))
    .map((modelId) => ({ value: modelId, label: modelId }));

  logModelCatalogDebug(
    'openai',
    `Fetched ${discovered.length} filtered models from API.`,
    discovered.map((model) => model.value),
  );

  return mergeWithStaticFallback('openai', discovered);
}

async function fetchAnthropicModels(context: ChatModelCatalogContext): Promise<ChatModelOption[]> {
  const plugin = getPluginById(context.plugins, 'anthropic');
  const apiKey =
    context.apiKey ||
    context.settings.anthropicApiKey ||
    (plugin ? getPluginConfig(plugin, context.settings, 'anthropicApiKey') : undefined);
  const apiEndpoint = plugin ? getPluginConfig(plugin, context.settings, 'anthropicApiEndpoint') : undefined;

  if (!apiKey) {
    logModelCatalogDebug('anthropic', 'No API key configured. Using built-in fallback list.');
    throw new Error('Anthropic API key is not configured.');
  }

  const endpoint = `${removeTrailingSlash(apiEndpoint || 'https://api.anthropic.com/v1')}/models`;
  logModelCatalogDebug('anthropic', `Fetching model catalog from ${endpoint}`);
  const response = await fetch(endpoint, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(context.settings.chatNodeHeaders ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Anthropic models request failed with ${response.status}`);
  }

  const data = (await response.json()) as AnthropicModelResponse;
  const discovered = (data.data ?? [])
    .map((model) => {
      const id = model.id?.trim();
      if (!id) {
        return undefined;
      }

      return {
        value: id,
        label: model.display_name?.trim() || id,
      };
    })
    .filter((option): option is ChatModelOption => option != null);

  logModelCatalogDebug(
    'anthropic',
    `Fetched ${discovered.length} models from API.`,
    discovered.map((model) => model.value),
  );

  return mergeWithStaticFallback('anthropic', discovered);
}

async function fetchGoogleModels(context: ChatModelCatalogContext): Promise<ChatModelOption[]> {
  const plugin = getPluginById(context.plugins, 'google');
  const apiKey =
    context.apiKey ||
    context.settings.googleApiKey ||
    (plugin ? getPluginConfig(plugin, context.settings, 'googleApiKey') : undefined);

  if (!apiKey) {
    logModelCatalogDebug('google', 'No API key configured. Using built-in fallback list.');
    throw new Error('Google API key is not configured.');
  }

  const requestURL = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  logModelCatalogDebug(
    'google',
    'Fetching model catalog from https://generativelanguage.googleapis.com/v1beta/models?key=<redacted>',
  );
  const response = await fetch(requestURL, {
    headers: context.settings.chatNodeHeaders ?? {},
  });

  if (!response.ok) {
    throw new Error(`Google models request failed with ${response.status}`);
  }

  const data = (await response.json()) as GoogleModelResponse;
  const discovered = (data.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => {
      const id = model.name?.replace(/^models\//, '').trim();
      if (!id) {
        return undefined;
      }

      return {
        value: id,
        label: model.displayName?.trim() || id,
      };
    })
    .filter((option): option is ChatModelOption => option != null);

  logModelCatalogDebug(
    'google',
    `Fetched ${discovered.length} models from API.`,
    discovered.map((model) => model.value),
  );

  return mergeWithStaticFallback('google', discovered);
}

function getCacheKey(provider: ChatV2Provider, context: ChatModelCatalogContext): string {
  switch (provider) {
    case 'openai':
      return JSON.stringify([
        provider,
        context.settings.openAiEndpoint || DEFAULT_CHAT_ENDPOINT,
        context.settings.openAiOrganization || '',
        fingerprintSecret(context.apiKey || context.settings.openAiApiKey || context.settings.openAiKey),
      ]);

    case 'anthropic': {
      const plugin = getPluginById(context.plugins, 'anthropic');
      return JSON.stringify([
        provider,
        plugin ? getPluginConfig(plugin, context.settings, 'anthropicApiEndpoint') || '' : '',
        fingerprintSecret(
          context.apiKey ||
            context.settings.anthropicApiKey ||
            (plugin ? getPluginConfig(plugin, context.settings, 'anthropicApiKey') : ''),
        ),
      ]);
    }

    case 'google': {
      const plugin = getPluginById(context.plugins, 'google');
      return JSON.stringify([
        provider,
        fingerprintSecret(
          context.apiKey ||
            context.settings.googleApiKey ||
            (plugin ? getPluginConfig(plugin, context.settings, 'googleApiKey') : ''),
        ),
      ]);
    }

    case 'custom':
      return JSON.stringify([provider]);
  }
}

export async function getChatV2DiscoveredModelOptions(
  provider: ChatV2Provider,
  context: ChatModelCatalogContext,
): Promise<ChatModelOption[]> {
  const result = await getChatV2DiscoveredModelOptionsWithStatus(provider, context);
  return result.options;
}

export async function getChatV2DiscoveredModelOptionsWithStatus(
  provider: ChatV2Provider,
  context: ChatModelCatalogContext,
): Promise<ChatModelCatalogResult> {
  const cacheKey = getCacheKey(provider, context);
  const cached = modelCatalogCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const request = (async () => {
    try {
      switch (provider) {
        case 'openai':
          return {
            options: await fetchOpenAIModels(context),
            source: 'api' as const,
          };
        case 'anthropic':
          return {
            options: await fetchAnthropicModels(context),
            source: 'api' as const,
          };
        case 'google':
          return {
            options: await fetchGoogleModels(context),
            source: 'api' as const,
          };
        case 'custom':
          return {
            options: [],
            source: 'fallback' as const,
          };
      }
    } catch (error) {
      logModelCatalogDebug(
        provider,
        'API fetch failed. Falling back to built-in model list.',
        error instanceof Error ? { message: error.message } : { message: String(error) },
      );
      return {
        options: getChatV2ModelOptions(provider),
        source: 'fallback' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  modelCatalogCache.set(cacheKey, request);
  return request;
}

export function invalidateChatV2DiscoveredModelOptions(
  provider: ChatV2Provider,
  context: ChatModelCatalogContext,
): void {
  modelCatalogCache.delete(getCacheKey(provider, context));
}

export function prefetchChatV2DiscoveredModelOptions(context: ChatModelCatalogContext): void {
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    void getChatV2DiscoveredModelOptions(provider, context);
  }
}
