import { cloneRivetStoredValue, type RivetStoredValue } from './StoredValueStore.js';

export const RIVET_WEB_APP_BROWSER_STORAGE_DATABASE = 'rivet-web-app-browser-storage';
export const RIVET_WEB_APP_BROWSER_STORAGE_SCHEMA_VERSION = 1;
export const RIVET_WEB_APP_BROWSER_STORAGE_CHUNK_BYTES = 256 * 1024;
export const RIVET_WEB_APP_LEGACY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const METADATA_STORE = 'metadata';
const CHUNKS_STORE = 'chunks';
const MIGRATIONS_STORE = 'migrations';
const STAGING_STORE = 'staging';
const RECORD_GENERATION_INDEX = 'record-generation';
const SCHEMA_METADATA_ID = '__rivet_schema__';
const BROADCAST_CHANNEL_NAME = 'rivet-web-app-browser-storage:v1';

export type WebAppBrowserStorageNamespace = 'chat-state' | 'response-traces' | 'stored-values';

export type WebAppBrowserStorageScope = Readonly<{
  origin: string;
  pathname: string;
  uiGraphId: string;
}>;

export type WebAppBrowserStorageStatus = Readonly<{
  durable: boolean;
  reason?: 'indexeddb-unavailable' | 'open-failed' | 'write-failed';
}>;

export type WebAppBrowserStorageCommitResult = WebAppBrowserStorageStatus &
  Readonly<{
    hasMemoryOnlyRecords?: boolean;
    revision: number;
  }>;

export type WebAppBrowserStorageChange = Readonly<{
  key: string;
  namespace: WebAppBrowserStorageNamespace;
  revision: number;
}>;

export type WebAppBrowserStorageBatchChange = Readonly<{
  key: string;
  namespace: WebAppBrowserStorageNamespace;
  value?: RivetStoredValue;
}>;

export type WebAppBrowserStorageEstimate = Readonly<{
  quota?: number;
  usage?: number;
}>;

export type WebAppBrowserStorageEntry = Readonly<{
  key: string;
  value: RivetStoredValue;
}>;

export interface WebAppBrowserStorage {
  initialize(scope: WebAppBrowserStorageScope): Promise<WebAppBrowserStorageStatus>;
  get(namespace: WebAppBrowserStorageNamespace, key: string): Promise<RivetStoredValue | undefined>;
  list(namespace: WebAppBrowserStorageNamespace): Promise<WebAppBrowserStorageEntry[]>;
  set(
    namespace: WebAppBrowserStorageNamespace,
    key: string,
    value: RivetStoredValue,
  ): Promise<WebAppBrowserStorageCommitResult>;
  delete(namespace: WebAppBrowserStorageNamespace, key: string): Promise<WebAppBrowserStorageCommitResult>;
  commitBatch(changes: readonly WebAppBrowserStorageBatchChange[]): Promise<WebAppBrowserStorageCommitResult>;
  subscribe(listener: (change: WebAppBrowserStorageChange) => void): () => void;
  estimateUsage(): Promise<WebAppBrowserStorageEstimate>;
  dispose(): void;
}

export type WebAppBrowserStorageMigration = Readonly<{
  cleanupAfter: number;
  completedAt: number;
  key: string;
  legacyKey: string;
  namespace: WebAppBrowserStorageNamespace;
}>;

export type IndexedDbWebAppBrowserStorageOptions = Readonly<{
  broadcastChannelFactory?: (name: string) => BroadcastChannel;
  databaseName?: string;
  indexedDB?: IDBFactory | null;
  now?: () => number;
  storageManager?: Pick<StorageManager, 'estimate'>;
}>;

type StoredRecordMetadata = {
  byteLength: number;
  chunkCount: number;
  deleted?: boolean;
  generation: string;
  id: string;
  key: string;
  namespace: WebAppBrowserStorageNamespace;
  revision: number;
  scopeId: string;
  updatedAt: number;
};

type StoredChunk = {
  bytes: ArrayBuffer;
  generation: string;
  index: number;
  recordId: string;
};

type StagingRecord = {
  createdAt: number;
  generation: string;
  id: string;
  recordId: string;
};

type StoredMigration = WebAppBrowserStorageMigration & {
  id: string;
  scopeId: string;
};

type BroadcastMessage = {
  key: string;
  namespace: WebAppBrowserStorageNamespace;
  revision: number;
  scopeId: string;
  sourceId: string;
  type: 'record-changed';
};

type PreparedChange = {
  chunks: ArrayBuffer[];
  id: string;
  key: string;
  namespace: WebAppBrowserStorageNamespace;
  serialized?: Uint8Array;
};

/**
 * Browser-local Rivet web-app persistence. Values are chunked to avoid relying
 * on browser-specific maximum IndexedDB record sizes. The memory mirror is
 * updated even when persistence fails so the current page remains usable.
 */
export class IndexedDbWebAppBrowserStorage implements WebAppBrowserStorage {
  readonly #databaseName: string;
  readonly #factory: IDBFactory | undefined;
  readonly #now: () => number;
  readonly #storageManager: Pick<StorageManager, 'estimate'> | undefined;
  readonly #broadcastChannelFactory: ((name: string) => BroadcastChannel) | undefined;
  readonly #listeners = new Set<(change: WebAppBrowserStorageChange) => void>();
  readonly #memory = new Map<string, RivetStoredValue>();
  readonly #memoryDeleted = new Set<string>();
  readonly #memoryOnly = new Set<string>();
  readonly #instanceId = createGeneration();
  readonly #knownRevisions = new Map<string, number>();
  readonly #focusListener = () => void this.#recheckRevisions();
  #channel: BroadcastChannel | undefined;
  #database: IDBDatabase | undefined;
  #openPromise: Promise<IDBDatabase> | undefined;
  #scope: WebAppBrowserStorageScope | undefined;
  #scopeId: string | undefined;
  #status: WebAppBrowserStorageStatus = { durable: false, reason: 'indexeddb-unavailable' };
  #writeQueue: Promise<void> = Promise.resolve();
  #lastRevision = 0;

  constructor(options: IndexedDbWebAppBrowserStorageOptions = {}) {
    this.#databaseName = options.databaseName ?? RIVET_WEB_APP_BROWSER_STORAGE_DATABASE;
    this.#factory = options.indexedDB === undefined ? getDefaultIndexedDbFactory() : options.indexedDB ?? undefined;
    this.#now = options.now ?? Date.now;
    this.#storageManager = options.storageManager ?? getDefaultStorageManager();
    this.#broadcastChannelFactory = options.broadcastChannelFactory ?? getDefaultBroadcastChannelFactory();
  }

  async initialize(scope: WebAppBrowserStorageScope): Promise<WebAppBrowserStorageStatus> {
    const normalized = normalizeScope(scope);
    const nextScopeId = serializeScope(normalized);
    if (this.#scopeId && this.#scopeId !== nextScopeId) {
      throw new Error('A browser storage instance cannot be reused for another web app scope.');
    }
    this.#scope = normalized;
    this.#scopeId = nextScopeId;
    this.#ensureBroadcastChannel();
    if (!this.#factory) return this.#status;

    try {
      this.#database = await this.#openDatabase();
      await this.#ensureSchemaMetadata();
      this.#status = { durable: true };
      await this.#removeAbandonedStaging();
      globalThis.addEventListener?.('focus', this.#focusListener);
    } catch {
      this.#status = { durable: false, reason: 'open-failed' };
    }
    return this.#status;
  }

  async get(namespace: WebAppBrowserStorageNamespace, key: string): Promise<RivetStoredValue | undefined> {
    const id = this.#recordId(namespace, key);
    if (this.#memoryDeleted.has(id)) return undefined;
    const memoryValue = this.#memory.get(id);
    if (memoryValue !== undefined) return cloneRivetStoredValue(memoryValue, 'Browser stored value');
    if (!this.#database) return undefined;

    const transaction = this.#database.transaction([METADATA_STORE, CHUNKS_STORE], 'readonly');
    const metadata = await requestResult<StoredRecordMetadata | undefined>(
      transaction.objectStore(METADATA_STORE).get(id),
    );
    if (!metadata) {
      await transactionDone(transaction);
      this.#knownRevisions.set(id, 0);
      return undefined;
    }
    if (metadata.deleted) {
      await transactionDone(transaction);
      this.#memory.delete(id);
      this.#memoryDeleted.add(id);
      this.#knownRevisions.set(id, metadata.revision);
      return undefined;
    }
    const chunks = await requestResult<StoredChunk[]>(
      transaction
        .objectStore(CHUNKS_STORE)
        .index(RECORD_GENERATION_INDEX)
        .getAll(IDBKeyRange.only([id, metadata.generation])),
    );
    await transactionDone(transaction);
    const value = decodeChunks(metadata, chunks);
    this.#memory.set(id, value);
    this.#knownRevisions.set(id, metadata.revision);
    return cloneRivetStoredValue(value, 'Browser stored value');
  }

  async list(namespace: WebAppBrowserStorageNamespace): Promise<WebAppBrowserStorageEntry[]> {
    const scopeId = this.#requireScope();
    const entries = new Map<string, RivetStoredValue>();
    const database = this.#database;
    if (database) {
      const transaction = database.transaction([METADATA_STORE, CHUNKS_STORE], 'readonly');
      const records = (await requestResult<unknown[]>(transaction.objectStore(METADATA_STORE).getAll()))
        .filter(isStoredRecordMetadata)
        .filter((metadata) => metadata.scopeId === scopeId && metadata.namespace === namespace && !metadata.deleted)
        .sort((left, right) => left.key.localeCompare(right.key));
      for (const metadata of records) {
        if (this.#memoryDeleted.has(metadata.id)) continue;
        const memoryValue = this.#memory.get(metadata.id);
        if (memoryValue !== undefined) {
          entries.set(metadata.key, cloneRivetStoredValue(memoryValue, 'Browser stored value'));
          continue;
        }
        const chunks = await requestResult<StoredChunk[]>(
          transaction
            .objectStore(CHUNKS_STORE)
            .index(RECORD_GENERATION_INDEX)
            .getAll(IDBKeyRange.only([metadata.id, metadata.generation])),
        );
        const value = decodeChunks(metadata, chunks);
        this.#memory.set(metadata.id, value);
        this.#knownRevisions.set(metadata.id, metadata.revision);
        entries.set(metadata.key, cloneRivetStoredValue(value, 'Browser stored value'));
      }
      await transactionDone(transaction);
    }
    const prefix = `${scopeId}\u0000${namespace}\u0000`;
    for (const [id, value] of this.#memory) {
      if (!id.startsWith(prefix) || this.#memoryDeleted.has(id)) continue;
      entries.set(id.slice(prefix.length), cloneRivetStoredValue(value, 'Browser stored value'));
    }
    return [...entries].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value }));
  }

  async set(
    namespace: WebAppBrowserStorageNamespace,
    key: string,
    value: RivetStoredValue,
  ): Promise<WebAppBrowserStorageCommitResult> {
    return await this.commitBatch([{ key, namespace, value }]);
  }

  async delete(namespace: WebAppBrowserStorageNamespace, key: string): Promise<WebAppBrowserStorageCommitResult> {
    return await this.commitBatch([{ key, namespace }]);
  }

  async commitBatch(changes: readonly WebAppBrowserStorageBatchChange[]): Promise<WebAppBrowserStorageCommitResult> {
    this.#requireScope();
    if (changes.length === 0) return { ...this.#status, revision: this.#now() };
    const prepared = changes.map((change) => prepareChange(this.#recordId(change.namespace, change.key), change));
    if (new Set(prepared.map((change) => change.id)).size !== prepared.length) {
      throw new Error('A browser storage batch cannot change the same scoped key more than once.');
    }
    for (const change of prepared) {
      if (change.serialized) {
        const parsed = cloneRivetStoredValue(
          JSON.parse(new TextDecoder().decode(change.serialized)),
          'Browser stored value',
        );
        this.#memory.set(change.id, parsed);
        this.#memoryDeleted.delete(change.id);
      } else {
        this.#memory.delete(change.id);
        this.#memoryDeleted.add(change.id);
      }
    }

    const revision = this.#nextRevision();
    try {
      let committedRevision = revision;
      await this.#enqueueWrite(async () => {
        if (!this.#database) throw new Error('IndexedDB is unavailable.');
        committedRevision = await this.#commitPreparedChanges(prepared, revision);
      });
      this.#lastRevision = Math.max(this.#lastRevision, committedRevision);
      for (const change of prepared) {
        this.#memoryOnly.delete(change.id);
        this.#knownRevisions.set(change.id, committedRevision);
        this.#publishChange(change.namespace, change.key, committedRevision);
      }
      this.#status = this.#memoryOnly.size === 0 ? { durable: true } : { durable: false, reason: 'write-failed' };
      return {
        durable: true,
        ...(this.#memoryOnly.size > 0 ? { hasMemoryOnlyRecords: true } : {}),
        revision: committedRevision,
      };
    } catch (error) {
      for (const change of prepared) this.#memoryOnly.add(change.id);
      this.#status = { durable: false, reason: 'write-failed' };
      throw new WebAppBrowserStoragePersistenceError(
        'Browser data could not be saved. Changes will last only until this page is closed.',
        { cause: error, revision },
      );
    }
  }

  subscribe(listener: (change: WebAppBrowserStorageChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hasMemoryOnlyRecord(namespace: WebAppBrowserStorageNamespace, key: string): boolean {
    return this.#memoryOnly.has(this.#recordId(namespace, key));
  }

  async estimateUsage(): Promise<WebAppBrowserStorageEstimate> {
    if (!this.#storageManager) return {};
    try {
      const estimate = await this.#storageManager.estimate();
      return {
        ...(typeof estimate.quota === 'number' ? { quota: estimate.quota } : {}),
        ...(typeof estimate.usage === 'number' ? { usage: estimate.usage } : {}),
      };
    } catch {
      return {};
    }
  }

  dispose(): void {
    this.#channel?.close();
    globalThis.removeEventListener?.('focus', this.#focusListener);
    this.#channel = undefined;
    this.#database?.close();
    this.#database = undefined;
    this.#openPromise = undefined;
    this.#listeners.clear();
    this.#knownRevisions.clear();
    this.#memoryDeleted.clear();
    this.#memoryOnly.clear();
  }

  async getMigration(legacyKey: string): Promise<WebAppBrowserStorageMigration | undefined> {
    const scopeId = this.#requireScope();
    if (!this.#database) return undefined;
    const id = migrationId(scopeId, legacyKey);
    const transaction = this.#database.transaction(MIGRATIONS_STORE, 'readonly');
    const migration = await requestResult<StoredMigration | undefined>(
      transaction.objectStore(MIGRATIONS_STORE).get(id),
    );
    await transactionDone(transaction);
    if (!migration) return undefined;
    return {
      cleanupAfter: migration.cleanupAfter,
      completedAt: migration.completedAt,
      key: migration.key,
      legacyKey: migration.legacyKey,
      namespace: migration.namespace,
    };
  }

  async recordMigration(migration: WebAppBrowserStorageMigration): Promise<void> {
    const scopeId = this.#requireScope();
    if (!this.#database) throw new Error('IndexedDB is unavailable.');
    const transaction = this.#database.transaction(MIGRATIONS_STORE, 'readwrite');
    transaction.objectStore(MIGRATIONS_STORE).put({
      ...migration,
      id: migrationId(scopeId, migration.legacyKey),
      scopeId,
    } satisfies StoredMigration);
    await transactionDone(transaction);
  }

  async listMigrations(): Promise<WebAppBrowserStorageMigration[]> {
    const scopeId = this.#requireScope();
    if (!this.#database) return [];
    const transaction = this.#database.transaction(MIGRATIONS_STORE, 'readonly');
    const migrations = await requestResult<StoredMigration[]>(transaction.objectStore(MIGRATIONS_STORE).getAll());
    await transactionDone(transaction);
    return migrations
      .filter((migration) => migration.scopeId === scopeId)
      .map(({ cleanupAfter, completedAt, key, legacyKey, namespace }) => ({
        cleanupAfter,
        completedAt,
        key,
        legacyKey,
        namespace,
      }));
  }

  #recordId(namespace: WebAppBrowserStorageNamespace, key: string): string {
    const scopeId = this.#requireScope();
    if (!key) throw new Error('Browser storage key cannot be empty.');
    return `${scopeId}\u0000${namespace}\u0000${key}`;
  }

  #requireScope(): string {
    if (!this.#scopeId || !this.#scope) throw new Error('Browser storage must be initialized before use.');
    return this.#scopeId;
  }

  async #openDatabase(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    if (this.#openPromise) return await this.#openPromise;
    if (!this.#factory) throw new Error('IndexedDB is unavailable.');

    this.#openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory!.open(this.#databaseName, RIVET_WEB_APP_BROWSER_STORAGE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunks = database.createObjectStore(CHUNKS_STORE, {
            keyPath: ['recordId', 'generation', 'index'],
          });
          chunks.createIndex(RECORD_GENERATION_INDEX, ['recordId', 'generation']);
        }
        if (!database.objectStoreNames.contains(MIGRATIONS_STORE)) {
          database.createObjectStore(MIGRATIONS_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STAGING_STORE)) {
          database.createObjectStore(STAGING_STORE, { keyPath: 'id' });
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked by another page.'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
    try {
      return await this.#openPromise;
    } finally {
      this.#openPromise = undefined;
    }
  }

  async #ensureSchemaMetadata(): Promise<void> {
    if (!this.#database) return;
    const transaction = this.#database.transaction(METADATA_STORE, 'readwrite');
    transaction.objectStore(METADATA_STORE).put({
      id: SCHEMA_METADATA_ID,
      schemaVersion: RIVET_WEB_APP_BROWSER_STORAGE_SCHEMA_VERSION,
      updatedAt: this.#now(),
    });
    await transactionDone(transaction);
  }

  async #commitPreparedChanges(prepared: readonly PreparedChange[], revision: number): Promise<number> {
    const database = this.#database!;
    const generation = createGeneration();
    const staged = prepared.filter((change) => change.serialized != null);
    if (staged.length > 0) {
      const stageTransaction = database.transaction([CHUNKS_STORE, STAGING_STORE], 'readwrite');
      const chunksStore = stageTransaction.objectStore(CHUNKS_STORE);
      const stagingStore = stageTransaction.objectStore(STAGING_STORE);
      for (const change of staged) {
        const stagingId = `${change.id}\u0000${generation}`;
        stagingStore.put({
          createdAt: this.#now(),
          generation,
          id: stagingId,
          recordId: change.id,
        } satisfies StagingRecord);
        change.chunks.forEach((bytes, index) => {
          chunksStore.put({ bytes, generation, index, recordId: change.id } satisfies StoredChunk);
        });
      }
      await transactionDone(stageTransaction);

      const validationTransaction = database.transaction(CHUNKS_STORE, 'readonly');
      const index = validationTransaction.objectStore(CHUNKS_STORE).index(RECORD_GENERATION_INDEX);
      for (const change of staged) {
        const chunks = await requestResult<StoredChunk[]>(index.getAll(IDBKeyRange.only([change.id, generation])));
        decodeChunks(
          {
            byteLength: change.serialized!.byteLength,
            chunkCount: change.chunks.length,
            generation,
            id: change.id,
            key: change.key,
            namespace: change.namespace,
            revision,
            scopeId: this.#scopeId!,
            updatedAt: this.#now(),
          },
          chunks,
        );
      }
      await transactionDone(validationTransaction);
    }

    const switchTransaction = database.transaction([METADATA_STORE, STAGING_STORE], 'readwrite');
    const metadataStore = switchTransaction.objectStore(METADATA_STORE);
    const stagingStore = switchTransaction.objectStore(STAGING_STORE);
    const previous: StoredRecordMetadata[] = [];
    const priorRecords: StoredRecordMetadata[] = [];
    for (const change of prepared) {
      const prior = await requestResult<StoredRecordMetadata | undefined>(metadataStore.get(change.id));
      if (prior) {
        priorRecords.push(prior);
        if (!prior.deleted) previous.push(prior);
      }
    }
    const committedRevision = Math.max(revision, ...priorRecords.map((prior) => prior.revision + 1));
    for (const change of prepared) {
      const base = {
        byteLength: change.serialized?.byteLength ?? 0,
        chunkCount: change.serialized?.byteLength == null ? 0 : change.chunks.length,
        deleted: change.serialized == null,
        generation,
        id: change.id,
        key: change.key,
        namespace: change.namespace,
        revision: committedRevision,
        scopeId: this.#scopeId!,
        updatedAt: this.#now(),
      } satisfies StoredRecordMetadata;
      metadataStore.put(base);
      if (change.serialized) stagingStore.delete(`${change.id}\u0000${generation}`);
    }
    await transactionDone(switchTransaction);

    void Promise.all(previous.map((metadata) => this.#deleteGeneration(metadata.id, metadata.generation))).catch(
      () => undefined,
    );
    return committedRevision;
  }

  async #deleteGeneration(recordId: string, generation: string): Promise<void> {
    if (!this.#database) return;
    const transaction = this.#database.transaction(CHUNKS_STORE, 'readwrite');
    const index = transaction.objectStore(CHUNKS_STORE).index(RECORD_GENERATION_INDEX);
    const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(IDBKeyRange.only([recordId, generation])));
    const store = transaction.objectStore(CHUNKS_STORE);
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  }

  async #removeAbandonedStaging(): Promise<void> {
    if (!this.#database) return;
    const transaction = this.#database.transaction(STAGING_STORE, 'readwrite');
    const staging = await requestResult<StagingRecord[]>(transaction.objectStore(STAGING_STORE).getAll());
    const store = transaction.objectStore(STAGING_STORE);
    const abandoned = staging.filter((record) => this.#now() - record.createdAt >= 5 * 60 * 1000);
    for (const record of abandoned) store.delete(record.id);
    await transactionDone(transaction);
    await Promise.all(abandoned.map((record) => this.#deleteGeneration(record.recordId, record.generation)));
  }

  #ensureBroadcastChannel(): void {
    if (this.#channel || !this.#broadcastChannelFactory) return;
    try {
      this.#channel = this.#broadcastChannelFactory(BROADCAST_CHANNEL_NAME);
      this.#channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = parseBroadcastMessage(event.data);
        if (!message || message.sourceId === this.#instanceId || message.scopeId !== this.#scopeId) return;
        void this.#enqueueWrite(async () => {
          const id = this.#recordId(message.namespace, message.key);
          // Keep a failed local write visible in this tab until it can be saved.
          // A remote durable revision must not erase the current live state.
          if (this.#memoryOnly.has(id)) return;
          const knownRevision = this.#knownRevisions.get(id);
          if (knownRevision !== undefined && message.revision <= knownRevision) return;
          this.#memory.delete(id);
          this.#memoryDeleted.delete(id);
          this.#knownRevisions.set(id, message.revision);
          const change = { key: message.key, namespace: message.namespace, revision: message.revision };
          for (const listener of this.#listeners) listener(change);
        });
      };
    } catch {
      this.#channel = undefined;
    }
  }

  #publishChange(namespace: WebAppBrowserStorageNamespace, key: string, revision: number): void {
    const change = { key, namespace, revision };
    try {
      this.#channel?.postMessage({
        ...change,
        scopeId: this.#scopeId!,
        sourceId: this.#instanceId,
        type: 'record-changed',
      } satisfies BroadcastMessage);
    } catch {
      // Cross-tab invalidation is best effort; durable state is already committed.
    }
  }

  async #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.#writeQueue.catch(() => undefined).then(operation);
    this.#writeQueue = result.catch(() => undefined);
    await result;
  }
  #nextRevision(): number {
    this.#lastRevision = Math.max(this.#lastRevision + 1, this.#now());
    return this.#lastRevision;
  }

  async #recheckRevisions(): Promise<void> {
    if (!this.#database || !this.#scopeId) return;
    await this.#enqueueWrite(async () => {
      if (!this.#database || !this.#scopeId) return;
      const transaction = this.#database.transaction(METADATA_STORE, 'readonly');
      const records = (await requestResult<unknown[]>(transaction.objectStore(METADATA_STORE).getAll())).filter(
        isStoredRecordMetadata,
      );
      await transactionDone(transaction);
      for (const metadata of records) {
        if (metadata.scopeId !== this.#scopeId) continue;
        // Focus-time rechecks follow the same rule as BroadcastChannel updates.
        if (this.#memoryOnly.has(metadata.id)) continue;
        const knownRevision = this.#knownRevisions.get(metadata.id);
        if (knownRevision !== undefined && metadata.revision <= knownRevision) continue;
        this.#memory.delete(metadata.id);
        this.#memoryDeleted.delete(metadata.id);
        this.#knownRevisions.set(metadata.id, metadata.revision);
        const change = {
          key: metadata.key,
          namespace: metadata.namespace,
          revision: metadata.revision,
        };
        for (const listener of this.#listeners) listener(change);
      }
    }).catch(() => undefined);
  }
}

export class WebAppBrowserStoragePersistenceError extends Error {
  readonly revision: number;

  constructor(message: string, options: ErrorOptions & { revision: number }) {
    super(message, options);
    this.name = 'WebAppBrowserStoragePersistenceError';
    this.revision = options.revision;
  }
}

function prepareChange(id: string, change: WebAppBrowserStorageBatchChange): PreparedChange {
  if (!change.key) throw new Error('Browser storage key cannot be empty.');
  if (change.value === undefined) {
    return { chunks: [], id, key: change.key, namespace: change.namespace };
  }
  const portable = cloneRivetStoredValue(change.value, 'Browser stored value');
  const serialized = new TextEncoder().encode(JSON.stringify(portable));
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < serialized.byteLength; offset += RIVET_WEB_APP_BROWSER_STORAGE_CHUNK_BYTES) {
    const chunk = serialized.slice(
      offset,
      Math.min(serialized.byteLength, offset + RIVET_WEB_APP_BROWSER_STORAGE_CHUNK_BYTES),
    );
    chunks.push(chunk.buffer as ArrayBuffer);
  }
  if (chunks.length === 0) chunks.push(new ArrayBuffer(0));
  return { chunks, id, key: change.key, namespace: change.namespace, serialized };
}

function decodeChunks(metadata: StoredRecordMetadata, chunks: StoredChunk[]): RivetStoredValue {
  if (chunks.length !== metadata.chunkCount) throw new Error('Browser storage record is incomplete.');
  chunks.sort((left, right) => left.index - right.index);
  const bytes = new Uint8Array(metadata.byteLength);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (chunk.index !== index) throw new Error('Browser storage record has invalid chunk ordering.');
    const source = new Uint8Array(chunk.bytes);
    if (offset + source.byteLength > bytes.byteLength) throw new Error('Browser storage record exceeds its metadata.');
    bytes.set(source, offset);
    offset += source.byteLength;
  }
  if (offset !== metadata.byteLength)
    throw new Error('Browser storage record byte length does not match its metadata.');
  return cloneRivetStoredValue(JSON.parse(new TextDecoder().decode(bytes)), 'Browser stored value');
}

function isStoredRecordMetadata(value: unknown): value is StoredRecordMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Partial<StoredRecordMetadata>;
  return (
    typeof metadata.id === 'string' &&
    metadata.id !== SCHEMA_METADATA_ID &&
    typeof metadata.scopeId === 'string' &&
    typeof metadata.key === 'string' &&
    (metadata.namespace === 'chat-state' ||
      metadata.namespace === 'response-traces' ||
      metadata.namespace === 'stored-values') &&
    typeof metadata.revision === 'number' &&
    typeof metadata.generation === 'string' &&
    typeof metadata.byteLength === 'number' &&
    typeof metadata.chunkCount === 'number'
  );
}

function normalizeScope(scope: WebAppBrowserStorageScope): WebAppBrowserStorageScope {
  if (!scope.origin) throw new Error('Browser storage origin cannot be empty.');
  if (!scope.uiGraphId) throw new Error('Browser storage UI graph id cannot be empty.');
  const pathname = scope.pathname.replace(/\/+$/, '') || '/';
  return { origin: scope.origin, pathname, uiGraphId: scope.uiGraphId };
}

function serializeScope(scope: WebAppBrowserStorageScope): string {
  return [
    encodeURIComponent(scope.origin),
    encodeURIComponent(scope.pathname),
    encodeURIComponent(scope.uiGraphId),
  ].join(':');
}

function migrationId(scopeId: string, legacyKey: string): string {
  return `${scopeId}\u0000${legacyKey}`;
}

function createGeneration(): string {
  return globalThis.crypto?.randomUUID?.() ?? `rivet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getDefaultIndexedDbFactory(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? globalThis.window?.indexedDB;
  } catch {
    return undefined;
  }
}

function getDefaultStorageManager(): Pick<StorageManager, 'estimate'> | undefined {
  try {
    return globalThis.navigator?.storage;
  } catch {
    return undefined;
  }
}

function getDefaultBroadcastChannelFactory(): ((name: string) => BroadcastChannel) | undefined {
  try {
    return typeof globalThis.BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : undefined;
  } catch {
    return undefined;
  }
}

function parseBroadcastMessage(value: unknown): BroadcastMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Partial<BroadcastMessage>;
  return message.type === 'record-changed' &&
    typeof message.scopeId === 'string' &&
    typeof message.sourceId === 'string' &&
    typeof message.key === 'string' &&
    (message.namespace === 'chat-state' ||
      message.namespace === 'response-traces' ||
      message.namespace === 'stored-values') &&
    Number.isSafeInteger(message.revision) &&
    Number(message.revision) > 0
    ? (message as BroadcastMessage)
    : undefined;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}
