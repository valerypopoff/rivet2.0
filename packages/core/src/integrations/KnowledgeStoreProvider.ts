import type { InternalProcessContext } from '../model/ProcessContext.js';
import type { KnowledgeStoreConnectionId, RivetKnowledgeStore, RivetKnowledgeStoreRegistry } from './KnowledgeStore.js';
import type { KnowledgeStoreConnectionDefinition } from '../model/Project.js';
import type { Settings } from '../model/Settings.js';
import { isReservedKnowledgeObjectKey, normalizeKnowledgeConnectionId } from './KnowledgeStoreValidation.js';
import {
  isKnowledgeStoreProviderFieldDefaultValid,
  normalizeKnowledgeStoreConnectionDefinition,
  readKnowledgeStoreConnectionCredentials,
} from './KnowledgeStoreFieldPolicy.js';

export type KnowledgeStoreProviderConfigField = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
};

export type KnowledgeStoreProviderCredentialField = Omit<
  KnowledgeStoreProviderConfigField,
  'type' | 'default' | 'options'
> & {
  type: 'string' | 'secret';
  default?: string;
  options?: never;
};

export type KnowledgeStoreProviderDefinition = {
  id: string;
  displayName: string;
  /** Rivet plugin that owns this provider. Defaults to the provider ID. */
  pluginId?: string;
  connectionConfigSpec: KnowledgeStoreProviderConfigField[];
  credentialConfigSpec?: KnowledgeStoreProviderCredentialField[];
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
    const normalizedDefinition = normalizeKnowledgeStoreConnectionDefinition(normalizedId, definition, provider);

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
        credentials: resolveProviderCredentials(context.settings, provider, normalizedId),
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

function resolveProviderCredentials(
  settings: Settings,
  provider: KnowledgeStoreProviderDefinition,
  connectionId: string,
): Record<string, string> {
  const result = readKnowledgeStoreConnectionCredentials(settings, provider, connectionId);
  if (result.ok) return result.value;
  throw new Error(
    result.issue.code === 'required'
      ? `Knowledge store connection "${connectionId}" requires ${result.issue.fieldLabel}.`
      : `Knowledge store connection "${connectionId}" has invalid stored credentials for ${result.issue.fieldLabel}.`,
  );
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
    if (kind === 'credential' && field.options !== undefined) {
      throw new Error(
        `Knowledge store provider "${providerId}" credential field "${field.key}" cannot declare select options.`,
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
    if (field.default !== undefined && !isKnowledgeStoreProviderFieldDefaultValid(field, field.default)) {
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
