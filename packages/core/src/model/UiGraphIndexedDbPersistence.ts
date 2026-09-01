import { isAgentResponseTrace, type AgentResponseTrace } from './AgentResponseTrace.js';
import {
  getUiGraphChatPersistentState,
  getUiGraphChatStorageKey,
  getUiGraphResponseTraceStorageKey,
  getUiGraphWebAppStorageKey,
  loadUiGraphChatPersistentState,
  loadUiGraphWebAppStorage,
  saveUiGraphChatPersistentState,
} from './UiGraphBrowserRuntime.js';
import { getUiGraphChatMessages, type UiGraph } from './UiGraph.js';
import {
  IndexedDbWebAppBrowserStorage,
  RIVET_WEB_APP_LEGACY_RETENTION_MS,
  WebAppBrowserStoragePersistenceError,
  type WebAppBrowserStorageBatchChange,
  type IndexedDbWebAppBrowserStorageOptions,
  type WebAppBrowserStorageChange,
  type WebAppBrowserStorageStatus,
} from './WebAppBrowserStorage.js';
import {
  cloneRivetStoredValue,
  cloneRivetStoredValueRecord,
  type RivetStoredValue,
  type RivetStoredValueRecord,
} from './StoredValueStore.js';

type BrowserStorageLocation = Pick<Location, 'origin' | 'pathname'>;
type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

const CHAT_STATE_RECORD_KEY = 'state';
const RESPONSE_TRACE_LIMIT = 100;

export type UiGraphBrowserPersistenceWarning = Readonly<{
  code:
    | 'indexeddb-unavailable'
    | 'migration-failed'
    | 'persistence-failed'
    | 'quota-exhausted'
    | 'transport-incompatible';
  message: string;
}>;
export type UiGraphBrowserPersistenceDiagnostic = Readonly<{
  operation: 'open' | 'migration' | 'cleanup' | 'write' | 'transport';
  outcome: 'success' | 'failure' | 'fallback';
}>;

export type UiGraphBrowserPersistenceOptions = IndexedDbWebAppBrowserStorageOptions &
  Readonly<{
    legacyStorage?: LegacyStorage;
    location?: BrowserStorageLocation;
    onDiagnostic?(diagnostic: UiGraphBrowserPersistenceDiagnostic): void;
  }>;

/**
 * UI-graph-specific adapter over the generic IndexedDB store. It owns exact
 * legacy-key migration and keeps localStorage out of the new runtime path.
 */
export class UiGraphBrowserPersistence {
  readonly #store: IndexedDbWebAppBrowserStorage;
  readonly #uiGraph: UiGraph;
  readonly #legacyStorage: LegacyStorage | undefined;
  readonly #location: BrowserStorageLocation | undefined;
  readonly #now: () => number;
  readonly #onDiagnostic: (diagnostic: UiGraphBrowserPersistenceDiagnostic) => void;
  readonly #listeners = new Set<(change: WebAppBrowserStorageChange) => void>();
  readonly #warningListeners = new Set<(warning: UiGraphBrowserPersistenceWarning | undefined) => void>();
  #status: WebAppBrowserStorageStatus = { durable: false, reason: 'indexeddb-unavailable' };
  #warning: UiGraphBrowserPersistenceWarning | undefined;
  #disposeStoreSubscription: (() => void) | undefined;
  #responseTraceMutationQueue: Promise<void> = Promise.resolve();
  #useLegacyStorage = true;

  constructor(uiGraph: UiGraph, options: UiGraphBrowserPersistenceOptions = {}) {
    this.#uiGraph = uiGraph;
    this.#legacyStorage = options.legacyStorage ?? getDefaultLegacyStorage();
    this.#now = options.now ?? Date.now;
    this.#onDiagnostic = options.onDiagnostic ?? defaultBrowserStorageDiagnostic;
    this.#location = options.location ?? getDefaultLocation();
    this.#store = new IndexedDbWebAppBrowserStorage(options);
  }

  async initialize(): Promise<WebAppBrowserStorageStatus> {
    const location = this.#location;
    if (!location?.origin) {
      this.#reportDiagnostic({ operation: 'open', outcome: 'fallback' });
      this.#setWarning({
        code: 'indexeddb-unavailable',
        message: 'Saved browser data is unavailable. Changes will last only until this page is closed.',
      });
      return this.#status;
    }
    this.#status = await this.#store.initialize({
      origin: location.origin,
      pathname: location.pathname,
      uiGraphId: String(this.#uiGraph.id),
    });
    this.#reportDiagnostic({ operation: 'open', outcome: this.#status.durable ? 'success' : 'fallback' });
    this.#disposeStoreSubscription = this.#store.subscribe((change) => {
      for (const listener of this.#listeners) listener(change);
    });
    if (!this.#status.durable) {
      this.#setWarning({
        code: 'indexeddb-unavailable',
        message: 'Saved browser data is unavailable. Changes will use limited legacy storage for this page.',
      });
      return this.#status;
    }

    // Once IndexedDB is available, new writes must use it even if importing a
    // frozen legacy value fails. Reads below can still recover an exact legacy
    // record until its migration ledger entry is committed.
    this.#useLegacyStorage = false;
    const migratedLegacyRecords = await this.#tryMigrateLegacyRecords();
    if (migratedLegacyRecords) {
      try {
        await this.#cleanupExpiredLegacyRecords();
        this.#reportDiagnostic({ operation: 'cleanup', outcome: 'success' });
      } catch {
        this.#reportDiagnostic({ operation: 'cleanup', outcome: 'failure' });
      }
      this.#setWarning(undefined);
    }
    return this.#status;
  }

  get status(): WebAppBrowserStorageStatus {
    return this.#status;
  }

  get warning(): UiGraphBrowserPersistenceWarning | undefined {
    return this.#warning;
  }

  subscribe(listener: (change: WebAppBrowserStorageChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeWarning(listener: (warning: UiGraphBrowserPersistenceWarning | undefined) => void): () => void {
    this.#warningListeners.add(listener);
    return () => this.#warningListeners.delete(listener);
  }

  async loadChatState(): Promise<Record<string, unknown>> {
    if (this.#useLegacyStorage) {
      return loadUiGraphChatPersistentState(this.#uiGraph, this.#legacyStorage, this.#location);
    }
    const value = await this.#store.get('chat-state', CHAT_STATE_RECORD_KEY);
    if (isRecord(value)) return getUiGraphChatPersistentState(this.#uiGraph, value);
    return await this.#loadLegacyChatStateIfUnmigrated();
  }

  async saveChatState(state: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#useLegacyStorage) {
      saveUiGraphChatPersistentState(this.#uiGraph, state, this.#legacyStorage, this.#location);
      return;
    }
    await this.#tryMigrateLegacyRecords();
    const persistentState = getUiGraphChatPersistentState(this.#uiGraph, state);
    await this.#persist(() =>
      Object.keys(persistentState).length === 0
        ? this.#store.delete('chat-state', CHAT_STATE_RECORD_KEY)
        : this.#store.set('chat-state', CHAT_STATE_RECORD_KEY, cloneRivetStoredValue(persistentState)),
    );
  }

  async loadStoredValues(): Promise<RivetStoredValueRecord> {
    if (this.#useLegacyStorage) {
      return cloneRivetStoredValueRecord(
        loadUiGraphWebAppStorage(this.#uiGraph, this.#legacyStorage, this.#location),
        'Stored Value browser snapshot',
      );
    }
    const indexedDbValues = Object.fromEntries(
      (await this.#store.list('stored-values')).map(({ key, value }) => [key, value]),
    );
    const legacyValues = await this.#loadLegacyStoredValuesIfUnmigrated();
    return cloneRivetStoredValueRecord({ ...legacyValues, ...indexedDbValues }, 'Stored Value browser snapshot');
  }

  async loadStoredValue(key: string): Promise<RivetStoredValue | undefined> {
    if (this.#useLegacyStorage) {
      const values = await this.loadStoredValues();
      return Object.prototype.hasOwnProperty.call(values, key)
        ? cloneRivetStoredValue(values[key], 'Stored Value browser value')
        : undefined;
    }
    const value = await this.#store.get('stored-values', key);
    if (value !== undefined) return cloneRivetStoredValue(value, 'Stored Value browser value');
    const legacyValues = await this.#loadLegacyStoredValuesIfUnmigrated();
    return Object.prototype.hasOwnProperty.call(legacyValues, key)
      ? cloneRivetStoredValue(legacyValues[key], 'Stored Value browser value')
      : undefined;
  }

  async applyStoredValuePatch(
    patch: Readonly<Record<string, unknown>>,
    options: Readonly<{ requireDurable?: boolean }> = {},
  ): Promise<void> {
    const portablePatch = cloneRivetStoredValueRecord(patch, 'Stored Value browser patch');
    if (this.#useLegacyStorage) {
      const legacyKey = getUiGraphWebAppStorageKey(this.#uiGraph, this.#location);
      if (!legacyKey || !this.#legacyStorage) throw new Error('Browser storage is unavailable for this web app.');
      const current = await this.loadStoredValues();
      const next = cloneRivetStoredValueRecord({ ...current, ...portablePatch }, 'Stored Value browser snapshot');
      this.#legacyStorage.setItem(legacyKey, JSON.stringify(next));
      return;
    }
    await this.#tryMigrateLegacyRecords();
    await this.#persist(
      () =>
        this.#store.commitBatch(
          Object.entries(portablePatch).map(([key, value]) => ({ key, namespace: 'stored-values', value })),
        ),
      options.requireDurable === true,
    );
  }

  async loadResponseTrace(componentId: string, traceId: string): Promise<AgentResponseTrace | undefined> {
    const traces = await this.#loadResponseTraces(componentId);
    return traces.find((trace) => trace.traceId === traceId);
  }

  async saveResponseTrace(componentId: string, trace: AgentResponseTrace): Promise<void> {
    if (!isAgentResponseTrace(trace) || !this.#isResponseInspectionEnabled(componentId)) return;
    await this.#enqueueResponseTraceMutation(async () => {
      const traces = (await this.#loadResponseTraces(componentId)).filter(
        (candidate) => candidate.traceId !== trace.traceId,
      );
      traces.push(trace);
      await this.#saveResponseTraces(componentId, traces.slice(-RESPONSE_TRACE_LIMIT));
    });
  }

  async pruneResponseTraces(state: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#enqueueResponseTraceMutation(async () => {
      for (const component of this.#uiGraph.components) {
        if (component.type !== 'chat') continue;
        const referenced =
          component.allowResponseInspection === true
            ? new Set(
                getUiGraphChatMessages(component.id, state).flatMap((message) =>
                  typeof message.responseTraceId === 'string' ? [message.responseTraceId] : [],
                ),
              )
            : new Set<string>();
        const retained = (await this.#loadResponseTraces(String(component.id))).filter((trace) =>
          referenced.has(trace.traceId),
        );
        await this.#saveResponseTraces(String(component.id), retained);
      }
    });
  }

  reportTransportIncompatibility(message: string): void {
    this.#reportDiagnostic({ operation: 'transport', outcome: 'failure' });
    if (this.#warning && this.#warning.code !== 'transport-incompatible') return;
    this.#setWarning({ code: 'transport-incompatible', message });
  }

  clearTransportIncompatibility(): void {
    if (this.#warning?.code === 'transport-incompatible') {
      this.#setWarning(undefined);
    }
  }

  async estimateUsage(): Promise<{ quota?: number; usage?: number }> {
    return await this.#store.estimateUsage();
  }

  dispose(): void {
    this.#disposeStoreSubscription?.();
    this.#disposeStoreSubscription = undefined;
    this.#listeners.clear();
    this.#warningListeners.clear();
    this.#store.dispose();
  }

  async #loadResponseTraces(componentId: string): Promise<AgentResponseTrace[]> {
    if (!this.#isResponseInspectionEnabled(componentId)) return [];
    if (this.#useLegacyStorage) return this.#loadLegacyResponseTraces(componentId);
    const value = await this.#store.get('response-traces', componentId);
    return Array.isArray(value) ? value.filter(isAgentResponseTrace).slice(-RESPONSE_TRACE_LIMIT) : [];
  }

  async #saveResponseTraces(componentId: string, traces: AgentResponseTrace[]): Promise<void> {
    if (this.#useLegacyStorage) {
      const legacyKey = getUiGraphResponseTraceStorageKey(this.#uiGraph, componentId, this.#location);
      if (!legacyKey || !this.#legacyStorage) return;
      if (traces.length === 0) this.#legacyStorage.removeItem(legacyKey);
      else this.#legacyStorage.setItem(legacyKey, JSON.stringify(traces));
      return;
    }
    await this.#persist(() =>
      traces.length === 0
        ? this.#store.delete('response-traces', componentId)
        : this.#store.set('response-traces', componentId, cloneRivetStoredValue(traces)),
    );
  }

  #loadLegacyResponseTraces(componentId: string): AgentResponseTrace[] {
    const legacyKey = getUiGraphResponseTraceStorageKey(this.#uiGraph, componentId, this.#location);
    if (!legacyKey || !this.#legacyStorage) return [];
    try {
      const raw = this.#legacyStorage.getItem(legacyKey);
      const value: unknown = raw ? JSON.parse(raw) : undefined;
      return Array.isArray(value) ? value.filter(isAgentResponseTrace).slice(-RESPONSE_TRACE_LIMIT) : [];
    } catch {
      return [];
    }
  }

  #isResponseInspectionEnabled(componentId: string): boolean {
    return this.#uiGraph.components.some(
      (component) =>
        component.type === 'chat' && String(component.id) === componentId && component.allowResponseInspection === true,
    );
  }

  async #enqueueResponseTraceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#responseTraceMutationQueue.catch(() => undefined).then(operation);
    this.#responseTraceMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async #tryMigrateLegacyRecords(): Promise<boolean> {
    try {
      if (!(await this.#migrateLegacyRecords())) {
        this.#reportDiagnostic({ operation: 'migration', outcome: 'success' });
        if (this.#warning?.code === 'migration-failed') this.#setWarning(undefined);
        return true;
      }
    } catch {
      // The original localStorage value remains untouched. New writes still use IndexedDB.
    }
    this.#reportMigrationFailure(
      'Existing browser data could not be migrated safely. Rivet kept the original copy and will try again later.',
    );
    return false;
  }

  #reportMigrationFailure(message: string): void {
    this.#reportDiagnostic({ operation: 'migration', outcome: 'failure' });
    this.#setWarning({ code: 'migration-failed', message });
  }

  async #loadLegacyChatStateIfUnmigrated(): Promise<Record<string, unknown>> {
    const legacyKey = getUiGraphChatStorageKey(this.#uiGraph, this.#location);
    if (!legacyKey || (await this.#store.getMigration(legacyKey))) return {};
    const raw = this.#legacyStorage?.getItem(legacyKey);
    if (raw == null) return {};
    try {
      const value: unknown = JSON.parse(raw);
      assertValidLegacyChatState(this.#uiGraph, value);
      const state = getUiGraphChatPersistentState(this.#uiGraph, value);
      await this.#tryMigrateLegacyRecords();
      return state;
    } catch {
      this.#reportMigrationFailure(
        'Some existing browser data was invalid and could not be migrated. Rivet kept its original copy.',
      );
      return {};
    }
  }

  async #loadLegacyStoredValuesIfUnmigrated(): Promise<RivetStoredValueRecord> {
    const legacyKey = getUiGraphWebAppStorageKey(this.#uiGraph, this.#location);
    if (!legacyKey || (await this.#store.getMigration(legacyKey))) return {};
    const raw = this.#legacyStorage?.getItem(legacyKey);
    if (raw == null) return {};
    try {
      const values = cloneRivetStoredValueRecord(
        JSON.parse(raw) as Record<string, unknown>,
        'Legacy Stored Value snapshot',
      );
      await this.#tryMigrateLegacyRecords();
      return values;
    } catch {
      this.#reportMigrationFailure(
        'Some existing browser data was invalid and could not be migrated. Rivet kept its original copy.',
      );
      return {};
    }
  }

  async #migrateLegacyRecords(): Promise<boolean> {
    const legacyStorage = this.#legacyStorage;
    if (!legacyStorage) return false;
    let hasUnmigratedLegacyRecords = false;
    const now = this.#now();
    const migrations: Array<{
      key: string;
      legacyKey: string | undefined;
      namespace: 'chat-state' | 'response-traces' | 'stored-values';
      parse(raw: string): WebAppBrowserStorageBatchChange[];
    }> = [
      {
        key: CHAT_STATE_RECORD_KEY,
        legacyKey: getUiGraphChatStorageKey(this.#uiGraph, this.#location),
        namespace: 'chat-state',
        parse: (raw) => {
          const value: unknown = JSON.parse(raw);
          assertValidLegacyChatState(this.#uiGraph, value);
          const state = getUiGraphChatPersistentState(this.#uiGraph, value);
          return Object.keys(state).length > 0
            ? [{ key: CHAT_STATE_RECORD_KEY, namespace: 'chat-state', value: cloneRivetStoredValue(state) }]
            : [];
        },
      },
      {
        key: 'legacy-snapshot',
        legacyKey: getUiGraphWebAppStorageKey(this.#uiGraph, this.#location),
        namespace: 'stored-values',
        parse: (raw) =>
          Object.entries(
            cloneRivetStoredValueRecord(JSON.parse(raw) as Record<string, unknown>, 'Legacy Stored Value snapshot'),
          ).map(([key, value]) => ({ key, namespace: 'stored-values' as const, value })),
      },
      ...this.#uiGraph.components.flatMap((component) =>
        component.type !== 'chat'
          ? []
          : [
              {
                key: String(component.id),
                legacyKey: getUiGraphResponseTraceStorageKey(this.#uiGraph, String(component.id), this.#location),
                namespace: 'response-traces' as const,
                parse: (raw: string) => {
                  const value: unknown = JSON.parse(raw);
                  if (!Array.isArray(value) || !value.every(isAgentResponseTrace)) {
                    throw new Error('Legacy Chat response traces are invalid.');
                  }
                  const traces = value.slice(-RESPONSE_TRACE_LIMIT);
                  return traces.length > 0
                    ? [
                        {
                          key: String(component.id),
                          namespace: 'response-traces' as const,
                          value: cloneRivetStoredValue(traces),
                        },
                      ]
                    : [];
                },
              },
            ],
      ),
    ];

    for (const migration of migrations) {
      if (!migration.legacyKey || (await this.#store.getMigration(migration.legacyKey))) continue;
      const raw = legacyStorage.getItem(migration.legacyKey);
      if (raw == null) continue;
      let parsed: WebAppBrowserStorageBatchChange[];
      try {
        parsed = migration.parse(raw);
      } catch {
        hasUnmigratedLegacyRecords = true;
        continue;
      }
      const missing: WebAppBrowserStorageBatchChange[] = [];
      let hasMemoryOnlyRecord = false;
      for (const change of parsed) {
        if (this.#store.hasMemoryOnlyRecord(change.namespace, change.key)) {
          hasMemoryOnlyRecord = true;
          break;
        }
        if ((await this.#store.get(change.namespace, change.key)) === undefined) missing.push(change);
      }
      if (hasMemoryOnlyRecord) {
        hasUnmigratedLegacyRecords = true;
        continue;
      }
      if (missing.length > 0) await this.#store.commitBatch(missing);
      await this.#store.recordMigration({
        cleanupAfter: now + RIVET_WEB_APP_LEGACY_RETENTION_MS,
        completedAt: now,
        key: migration.key,
        legacyKey: migration.legacyKey,
        namespace: migration.namespace,
      });
    }
    return hasUnmigratedLegacyRecords;
  }

  async #cleanupExpiredLegacyRecords(): Promise<void> {
    if (!this.#legacyStorage) return;
    const now = this.#now();
    for (const migration of await this.#store.listMigrations()) {
      if (migration.cleanupAfter <= now) this.#legacyStorage.removeItem(migration.legacyKey);
    }
  }

  async #persist(operation: () => Promise<unknown>, requireDurable = false): Promise<void> {
    try {
      const result = await operation();
      if (isStorageStatus(result) && !result.durable) {
        this.#reportDiagnostic({ operation: 'write', outcome: 'failure' });
        this.#status = result;
        const warning: UiGraphBrowserPersistenceWarning = {
          code: 'persistence-failed',
          message: 'Some browser data exists only in memory and will not survive a reload.',
        };
        this.#setWarning(warning);
        if (requireDurable) throw new Error(warning.message);
      } else if (isStorageCommitResult(result) && result.hasMemoryOnlyRecords) {
        this.#reportDiagnostic({ operation: 'write', outcome: 'failure' });
        this.#status = { durable: false, reason: 'write-failed' };
        this.#setWarning({
          code: 'persistence-failed',
          message: 'Some browser data exists only in memory and will not survive a reload.',
        });
      } else {
        this.#status = { durable: true };
        if (this.#warning?.code === 'persistence-failed') this.#setWarning(undefined);
      }
    } catch (error) {
      if (error instanceof WebAppBrowserStoragePersistenceError) {
        this.#reportDiagnostic({ operation: 'write', outcome: 'failure' });
        this.#status = { durable: false, reason: 'write-failed' };
        const warning: UiGraphBrowserPersistenceWarning = isQuotaExceededError(error)
          ? {
              code: 'quota-exhausted',
              message: 'Browser storage is full. Changes will last only until this page is closed.',
            }
          : { code: 'persistence-failed', message: error.message };
        this.#setWarning(warning);
        if (requireDurable) throw new Error(warning.message, { cause: error });
        return;
      }
      throw error;
    }
  }

  #reportDiagnostic(diagnostic: UiGraphBrowserPersistenceDiagnostic): void {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never affect browser persistence.
    }
  }

  #setWarning(warning: UiGraphBrowserPersistenceWarning | undefined): void {
    if (this.#warning?.code === warning?.code && this.#warning?.message === warning?.message) return;
    this.#warning = warning;
    for (const listener of this.#warningListeners) listener(warning);
  }
}

function defaultBrowserStorageDiagnostic(diagnostic: UiGraphBrowserPersistenceDiagnostic): void {
  globalThis.console?.debug?.('[rivet-web-app-storage]', diagnostic);
}

function isQuotaExceededError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.name === 'QuotaExceededError') return true;
    current = current.cause;
  }
  return false;
}

function isStorageStatus(value: unknown): value is WebAppBrowserStorageStatus {
  return isRecord(value) && typeof value.durable === 'boolean';
}

function isStorageCommitResult(
  value: unknown,
): value is WebAppBrowserStorageStatus & { hasMemoryOnlyRecords?: boolean } {
  return isStorageStatus(value) && ('revision' in value || 'hasMemoryOnlyRecords' in value);
}

function getDefaultLegacyStorage(): LegacyStorage | undefined {
  try {
    return globalThis.localStorage ?? globalThis.window?.localStorage;
  } catch {
    return undefined;
  }
}

function getDefaultLocation(): BrowserStorageLocation | undefined {
  try {
    return globalThis.location ?? globalThis.window?.location;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValidLegacyChatState(uiGraph: UiGraph, value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Legacy Chat state must be a JSON object.');
  for (const component of uiGraph.components) {
    if (component.type !== 'chat') continue;
    const draft = value[`__rivet_chat_${component.id}_draft`];
    const messages = value[`__rivet_chat_${component.id}_messages`];
    const pins = value[`__rivet_chat_${component.id}_pins`];
    if (draft !== undefined && typeof draft !== 'string') {
      throw new Error('Legacy Chat draft is invalid.');
    }
    if (messages !== undefined && (!Array.isArray(messages) || !messages.every(isValidLegacyChatMessage))) {
      throw new Error('Legacy Chat messages are invalid.');
    }
    if (
      pins !== undefined &&
      (!Array.isArray(pins) || !pins.every((pin) => typeof pin === 'number' && Number.isSafeInteger(pin) && pin >= 0))
    ) {
      throw new Error('Legacy Chat pins are invalid.');
    }
  }
}

function isValidLegacyChatMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    (value.timestamp === undefined || typeof value.timestamp === 'string') &&
    (value.responseTraceId === undefined || typeof value.responseTraceId === 'string')
  );
}
