import type { Settings } from '../model/Settings.js';
import type { KnowledgeStoreConnectionDefinition } from '../model/Project.js';
import type { KnowledgeMetadata } from './KnowledgeStore.js';
import type {
  KnowledgeStoreProviderConfigField,
  KnowledgeStoreProviderCredentialField,
  KnowledgeStoreProviderDefinition,
} from './KnowledgeStoreProvider.js';

export type KnowledgeStoreProviderFieldIssueCode =
  | 'required'
  | 'expected-boolean'
  | 'expected-finite-number'
  | 'expected-string'
  | 'unsupported-select-value';

export type KnowledgeStoreProviderFieldIssue = Readonly<{
  code: KnowledgeStoreProviderFieldIssueCode;
  fieldKey: string;
  fieldLabel: string;
}>;

export type KnowledgeStoreFieldNormalizationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issue: KnowledgeStoreProviderFieldIssue }>;

export type KnowledgeStoreNormalizedProviderFieldValue =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: string | number | boolean }>;

type ProviderConnectionPolicy = Pick<KnowledgeStoreProviderDefinition, 'id' | 'pluginId' | 'connectionConfigSpec'>;

type ProviderCredentialPolicy = Pick<KnowledgeStoreProviderDefinition, 'id' | 'credentialConfigSpec'>;

export type KnowledgeStoreProviderFieldNormalizationMode =
  | 'connection-draft'
  | 'connection-runtime'
  | 'credential-draft'
  | 'credential-runtime';

export function createKnowledgeStoreFieldDraftDefaults(
  fields: ReadonlyArray<KnowledgeStoreProviderConfigField>,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => [field.key, field.default ?? (field.type === 'boolean' ? false : '')]),
  );
}

/** Normalizes one declared provider field at an explicit editor or runtime boundary. */
export function normalizeKnowledgeStoreProviderFieldValue(
  field: KnowledgeStoreProviderConfigField,
  value: unknown,
  mode: KnowledgeStoreProviderFieldNormalizationMode,
): KnowledgeStoreFieldNormalizationResult<KnowledgeStoreNormalizedProviderFieldValue> {
  if (mode === 'credential-draft') {
    if (typeof value !== 'string') return fieldIssue(field, 'expected-string');
    if (field.required && !value.trim()) return fieldIssue(field, 'required');
    return value === '' ? { ok: true, value: { present: false } } : { ok: true, value: { present: true, value } };
  }

  if (mode === 'credential-runtime') {
    if (value === undefined || value === '') {
      return field.required ? fieldIssue(field, 'required') : { ok: true, value: { present: false } };
    }
    if (typeof value !== 'string') return fieldIssue(field, 'expected-string');
    if (field.required && !value.trim()) return fieldIssue(field, 'required');
    return { ok: true, value: { present: true, value } };
  }

  if (mode !== 'connection-draft' && mode !== 'connection-runtime') {
    throw new Error('Unsupported Knowledge Store field normalization mode.');
  }

  const missingRequired =
    mode === 'connection-draft'
      ? field.required && (value == null || String(value).trim() === '')
      : field.required && (value == null || (typeof value === 'string' && !value.trim()));
  if (missingRequired) return fieldIssue(field, 'required');

  if (value === undefined || value === '') {
    return { ok: true, value: { present: false } };
  }

  if (field.type === 'boolean') {
    return typeof value === 'boolean'
      ? { ok: true, value: { present: true, value } }
      : fieldIssue(field, 'expected-boolean');
  }

  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? { ok: true, value: { present: true, value } }
      : fieldIssue(field, 'expected-finite-number');
  }

  if (typeof value !== 'string') {
    return fieldIssue(field, 'expected-string');
  }

  if (field.type === 'select' && !(field.options ?? []).some((option) => option.value === value)) {
    return fieldIssue(field, 'unsupported-select-value');
  }

  return { ok: true, value: { present: true, value } };
}

export function isKnowledgeStoreProviderFieldDefaultValid(
  field: KnowledgeStoreProviderConfigField,
  value: unknown,
): boolean {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return field.type !== 'select' || (field.options ?? []).some((option) => option.value === value);
}

export function normalizeKnowledgeStoreConnectionDraftConfig(
  fields: ReadonlyArray<KnowledgeStoreProviderConfigField>,
  values: Readonly<Record<string, unknown>>,
): KnowledgeStoreFieldNormalizationResult<KnowledgeMetadata> {
  return normalizeDeclaredFields(fields, values, 'connection-draft');
}

export function normalizeKnowledgeStoreCredentialFields(
  fields: ReadonlyArray<KnowledgeStoreProviderCredentialField>,
  values: Readonly<Record<string, unknown>>,
): KnowledgeStoreFieldNormalizationResult<Record<string, string>> {
  const result = normalizeDeclaredFields(fields, values, 'credential-draft');
  if (!result.ok) return result;
  return { ok: true, value: result.value as Record<string, string> };
}

export function normalizeKnowledgeStoreConnectionDefinition(
  connectionId: string,
  definition: KnowledgeStoreConnectionDefinition,
  provider: ProviderConnectionPolicy,
): KnowledgeStoreConnectionDefinition {
  const displayName = typeof definition.displayName === 'string' ? definition.displayName.trim() : '';
  if (!displayName) throw new Error(`Knowledge store connection "${connectionId}" has no display name.`);
  if (definition.provider !== provider.id) {
    throw new Error(`Knowledge store connection "${displayName}" names the wrong provider.`);
  }
  if (!isPlainRecord(definition.config)) {
    throw new Error(`Knowledge store connection "${displayName}" has invalid provider configuration.`);
  }

  const fieldsByKey = new Set(provider.connectionConfigSpec.map((field) => field.key));
  for (const key of Object.keys(definition.config)) {
    if (!fieldsByKey.has(key)) {
      throw new Error(`Knowledge store connection "${displayName}" contains unknown configuration field "${key}".`);
    }
  }

  const normalizedConfig = normalizeDeclaredFields(
    provider.connectionConfigSpec,
    definition.config,
    'connection-runtime',
  );
  if (!normalizedConfig.ok) {
    throw new Error(formatRuntimeConnectionFieldIssue(displayName, normalizedConfig.issue));
  }

  const pluginId = typeof definition.pluginId === 'string' ? definition.pluginId.trim() : '';
  if (definition.pluginId != null && (!pluginId || pluginId !== definition.pluginId)) {
    throw new Error(`Knowledge store connection "${displayName}" has an invalid owning plugin ID.`);
  }
  const providerPluginId = provider.pluginId ?? provider.id;
  if (pluginId && pluginId !== providerPluginId) {
    throw new Error(`Knowledge store connection "${displayName}" names the wrong owning plugin.`);
  }

  return {
    displayName,
    provider: provider.id,
    pluginId: providerPluginId,
    config: normalizedConfig.value,
  };
}

export function readKnowledgeStoreConnectionCredentials(
  settings: Settings,
  provider: ProviderCredentialPolicy,
  connectionId: string,
): KnowledgeStoreFieldNormalizationResult<Record<string, string>> {
  const result = normalizeDeclaredFields(
    provider.credentialConfigSpec ?? [],
    readCredentialValues(settings, provider.id, connectionId),
    'credential-runtime',
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value as Record<string, string> };
}

export function readKnowledgeStoreConnectionCredentialsDraft(
  settings: Settings,
  provider: ProviderCredentialPolicy,
  connectionId: string,
): Record<string, string> {
  const storedValues = readCredentialValues(settings, provider.id, connectionId);
  const entries: Array<[string, string]> = [];
  for (const field of provider.credentialConfigSpec ?? []) {
    const value = readOwnProperty(storedValues, field.key);
    if (typeof value === 'string') entries.push([field.key, value]);
  }
  return Object.fromEntries(entries);
}

export function writeKnowledgeStoreConnectionCredentials(
  settings: Settings,
  providerId: string,
  connectionId: string,
  credentials: Readonly<Record<string, string>>,
): Settings {
  const pluginSettings = isPlainRecord(settings.pluginSettings) ? settings.pluginSettings : {};
  const providerSettings = readOwnRecord(pluginSettings, providerId) ?? {};
  const existingSets = readOwnRecord(providerSettings, 'knowledgeStoreCredentials') ?? {};
  const nextSets =
    Object.keys(credentials).length > 0
      ? { ...existingSets, [connectionId]: { ...credentials } }
      : omitOwnProperty(existingSets, connectionId);

  return {
    ...settings,
    pluginSettings: {
      ...pluginSettings,
      [providerId]: {
        ...providerSettings,
        knowledgeStoreCredentials: nextSets,
      },
    },
  };
}

export function removeKnowledgeStoreConnectionCredentials(
  settings: Settings,
  providerId: string,
  connectionId: string,
): Settings {
  const pluginSettings = isPlainRecord(settings.pluginSettings) ? settings.pluginSettings : undefined;
  const providerSettings = readOwnRecord(pluginSettings, providerId);
  if (!providerSettings) return settings;
  const credentialSets = readOwnRecord(providerSettings, 'knowledgeStoreCredentials');
  if (!credentialSets) return settings;
  return {
    ...settings,
    pluginSettings: {
      ...pluginSettings,
      [providerId]: {
        ...providerSettings,
        knowledgeStoreCredentials: omitOwnProperty(credentialSets, connectionId),
      },
    },
  };
}

function normalizeDeclaredFields(
  fields: ReadonlyArray<KnowledgeStoreProviderConfigField>,
  values: Readonly<Record<string, unknown>>,
  mode: KnowledgeStoreProviderFieldNormalizationMode,
): KnowledgeStoreFieldNormalizationResult<Record<string, string | number | boolean>> {
  const entries: Array<[string, string | number | boolean]> = [];
  for (const field of fields) {
    const value = getDeclaredFieldValue(field, values, mode);
    const normalized = normalizeKnowledgeStoreProviderFieldValue(field, value, mode);
    if (!normalized.ok) return normalized;
    if (normalized.value.present) entries.push([field.key, normalized.value.value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

function getDeclaredFieldValue(
  field: KnowledgeStoreProviderConfigField,
  values: Readonly<Record<string, unknown>>,
  mode: KnowledgeStoreProviderFieldNormalizationMode,
): unknown {
  if (hasOwnProperty(values, field.key)) return values[field.key];
  if (mode === 'credential-draft') return typeof field.default === 'string' ? field.default : '';
  return field.default;
}

function readCredentialValues(settings: Settings, providerId: string, connectionId: string): Record<string, unknown> {
  const providerSettings = readOwnRecord(settings.pluginSettings, providerId);
  const credentialSets = readOwnRecord(providerSettings, 'knowledgeStoreCredentials');
  const storedCredentials = readOwnRecord(credentialSets, connectionId);
  return storedCredentials ? { ...storedCredentials } : {};
}

function formatRuntimeConnectionFieldIssue(displayName: string, issue: KnowledgeStoreProviderFieldIssue): string {
  return issue.code === 'required'
    ? `Knowledge store connection "${displayName}" requires ${issue.fieldLabel}.`
    : `Knowledge store connection "${displayName}" has an invalid value for ${issue.fieldLabel}.`;
}

function fieldIssue(
  field: KnowledgeStoreProviderConfigField,
  code: KnowledgeStoreProviderFieldIssueCode,
): KnowledgeStoreFieldNormalizationResult<never> {
  return {
    ok: false,
    issue: {
      code,
      fieldKey: field.key,
      fieldLabel: field.label,
    },
  };
}

function readOwnProperty(value: unknown, key: string): unknown {
  return hasOwnProperty(value, key) ? value[key] : undefined;
}

function readOwnRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const property = readOwnProperty(value, key);
  return isPlainRecord(property) ? property : undefined;
}

function hasOwnProperty(value: unknown, key: string): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function omitOwnProperty(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
