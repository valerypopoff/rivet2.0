import type { ChatV2CredentialReference, ChatV2CredentialResult } from './chatV2ProviderProfile.js';
import { createLLMChatV2NodeData, type LLMChatV2NodeData, type LLMChatV2ProfileData } from './llmChatV2NodeData.js';
import type { ChatV2Provider } from './chatV2Types.js';
import { parseCustomProviderApi } from './customProviderApi.js';
import {
  llmProfileBooleanDataKeys,
  llmProfileOptionalNumberDataKeys,
  llmProfileRequiredNumberDataKeys,
  llmProfileResolvedInputToggleDataKeys,
  llmProfileStringDataKeys,
} from './llmProfileFieldRegistry.js';
import { LLM_PROFILE_VALUE_VERSION, pickLLMChatV2ProfileData, type LLMProfileValue } from './llmProfileTypes.js';
import { createRivetLLMProfileHealthIdentity } from './llmProfileHealthStore.js';
import type { NodeId } from '../NodeBase.js';
import type { ProjectId } from '../Project.js';

export {
  applyLLMProfileToNodeData,
  createDefaultLLMProfileValue,
  createLLMProfileNodeData,
  LLM_PROFILE_VALUE_VERSION,
  pickLLMChatV2ProfileData,
  type LLMProfileValue,
} from './llmProfileTypes.js';

const credentialSources = new Set<ChatV2CredentialReference['source']>([
  'input',
  'settings',
  'plugin',
  'programmatic',
  'environment',
  'none',
]);
const profileProviders = new Set<ChatV2Provider>(['openai', 'anthropic', 'google', 'custom']);

export function normalizeLLMProfileValue(value: unknown): LLMProfileValue {
  if (!isRecord(value)) {
    throw new Error('LLM Profile input must contain an LLM profile value.');
  }

  if (value.version !== LLM_PROFILE_VALUE_VERSION) {
    throw new Error(`Unsupported LLM Profile version: ${String(value.version)}.`);
  }

  if (!isRecord(value.configuration)) {
    throw new Error('LLM Profile configuration is missing.');
  }

  const defaults = createLLMChatV2NodeData();
  const provider = normalizeProvider(value.configuration.provider ?? defaults.provider);
  const model = value.configuration.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('LLM Profile model must be a non-empty string.');
  }

  const credential = normalizeCredential(value.credential);
  const configuration = normalizeConfiguration({
    ...defaults,
    ...value.configuration,
    provider,
    model: model.trim(),
  } as LLMChatV2NodeData);

  const sourceIdentity = normalizeSourceIdentity(value.healthIdentity);
  return {
    version: LLM_PROFILE_VALUE_VERSION,
    configuration,
    credential,
    healthIdentity: createRivetLLMProfileHealthIdentity({
      configuration,
      credential,
      ...sourceIdentity,
    }),
  };
}

/**
 * Normalizes the single LLM Profile or ordered fallback chain accepted by
 * LLM Chat's From profile input. We validate every member here rather than
 * trusting a same-type `llm-config[]` wrapper: arrays can otherwise carry
 * malformed values without re-entering scalar coercion.
 */
export function normalizeLLMProfileChainInput(value: unknown): LLMProfileValue[] {
  const rawProfiles = Array.isArray(value) ? value : [value];

  if (rawProfiles.length === 0) {
    throw new Error('LLM Profiles input must contain at least one LLM Profile.');
  }

  return rawProfiles.map((profile, index) => {
    try {
      return normalizeLLMProfileValue(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`LLM Profiles input item ${index} is invalid: ${message}`);
    }
  });
}

/**
 * Programmatic or serialized llm-config values may originate outside the
 * currently executing project. Always bind health to that project before
 * shared storage is consulted so copied values cannot share a circuit across
 * projects. Preserve an originating profile-node identity when one exists;
 * otherwise the consuming Chat node owns the identity.
 */
export function scopeLLMProfileHealthIdentity(
  profile: LLMProfileValue,
  fallback: {
    projectId: ProjectId;
    profileNodeId: NodeId;
    chatNodeHeaders?: Record<string, string> | undefined;
  },
): LLMProfileValue {
  const profileNodeId = profile.healthIdentity?.profileNodeId ?? fallback.profileNodeId;
  const healthIdentity = createRivetLLMProfileHealthIdentity({
    configuration: profile.configuration,
    credential: profile.credential,
    chatNodeHeaders: fallback.chatNodeHeaders,
    projectId: fallback.projectId,
    profileNodeId,
  });

  if (profile.healthIdentity?.key === healthIdentity.key) {
    return profile;
  }

  return {
    ...profile,
    healthIdentity,
  };
}

function normalizeConfiguration(data: LLMChatV2NodeData): LLMChatV2ProfileData {
  for (const field of llmProfileStringDataKeys) {
    if (typeof data[field] !== 'string') {
      throw new Error(`LLM Profile ${field} must be a string.`);
    }
  }
  for (const field of llmProfileBooleanDataKeys) {
    if (typeof data[field] !== 'boolean') {
      throw new Error(`LLM Profile ${field} must be a boolean.`);
    }
  }
  for (const field of llmProfileRequiredNumberDataKeys) {
    if (typeof data[field] !== 'number' || !Number.isFinite(data[field])) {
      throw new Error(`LLM Profile ${field} must be a finite number.`);
    }
  }
  for (const field of llmProfileOptionalNumberDataKeys) {
    const fieldValue = data[field];
    if (fieldValue != null && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) {
      throw new Error(`LLM Profile ${field} must be a finite number when provided.`);
    }
  }

  if (!Array.isArray(data.stopSequences) || data.stopSequences.some((sequence) => typeof sequence !== 'string')) {
    throw new Error('LLM Profile stopSequences must be an array of strings.');
  }
  if (
    !Array.isArray(data.headers) ||
    data.headers.some(
      (header) => !isRecord(header) || typeof header.key !== 'string' || typeof header.value !== 'string',
    )
  ) {
    throw new Error('LLM Profile headers must contain string key/value pairs.');
  }
  if (data.apiKeySource !== 'environment' && data.apiKeySource !== 'input') {
    throw new Error(`Unsupported LLM Profile API key source: ${String(data.apiKeySource)}.`);
  }
  assertEnumValue(data.openAIWebSearchContextSize, ['low', 'medium', 'high'], 'OpenAI web search context');
  const customProviderApi = parseCustomProviderApi(data.customProviderApi);
  assertEnumValue(data.anthropicThinkingMode, ['', 'adaptive', 'enabled', 'disabled'], 'Anthropic thinking mode');
  assertEnumValue(data.anthropicEffort, ['', 'low', 'medium', 'high', 'max'], 'Anthropic effort');
  assertEnumValue(data.anthropicCacheControlTtl, ['', '5m', '1h'], 'Anthropic cache TTL');
  assertEnumValue(data.googleThinkingLevel, ['', 'minimal', 'low', 'medium', 'high'], 'Google thinking level');

  const resolvedData = {
    ...data,
    customProviderApi,
    model: data.model.trim(),
    customProviderBaseURL: data.customProviderBaseURL.trim(),
    customProviderApiKeyProgrammaticName: data.customProviderApiKeyProgrammaticName?.trim(),
    customProviderApiKeyEnvVarName: data.customProviderApiKeyEnvVarName?.trim(),
    stopSequences: [...data.stopSequences],
    headers: data.headers.map(({ key, value }) => ({ key, value })),
  };

  // A profile is a resolved configuration value. LLM Chat intentionally does not
  // expose the profile-owned inputs, so accepting a dynamic flag here would let
  // stale hidden connections influence a supposedly self-contained profile.
  for (const field of llmProfileResolvedInputToggleDataKeys) {
    (resolvedData as Record<string, unknown>)[field] = false;
  }

  return pickLLMChatV2ProfileData(resolvedData);
}

function assertEnumValue(value: unknown, allowed: readonly string[], label: string): asserts value is string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Unsupported LLM Profile ${label}: ${String(value)}.`);
  }
}

function normalizeProvider(value: unknown): ChatV2Provider {
  if (typeof value !== 'string' || !profileProviders.has(value as ChatV2Provider)) {
    throw new Error(`Unsupported LLM Profile provider: ${String(value)}.`);
  }

  return value as ChatV2Provider;
}

function normalizeCredential(value: unknown): ChatV2CredentialResult {
  if (
    !isRecord(value) ||
    !isRecord(value.reference) ||
    typeof value.reference.source !== 'string' ||
    !credentialSources.has(value.reference.source as ChatV2CredentialReference['source'])
  ) {
    throw new Error('LLM Profile credential metadata is invalid.');
  }

  const credentialValue = value.value;
  if (credentialValue != null && typeof credentialValue !== 'string') {
    throw new Error('LLM Profile API key must be a string when provided.');
  }

  const name = value.reference.name;
  if (name != null && typeof name !== 'string') {
    throw new Error('LLM Profile credential name must be a string when provided.');
  }

  return {
    ...(credentialValue == null ? {} : { value: credentialValue }),
    reference: {
      source: value.reference.source as ChatV2CredentialReference['source'],
      ...(name == null ? {} : { name }),
    },
  };
}

function normalizeSourceIdentity(value: unknown): { projectId?: ProjectId; profileNodeId?: NodeId } {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId as ProjectId } : {}),
    ...(typeof value.profileNodeId === 'string' ? { profileNodeId: value.profileNodeId as NodeId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}
