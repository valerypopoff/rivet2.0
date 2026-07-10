import stableStringify from 'safe-stable-stringify';
import type { Outputs } from '../GraphProcessor.js';
import type { ResolvedChatV2ProviderConfig } from './providerOptions.js';
import type { ChatV2Provider, ChatV2ProviderOptions, ChatV2ToolChoice } from './chatV2Types.js';
import type { LLMChatV2EditorCacheKeyParts, LLMChatV2NodeData } from './llmChatV2NodeData.js';

export function buildLLMChatV2EditorCacheKey(parts: LLMChatV2EditorCacheKeyParts): string {
  return stableStringify(parts) ?? '';
}

function cloneEditorCacheValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  const existing = seen.get(value);
  if (existing != null) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    clone.push(...value.map((item) => cloneEditorCacheValue(item, seen)));
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);

  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneEditorCacheValue(item, seen);
  }

  return clone as T;
}

export function cloneLLMChatV2EditorCacheOutputs(outputs: Outputs): Outputs {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(outputs) as Outputs;
    } catch {
      // Fall through to the small object/array clone for values structuredClone cannot copy.
    }
  }

  return cloneEditorCacheValue(outputs);
}

function fingerprintSecret(secret: string | undefined): string | undefined {
  if (!secret) {
    return undefined;
  }

  let hash = 2166136261;

  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `${secret.length}:${(hash >>> 0).toString(36)}`;
}

function fingerprintProviderConfigForCache(config: ResolvedChatV2ProviderConfig): ResolvedChatV2ProviderConfig {
  if (config.headers == null) {
    return config;
  }

  return {
    ...config,
    headers: Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [key, fingerprintSecret(value) ?? '']),
    ),
  };
}

function fingerprintNodeDataForCache(data: LLMChatV2NodeData): LLMChatV2NodeData {
  const isCustomProvider = data.provider === 'custom';

  return {
    ...data,
    baseURL: '',
    useBaseURLInput: false,
    customProviderBaseURL: isCustomProvider ? data.customProviderBaseURL : '',
    useCustomProviderBaseURLInput: isCustomProvider ? data.useCustomProviderBaseURLInput : false,
    extraProviderOptions: data.useExtraProviderOptionsInput ? '' : fingerprintSecret(data.extraProviderOptions) ?? '',
    headers: (data.headers ?? []).map(({ key, value }) => ({
      key,
      value: fingerprintSecret(value) ?? '',
    })),
  };
}

function fingerprintProviderOptionsForCache(providerOptions: ChatV2ProviderOptions | undefined): string | undefined {
  if (providerOptions == null) {
    return undefined;
  }

  return fingerprintSecret(stableStringify(providerOptions) ?? '');
}

export function resolveLLMChatV2EditorCache(params: {
  apiKey: string | undefined;
  data: LLMChatV2NodeData;
  editorCache: Map<string, unknown> | undefined;
  functions: unknown;
  generationParameters: unknown;
  modelId: string;
  nodeId: LLMChatV2EditorCacheKeyParts['nodeId'];
  prompt: unknown;
  provider: ChatV2Provider;
  providerConfig: ResolvedChatV2ProviderConfig;
  providerOptions: ChatV2ProviderOptions | undefined;
  responseFormatParameters: unknown;
  systemPrompt: unknown;
  toolChoice: ChatV2ToolChoice | undefined;
}): { cacheKey: string | undefined; cachedOutputs: Outputs | undefined } {
  const { editorCache } = params;

  if (editorCache == null) {
    return { cacheKey: undefined, cachedOutputs: undefined };
  }

  const cacheKey = buildLLMChatV2EditorCacheKey({
    nodeId: params.nodeId,
    nodeData: fingerprintNodeDataForCache(params.data),
    provider: params.provider,
    modelId: params.modelId,
    providerConfig: fingerprintProviderConfigForCache(params.providerConfig),
    apiKeyFingerprint: fingerprintSecret(params.apiKey),
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
    functions: params.functions,
    generationParameters: params.generationParameters,
    responseFormatParameters: params.responseFormatParameters,
    providerOptions: fingerprintProviderOptionsForCache(params.providerOptions),
    toolChoice: params.toolChoice,
  });

  return {
    cacheKey,
    cachedOutputs: editorCache.has(cacheKey)
      ? cloneLLMChatV2EditorCacheOutputs(editorCache.get(cacheKey) as Outputs)
      : undefined,
  };
}
