import type { InternalProcessContext } from '../model/ProcessContext.js';
import type { KnowledgeStoreConnectionId, RivetKnowledgeStore, RivetKnowledgeStoreRegistry } from './KnowledgeStore.js';
import type { KnowledgeStoreConnectionDefinition } from '../model/Project.js';
import type { Settings } from '../model/Settings.js';
import { isReservedKnowledgeObjectKey, normalizeKnowledgeConnectionId } from './KnowledgeStoreValidation.js';

export type KnowledgeStoreProviderConfigField = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
};

export type KnowledgeStoreProviderDefinition = {
  id: string;
  displayName: string;
  /** Rivet plugin that owns this provider. Defaults to the provider ID. */
  pluginId?: string;
  connectionConfigSpec: KnowledgeStoreProviderConfigField[];
  credentialConfigSpec?: Array<KnowledgeStoreProviderConfigField & { type: 'string' | 'secret' }>;
  supportedExecutors: Array<'browser' | 'nodejs'>;
  createStore(
    connectionId: KnowledgeStoreConnectionId,
    definition: KnowledgeStoreConnectionDefinition,
    context: KnowledgeStoreProviderContext,
  ): RivetKnowledgeStore | Promise<RivetKnowledgeStore>;
  testConnection?(
    definition: KnowledgeStoreConnectionDefinition,
    credentials: Record<string, string>,
    signal: AbortSignal,
    context: KnowledgeStoreProviderTestContext,
  ): void | Promise<void>;
};

type KnowledgeStoreResolutionContext = Pick<InternalProcessContext, 'executor' | 'project' | 'settings'>;
export type KnowledgeStoreProviderContext = KnowledgeStoreResolutionContext & {
  /** Validated local credentials declared by this provider for this connection. */
  credentials: Readonly<Record<string, string>>;
};
export type KnowledgeStoreProviderTestContext = { settings: Settings };

const providers = new Map<string, KnowledgeStoreProviderDefinition>();

export function registerKnowledgeStoreProvider(provider: KnowledgeStoreProviderDefinition): void {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Knowledge store provider definition must be an object.');
  }
  if (typeof provider.id !== 'string' || !provider.id.trim() || provider.id !== provider.id.trim())
    throw new Error('Knowledge store provider IDs cannot be empty or padded.');
  if (isReservedKnowledgeObjectKey(provider.id)) {
    throw new Error(`Knowledge store provider ID "${provider.id}" is reserved.`);
  }
  if (typeof provider.displayName !== 'string' || !provider.displayName.trim()) {
    throw new Error(`Knowledge store provider "${provider.id}" must have a display name.`);
  }
  if (
    provider.pluginId != null &&
    (typeof provider.pluginId !== 'string' ||
      !provider.pluginId.trim() ||
      provider.pluginId !== provider.pluginId.trim())
  ) {
    throw new Error(`Knowledge store provider "${provider.id}" has an invalid owning plugin ID.`);
  }
  if (provider.pluginId != null && isReservedKnowledgeObjectKey(provider.pluginId)) {
    throw new Error(`Knowledge store provider "${provider.id}" has a reserved owning plugin ID.`);
  }
  if (!Array.isArray(provider.connectionConfigSpec)) {
    throw new Error(`Knowledge store provider "${provider.id}" must declare connection fields as an array.`);
  }
  if (provider.credentialConfigSpec != null && !Array.isArray(provider.credentialConfigSpec)) {
    throw new Error(`Knowledge store provider "${provider.id}" must declare credential fields as an array.`);
  }
  if (!Array.isArray(provider.supportedExecutors) || provider.supportedExecutors.length === 0)
    throw new Error(`Knowledge store provider "${provider.id}" must support an executor.`);
  if (
    provider.supportedExecutors.some((executor) => executor !== 'browser' && executor !== 'nodejs') ||
    new Set(provider.supportedExecutors).size !== provider.supportedExecutors.length
  ) {
    throw new Error(`Knowledge store provider "${provider.id}" declares invalid or duplicate executors.`);
  }
  if (typeof provider.createStore !== 'function') {
    throw new Error(`Knowledge store provider "${provider.id}" must provide a store factory.`);
  }
  if (provider.testConnection != null && typeof provider.testConnection !== 'function') {
    throw new Error(`Knowledge store provider "${provider.id}" has an invalid connection test.`);
  }
  validateProviderFields(provider.id, provider.connectionConfigSpec, 'connection');
  validateProviderFields(provider.id, provider.credentialConfigSpec ?? [], 'credential');
  providers.set(provider.id, snapshotProviderDefinition(provider));
}

export function getKnowledgeStoreProvider(providerId: string): KnowledgeStoreProviderDefinition | undefined {
  return providers.get(providerId);
}

export function getKnowledgeStoreProviders(): KnowledgeStoreProviderDefinition[] {
  return [...providers.values()];
}

export class KnowledgeStoreController {
  readonly #hostStores: RivetKnowledgeStoreRegistry;
  readonly #resolvedStores = new WeakMap<object, Map<string, Promise<RivetKnowledgeStore>>>();

  constructor(hostStores: RivetKnowledgeStoreRegistry | undefined) {
    this.#hostStores = hostStores ?? {};
  }

  async resolve(
    connectionId: KnowledgeStoreConnectionId,
    context: KnowledgeStoreResolutionContext,
  ): Promise<RivetKnowledgeStore> {
    const normalizedId = normalizeKnowledgeConnectionId(connectionId);

    if (Object.prototype.hasOwnProperty.call(this.#hostStores, normalizedId)) {
      const hostStore = this.#hostStores[normalizedId];
      if (!hostStore) throw new Error(`Host knowledge store "${normalizedId}" is invalid.`);
      return validateResolvedStore(hostStore, normalizedId, context.executor);
    }

    const definitions = context.project.metadata.knowledgeStores;
    const definition =
      definitions && Object.prototype.hasOwnProperty.call(definitions, normalizedId)
        ? definitions[normalizedId]
        : undefined;
    if (!definition) {
      throw new Error(`Knowledge store connection "${normalizedId}" was not found in the project or host registry.`);
    }

    const providerId = typeof definition.provider === 'string' ? definition.provider.trim() : '';
    if (!providerId || providerId !== definition.provider) {
      throw new Error(`Knowledge store connection "${normalizedId}" has an invalid provider ID.`);
    }
    const provider = getKnowledgeStoreProvider(providerId);
    if (!provider) {
      throw new Error(
        `Knowledge store provider "${providerId}" for connection "${definition.displayName}" is not installed.`,
      );
    }
    const normalizedDefinition = normalizeConnectionDefinition(normalizedId, definition, provider);

    const executor = context.executor;
    if (!provider.supportedExecutors.includes(executor)) {
      throw new Error(
        `Knowledge store "${definition.displayName}" does not support the ${executor === 'nodejs' ? 'Node' : 'Browser'} executor.`,
      );
    }

    let projectStores = this.#resolvedStores.get(context.project);
    if (!projectStores) {
      projectStores = new Map();
      this.#resolvedStores.set(context.project, projectStores);
    }
    const storeCache = projectStores;
    let pending = storeCache.get(normalizedId);
    if (!pending) {
      const providerContext: KnowledgeStoreProviderContext = {
        executor: context.executor,
        project: context.project,
        settings: context.settings,
        credentials: readProviderCredentials(context.settings, provider, normalizedId),
      };
      pending = Promise.resolve(provider.createStore(normalizedId, normalizedDefinition, providerContext)).then(
        (store) => validateResolvedStore(store, normalizedId, context.executor),
      );
      storeCache.set(normalizedId, pending);
      pending.catch(() => storeCache.delete(normalizedId));
    }
    return pending;
  }
}

function validateResolvedStore(
  store: RivetKnowledgeStore,
  connectionId: string,
  executor: KnowledgeStoreResolutionContext['executor'],
): RivetKnowledgeStore {
  if (
    !store ||
    !store.capabilities ||
    typeof store.capabilities !== 'object' ||
    typeof store.getSourceStatus !== 'function' ||
    typeof store.syncSource !== 'function' ||
    typeof store.search !== 'function'
  ) {
    throw new Error(`Knowledge store "${connectionId}" did not resolve to a valid RivetKnowledgeStore.`);
  }
  validateStoreCapabilities(store.capabilities, connectionId);
  const supportedExecutors = store.capabilities.supportedExecutors;
  if (supportedExecutors && !supportedExecutors.includes(executor)) {
    throw new Error(
      `Knowledge store "${connectionId}" does not support the ${executor === 'nodejs' ? 'Node' : 'Browser'} executor.`,
    );
  }
  return store;
}

function readProviderCredentials(
  settings: Settings,
  provider: KnowledgeStoreProviderDefinition,
  connectionId: string,
): Record<string, string> {
  const providerSettings = readOwnProperty(settings.pluginSettings, provider.id);
  const credentialSets = isRecord(providerSettings)
    ? readOwnProperty(providerSettings, 'knowledgeStoreCredentials')
    : undefined;
  const storedCredentials = isRecord(credentialSets) ? readOwnProperty(credentialSets, connectionId) : undefined;
  const storedValues = isRecord(storedCredentials) ? storedCredentials : {};

  const credentials: Record<string, string> = {};
  for (const field of provider.credentialConfigSpec ?? []) {
    const value = hasOwnProperty(storedValues, field.key) ? storedValues[field.key] : field.default;
    if (value === undefined || value === '') {
      if (field.required) {
        throw new Error(`Knowledge store connection "${connectionId}" requires ${field.label}.`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(
        `Knowledge store connection "${connectionId}" has invalid stored credentials for ${field.label}.`,
      );
    }
    if (field.required && !value.trim()) {
      throw new Error(`Knowledge store connection "${connectionId}" requires ${field.label}.`);
    }
    credentials[field.key] = value;
  }
  return credentials;
}

function validateStoreCapabilities(capabilities: RivetKnowledgeStore['capabilities'], connectionId: string): void {
  if (
    capabilities.supportedExecutors != null &&
    (!Array.isArray(capabilities.supportedExecutors) ||
      capabilities.supportedExecutors.some((executor) => executor !== 'browser' && executor !== 'nodejs'))
  ) {
    throw new Error(`Knowledge store "${connectionId}" declares invalid executor capabilities.`);
  }
  const filterOperators = capabilities.supportedFilterOperators;
  const validFilterOperators = new Set(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists']);
  if (
    filterOperators != null &&
    (!Array.isArray(filterOperators) || filterOperators.some((operator) => !validFilterOperators.has(operator)))
  ) {
    throw new Error(`Knowledge store "${connectionId}" declares invalid filter capabilities.`);
  }
  if (capabilities.supportsProviderReranking != null && typeof capabilities.supportsProviderReranking !== 'boolean') {
    throw new Error(`Knowledge store "${connectionId}" declares an invalid reranking capability.`);
  }
}

function validateProviderFields(
  providerId: string,
  fields: KnowledgeStoreProviderConfigField[],
  kind: 'connection' | 'credential',
): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field !== 'object') {
      throw new Error(`Knowledge store provider "${providerId}" has an invalid ${kind} field.`);
    }
    if (typeof field.key !== 'string' || !field.key.trim() || field.key !== field.key.trim()) {
      throw new Error(`Knowledge store provider "${providerId}" has an invalid ${kind} field key.`);
    }
    if (isReservedKnowledgeObjectKey(field.key)) {
      throw new Error(`Knowledge store provider "${providerId}" uses reserved ${kind} field key "${field.key}".`);
    }
    if (seen.has(field.key)) {
      throw new Error(`Knowledge store provider "${providerId}" declares ${kind} field "${field.key}" more than once.`);
    }
    seen.add(field.key);
    if (!['string', 'number', 'boolean', 'secret', 'select'].includes(field.type)) {
      throw new Error(`Knowledge store provider "${providerId}" field "${field.key}" has an invalid type.`);
    }
    if (typeof field.label !== 'string' || !field.label.trim()) {
      throw new Error(`Knowledge store provider "${providerId}" has an unlabeled ${kind} field "${field.key}".`);
    }
    if (field.description != null && typeof field.description !== 'string') {
      throw new Error(`Knowledge store provider "${providerId}" field "${field.key}" has an invalid description.`);
    }
    if (field.required != null && typeof field.required !== 'boolean') {
      throw new Error(`Knowledge store provider "${providerId}" field "${field.key}" has an invalid required flag.`);
    }
    if (kind === 'connection' && field.type === 'secret') {
      throw new Error(
        `Knowledge store provider "${providerId}" must declare secret field "${field.key}" as a credential, not project configuration.`,
      );
    }
    if (kind === 'credential' && field.type !== 'string' && field.type !== 'secret') {
      throw new Error(
        `Knowledge store provider "${providerId}" credential field "${field.key}" must be a string or secret.`,
      );
    }
    if (field.type === 'select') {
      const options = field.options;
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.some(
          (option) =>
            !option ||
            typeof option !== 'object' ||
            typeof option.label !== 'string' ||
            !option.label.trim() ||
            typeof option.value !== 'string',
        ) ||
        new Set(options.map((option) => option.value)).size !== options.length
      ) {
        throw new Error(
          `Knowledge store provider "${providerId}" select field "${field.key}" requires labeled options with unique string values.`,
        );
      }
    }
    if (field.default !== undefined && !isProviderFieldValue(field, field.default)) {
      throw new Error(`Knowledge store provider "${providerId}" field "${field.key}" has an invalid default value.`);
    }
  }
}

function snapshotProviderDefinition(provider: KnowledgeStoreProviderDefinition): KnowledgeStoreProviderDefinition {
  const snapshotFields = <T extends KnowledgeStoreProviderConfigField>(fields: T[]): T[] =>
    Object.freeze(
      fields.map((field) =>
        Object.freeze({
          ...field,
          ...(field.options
            ? { options: Object.freeze(field.options.map((option) => Object.freeze({ ...option }))) }
            : {}),
        }),
      ),
    ) as unknown as T[];

  return Object.freeze({
    ...provider,
    connectionConfigSpec: snapshotFields(provider.connectionConfigSpec),
    ...(provider.credentialConfigSpec ? { credentialConfigSpec: snapshotFields(provider.credentialConfigSpec) } : {}),
    supportedExecutors: Object.freeze([...provider.supportedExecutors]) as unknown as Array<'browser' | 'nodejs'>,
  });
}

function normalizeConnectionDefinition(
  connectionId: string,
  definition: KnowledgeStoreConnectionDefinition,
  provider: KnowledgeStoreProviderDefinition,
): KnowledgeStoreConnectionDefinition {
  const displayName = typeof definition.displayName === 'string' ? definition.displayName.trim() : '';
  if (!displayName) throw new Error(`Knowledge store connection "${connectionId}" has no display name.`);
  if (!isRecord(definition.config)) {
    throw new Error(`Knowledge store connection "${displayName}" has invalid provider configuration.`);
  }

  const fieldsByKey = new Map(provider.connectionConfigSpec.map((field) => [field.key, field]));
  for (const key of Object.keys(definition.config)) {
    if (!fieldsByKey.has(key)) {
      throw new Error(`Knowledge store connection "${displayName}" contains unknown configuration field "${key}".`);
    }
  }

  const config: KnowledgeStoreConnectionDefinition['config'] = {};
  for (const field of provider.connectionConfigSpec) {
    const value = hasOwnProperty(definition.config, field.key) ? definition.config[field.key] : field.default;
    if (field.required && (value == null || (typeof value === 'string' && !value.trim()))) {
      throw new Error(`Knowledge store connection "${displayName}" requires ${field.label}.`);
    }
    if (value === undefined || value === '') continue;
    if (!isProviderFieldValue(field, value)) {
      throw new Error(`Knowledge store connection "${displayName}" has an invalid value for ${field.label}.`);
    }
    config[field.key] = value;
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
    config,
  };
}

function isProviderFieldValue(
  field: KnowledgeStoreProviderConfigField,
  value: unknown,
): value is string | number | boolean {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return field.type !== 'select' || (field.options ?? []).some((option) => option.value === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnProperty(value: unknown, key: string): unknown {
  return hasOwnProperty(value, key) ? value[key] : undefined;
}

function hasOwnProperty(value: unknown, key: string): value is Record<string, unknown> {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}
