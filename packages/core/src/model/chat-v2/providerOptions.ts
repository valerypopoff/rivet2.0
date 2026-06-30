import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { DEFAULT_CHAT_ENDPOINT } from '../../utils/defaults.js';
import { cleanHeaders } from '../../utils/inputs.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { ChatV2Model, ChatV2Provider } from './chatV2Types.js';
import { getChatV2ModelRegistry } from './modelRegistry.js';

export const chatV2ProviderOptions = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'custom', label: 'Custom provider' },
] as const;

export const openAIReasoningEffortOptions = [
  { value: '', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

export const openAIWebSearchContextSizeOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const anthropicThinkingModeOptions = [
  { value: '', label: 'Default' },
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

export const anthropicEffortOptions = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export const googleThinkingLevelOptions = [
  { value: '', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const anthropicCacheControlTtlOptions = [
  { value: '', label: 'Default' },
  { value: '5m', label: '5 minutes' },
  { value: '1h', label: '1 hour' },
];

export function getChatV2ProviderLabel(provider: ChatV2Provider): string {
  return chatV2ProviderOptions.find((option) => option.value === provider)?.label ?? provider;
}

export function getChatV2ModelOptions(provider: ChatV2Provider): { value: string; label: string }[] {
  const registry = getChatV2ModelRegistry()[provider];

  return Object.entries(registry)
    .map(([value, model]) => ({
      value,
      label: model.displayName,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getDefaultChatV2Model(provider: ChatV2Provider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5';
    case 'anthropic':
      return 'claude-sonnet-4-20250514';
    case 'google':
      return 'gemini-2.5-flash';
    case 'custom':
      return 'model-id';
  }
}

export function parseChatV2Provider(value: string): ChatV2Provider {
  switch (value) {
    case 'openai':
    case 'anthropic':
    case 'google':
    case 'custom':
      return value;
    default:
      throw new Error(`Unsupported LLM Chat provider: ${value}`);
  }
}

export type CreateChatV2ModelOptions = {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
  onRequestBody?: ((body: unknown) => void) | undefined;
};

type StructuredOutputCapableChatModel = ChatV2Model & {
  supportsStructuredOutputs?: boolean;
};

export type ResolveChatV2ProviderConfigContext = Pick<
  InternalProcessContext,
  'getChatNodeEndpoint' | 'getPluginConfig' | 'settings'
>;

export type ResolvedChatV2ProviderConfig = {
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
};

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

export function openAICompatibleEndpointToBaseURL(endpoint: string): string {
  return openAIEndpointToBaseURL(endpoint);
}

function openAIBaseURLToEndpoint(baseURL: string): string {
  const normalizedBaseURL = removeTrailingSlash(baseURL);

  try {
    const url = new URL(normalizedBaseURL);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
    return url.toString();
  } catch {
    return `${normalizedBaseURL}/chat/completions`;
  }
}

function parseBodyText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseFetchBody(body: BodyInit | null | undefined): unknown {
  if (body == null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return parseBodyText(body);
  }

  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }

  if (body instanceof ArrayBuffer) {
    return parseBodyText(new TextDecoder().decode(body));
  }

  if (ArrayBuffer.isView(body)) {
    return parseBodyText(new TextDecoder().decode(body));
  }

  return undefined;
}

function cloneCapturedRequestBody(body: unknown): unknown {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(body);
    } catch {
      // Fall through to JSON cloning below.
    }
  }

  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return body;
  }
}

function createRequestBodyCapturingFetch(onRequestBody: (body: unknown) => void): typeof fetch {
  return async (input, init) => {
    const body = parseFetchBody(init?.body);
    if (body !== undefined) {
      onRequestBody(cloneCapturedRequestBody(body));
    }

    const nativeFetch = globalThis.fetch as unknown as (input: unknown, init?: unknown) => Promise<Response>;
    return nativeFetch(input, init);
  };
}

function maybeCreateRequestBodyCapturingFetch(options: CreateChatV2ModelOptions): typeof fetch | undefined {
  return options.onRequestBody == null ? undefined : createRequestBodyCapturingFetch(options.onRequestBody);
}

export async function resolveChatV2ProviderConfig(
  provider: ChatV2Provider,
  modelId: string,
  context: ResolveChatV2ProviderConfigContext,
  options: CreateChatV2ModelOptions = {},
): Promise<ResolvedChatV2ProviderConfig> {
  const headers = cleanHeaders({
    ...context.settings.chatNodeHeaders,
    ...options.headers,
  });

  switch (provider) {
    case 'openai': {
      const configuredBaseURL = options.baseURL
        ? options.baseURL
        : openAIEndpointToBaseURL(context.settings.openAiEndpoint || DEFAULT_CHAT_ENDPOINT);

      if (context.getChatNodeEndpoint == null) {
        return {
          baseURL: configuredBaseURL,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        };
      }

      const resolved = await context.getChatNodeEndpoint(openAIBaseURLToEndpoint(configuredBaseURL), modelId);

      return {
        baseURL: openAIEndpointToBaseURL(resolved.endpoint),
        headers: cleanHeaders({
          ...headers,
          ...resolved.headers,
        }),
      };
    }

    case 'anthropic':
      return {
        baseURL: options.baseURL || context.getPluginConfig('anthropicApiEndpoint') || undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };

    case 'google':
      return {
        baseURL: options.baseURL || undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };

    case 'custom': {
      const configuredBaseURL = options.baseURL?.trim();

      if (!configuredBaseURL) {
        throw new Error('Provider base URL is required when provider is Custom provider.');
      }

      return {
        baseURL: openAICompatibleEndpointToBaseURL(configuredBaseURL),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    }
  }
}

export function createChatV2Model(
  provider: ChatV2Provider,
  modelId: string,
  context: Pick<InternalProcessContext, 'settings' | 'getPluginConfig'>,
  options: CreateChatV2ModelOptions = {},
): ChatV2Model {
  switch (provider) {
    case 'openai': {
      const providerInstance = createOpenAI({
        apiKey: options.apiKey || context.settings.openAiKey || undefined,
        organization: context.settings.openAiOrganization || undefined,
        baseURL: options.baseURL || undefined,
        headers: options.headers,
        fetch: maybeCreateRequestBodyCapturingFetch(options),
      });

      return providerInstance.responses(modelId);
    }

    case 'anthropic': {
      const providerInstance = createAnthropic({
        apiKey: options.apiKey || context.getPluginConfig('anthropicApiKey') || undefined,
        baseURL: options.baseURL || context.getPluginConfig('anthropicApiEndpoint') || undefined,
        headers: options.headers,
        fetch: maybeCreateRequestBodyCapturingFetch(options),
      });

      return providerInstance.messages(modelId);
    }

    case 'google': {
      const providerInstance = createGoogleGenerativeAI({
        apiKey: options.apiKey || context.getPluginConfig('googleApiKey') || undefined,
        baseURL: options.baseURL || undefined,
        headers: options.headers,
        fetch: maybeCreateRequestBodyCapturingFetch(options),
      });

      return providerInstance.chat(modelId);
    }

    case 'custom': {
      if (!options.baseURL) {
        throw new Error('Provider base URL is required when provider is Custom provider.');
      }

      const providerInstance = createOpenAICompatible({
        name: 'custom',
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        headers: options.headers,
        includeUsage: false,
        fetch: maybeCreateRequestBodyCapturingFetch(options),
      });
      const model = providerInstance.chatModel(modelId) as StructuredOutputCapableChatModel;
      // The installed OpenAI-compatible provider reads this from the model instance,
      // but its factory options do not forward the flag.
      model.supportsStructuredOutputs = true;

      return model;
    }
  }
}
