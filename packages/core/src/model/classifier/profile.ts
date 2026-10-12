import CryptoJS from 'crypto-js';
import stableStringify from 'safe-stable-stringify';
import type { NodeId } from '../NodeBase.js';
import type { ProjectId } from '../Project.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { Inputs } from '../GraphProcessor.js';
import { classifierInputDataValue, snapshotClassifierJson } from './json.js';
import { ClassifierValueBudget, type ClassifierPreparationCheck } from './limits.js';
import { getClassifierProvider } from './providers.js';
import {
  ClassifierCredentialMissingError,
  resolveClassifierApiKey,
  type ClassifierApiKeySource,
  type ClassifierCredentialNames,
} from './credentials.js';
import type {
  RivetLLMProfileCircuitBreakerPolicy,
  RivetLLMProfileHealthIdentity,
} from '../chat-v2/llmProfileHealthStore.js';

export type ClassifierProfileConfiguration = {
  provider?: string;
  model?: string;
  useModelInput?: boolean;
  apiKeySource?: ClassifierApiKeySource;
  apiKeyNamesByProvider?: Record<string, ClassifierCredentialNames | undefined>;
  apiKeyNames?: ClassifierCredentialNames;
  responseTimeoutMs?: number;
  enableCircuitBreaker?: boolean;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerFailureWindowMs?: number;
  circuitBreakerOpenDurationMs?: number;
};

/** Resolved, sensitive runtime value, never a persisted API key in node settings. */
export type ClassifierProfileValue = {
  version: 1;
  configuration: ClassifierProfileConfiguration & { provider: string; model: string };
  credential: { value?: string };
  profileName?: string;
  sourceNodeId?: NodeId;
};

export const DEFAULT_CLASSIFIER_PROFILE_RESPONSE_TIMEOUT_MS = 500;
export const DEFAULT_CLASSIFIER_PROFILE_FAILURE_THRESHOLD = 3;
export const DEFAULT_CLASSIFIER_PROFILE_FAILURE_WINDOW_MS = 300_000;
export const DEFAULT_CLASSIFIER_PROFILE_OPEN_DURATION_MS = 300_000;

export const classifierProfileInputIds = ['model', 'apiKey'] as const;
export const classifierProfileDataKeys = [
  'provider',
  'model',
  'useModelInput',
  'apiKeySource',
  'apiKeyNamesByProvider',
  'apiKeyNames',
  'responseTimeoutMs',
  'enableCircuitBreaker',
  'circuitBreakerFailureThreshold',
  'circuitBreakerFailureWindowMs',
  'circuitBreakerOpenDurationMs',
] as const;

export function pickClassifierProfileData(data: ClassifierProfileConfiguration): ClassifierProfileConfiguration {
  return Object.fromEntries(
    classifierProfileDataKeys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
  );
}

function positive(value: number | undefined, fallback: number, label: string, maximum = 600_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error(`Classifier Profile ${label} must be an integer between 1 and ${maximum}.`);
  return result;
}

export function classifierProfileResponseTimeout(configuration: ClassifierProfileConfiguration): number {
  return positive(configuration.responseTimeoutMs, DEFAULT_CLASSIFIER_PROFILE_RESPONSE_TIMEOUT_MS, 'response timeout');
}

export function classifierProfileHealthPolicy(
  configuration: ClassifierProfileConfiguration,
): RivetLLMProfileCircuitBreakerPolicy | undefined {
  if (configuration.enableCircuitBreaker !== true) return undefined;
  return {
    failureThreshold: positive(
      configuration.circuitBreakerFailureThreshold,
      DEFAULT_CLASSIFIER_PROFILE_FAILURE_THRESHOLD,
      'failure threshold',
      1000,
    ),
    failureWindowMs: positive(
      configuration.circuitBreakerFailureWindowMs,
      DEFAULT_CLASSIFIER_PROFILE_FAILURE_WINDOW_MS,
      'failure window',
      86_400_000,
    ),
    openDurationMs: positive(
      configuration.circuitBreakerOpenDurationMs,
      DEFAULT_CLASSIFIER_PROFILE_OPEN_DURATION_MS,
      'suspension duration',
      86_400_000,
    ),
    halfOpenLeaseMs: classifierProfileResponseTimeout(configuration) + 5000,
  };
}

export function normalizeClassifierProfileValue(value: unknown): ClassifierProfileValue {
  return normalizeDetachedProfile(
    snapshotClassifierJson(value, 'Classifier Profile', new ClassifierValueBudget(), true),
  );
}

function normalizeDetachedProfile(value: unknown): ClassifierProfileValue {
  const profile = value as ClassifierProfileValue;
  if (
    !profile ||
    profile.version !== 1 ||
    !profile.configuration ||
    typeof profile.configuration !== 'object' ||
    Array.isArray(profile.configuration) ||
    !profile.credential ||
    typeof profile.credential !== 'object' ||
    Array.isArray(profile.credential)
  )
    throw new Error('Classifier Profiles input requires a version 1 Classifier Profile.');
  const { configuration, credential } = profile;
  if (
    typeof configuration.provider !== 'string' ||
    typeof configuration.model !== 'string' ||
    !configuration.model.trim()
  )
    throw new Error('Classifier Profile requires a provider and a nonblank model.');
  getClassifierProvider(configuration.provider);
  if (credential.value !== undefined && (typeof credential.value !== 'string' || /[\r\n]/.test(credential.value)))
    throw new Error('Classifier Profile credential must be a string without line breaks.');
  if (profile.profileName !== undefined && typeof profile.profileName !== 'string')
    throw new Error('Invalid Classifier Profile name.');
  if (profile.sourceNodeId !== undefined && (typeof profile.sourceNodeId !== 'string' || !profile.sourceNodeId.trim()))
    throw new Error('Invalid Classifier Profile source node.');
  if (configuration.enableCircuitBreaker !== undefined && typeof configuration.enableCircuitBreaker !== 'boolean')
    throw new Error('Classifier Profile automatic suspension must be a boolean.');
  if (
    configuration.apiKeySource !== undefined &&
    !['configured', 'classifier-settings', 'input'].includes(configuration.apiKeySource)
  )
    throw new Error('Unknown classifier API key source.');
  classifierProfileResponseTimeout(configuration);
  classifierProfileHealthPolicy(configuration);
  return {
    version: 1,
    sourceNodeId: profile.sourceNodeId,
    profileName: profile.profileName?.trim() || undefined,
    credential: credential.value === undefined ? {} : { value: credential.value.trim() },
    configuration: {
      ...pickClassifierProfileData(configuration),
      provider: configuration.provider,
      model: configuration.model.trim(),
      useModelInput: false,
    },
  };
}

export function normalizeClassifierProfiles(
  value: unknown,
  check?: ClassifierPreparationCheck,
): ClassifierProfileValue[] {
  if (Array.isArray(value) && (value.length === 0 || value.length > 128))
    throw new Error('Classifier Profiles requires between 1 and 128 profiles.');
  // One deadline-aware traversal bounds, validates and detaches the whole
  // chain. Do not rescan each candidate with a fresh resource budget.
  const detached = snapshotClassifierJson(value, 'Classifier Profiles', new ClassifierValueBudget(check), true);
  return (Array.isArray(detached) ? detached : [detached]).map(normalizeDetachedProfile);
}

export function resolveClassifierProfile(
  data: ClassifierProfileConfiguration,
  inputs: Inputs,
  context: InternalProcessContext,
): ClassifierProfileValue {
  const provider = getClassifierProvider(data.provider);
  const model = data.useModelInput
    ? classifierInputDataValue(inputs, 'model')?.value
    : data.model?.trim() || provider.defaultModel;
  if (typeof model !== 'string' || !model.trim()) throw new Error('Classifier Profile model is required.');
  let value: string | undefined;
  // Missing credentials are a candidate failure, not an upstream graph failure.
  // Invalid credential-name configuration still fails while authoring the profile.
  try {
    value = resolveClassifierApiKey({
      apiKeyNames: data.apiKeyNamesByProvider?.[provider.id] ?? data.apiKeyNames,
      apiKeySource: data.apiKeySource,
      context,
      defaults: provider.credentialNames,
      inputs,
      providerId: provider.id,
    });
  } catch (error) {
    if (!(error instanceof ClassifierCredentialMissingError)) throw error;
  }
  return normalizeClassifierProfileValue({
    version: 1,
    configuration: { ...pickClassifierProfileData(data), provider: provider.id, model, useModelInput: false },
    credential: value === undefined ? {} : { value },
    profileName: context.node.title,
    sourceNodeId: context.node.id,
  });
}

export function classifierProfileHealthIdentity(
  profile: ClassifierProfileValue,
  projectId: ProjectId,
  fallbackNodeId: NodeId,
): RivetLLMProfileHealthIdentity {
  const hash = (value: unknown) => `sha256:${CryptoJS.SHA256(stableStringify(value) ?? '').toString(CryptoJS.enc.Hex)}`;
  const configurationFingerprint = hash({
    provider: profile.configuration.provider,
    model: profile.configuration.model,
    credential: profile.credential,
  });
  const profileNodeId = profile.sourceNodeId ?? fallbackNodeId;
  return {
    key: `classifier-profile:${hash({ projectId, profileNodeId, configurationFingerprint })}`,
    family: 'classifier',
    projectId,
    profileNodeId,
    profileName: profile.profileName,
    provider: profile.configuration.provider,
    model: profile.configuration.model,
    configurationFingerprint,
  };
}
