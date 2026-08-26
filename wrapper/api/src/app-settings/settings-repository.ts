import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { writeJsonSettingsFile } from '../settings-file-writer.js';
import {
  createPostgresAppSettingsBackendFromEnv,
  getManagedSettingsWriteRetryLimit,
  isPostgresAppSettingsBackendEnabled,
  type AppSettingsBackend,
  type ManagedSettingsRecord,
} from './managed-settings-store.js';

export type SettingsSnapshot<T> = {
  path: string;
  revision: string;
  value: Readonly<T>;
};

export type SettingsMigration = (stored: Record<string, unknown>) => Record<string, unknown>;

export type SettingsRepositoryDescriptor<T> = {
  key: string;
  currentVersion: number;
  getPath(): string;
  getDefault(): T;
  parseStored(stored: Record<string, unknown>): T;
  serialize(value: T): Record<string, unknown>;
  migrations?: Readonly<Record<number, SettingsMigration>>;
  mode?: number;
  recoverReadError?(error: unknown): T | undefined;
};

export class SettingsRevisionConflictError extends Error {
  readonly status = 409;
  readonly expose = true;

  constructor() {
    super('App settings changed in another session. Reload and try again.');
    this.name = 'SettingsRevisionConflictError';
  }
}

type SettingsRequestStore = Map<VersionedSettingsRepository<unknown>, SettingsSnapshot<unknown>>;

const repositories = new Set<VersionedSettingsRepository<unknown>>();
const requestSettingsStorage = new AsyncLocalStorage<SettingsRequestStore>();
let settingsPollTimer: NodeJS.Timeout | undefined;
let sharedBackend: AppSettingsBackend | null = null;
let sharedBackendInitialization: Promise<void> | null = null;
let unsubscribeSharedBackend: (() => void) | undefined;

function freezeValue<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) {
      return;
    }

    Object.freeze(item);
    for (const child of Object.values(item)) {
      freeze(child);
    }
  };

  freeze(clone);
  return clone;
}

function parseStoredObject(text: string, descriptor: SettingsRepositoryDescriptor<unknown>): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const label = `${descriptor.key.slice(0, 1).toUpperCase()}${descriptor.key.slice(1)}`;
    throw new TypeError(`${label} settings must be an object`);
  }

  let stored = parsed as Record<string, unknown>;
  const rawVersion = stored.version;
  const version = rawVersion == null ? 0 : rawVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new TypeError(`${descriptor.key} settings version must be a non-negative integer`);
  }

  if ((version as number) > descriptor.currentVersion) {
    throw new TypeError(
      `${descriptor.key} settings version ${version} is newer than supported version ${descriptor.currentVersion}`,
    );
  }

  let currentVersion = version as number;
  while (currentVersion < descriptor.currentVersion) {
    const migration = descriptor.migrations?.[currentVersion];
    if (migration) {
      stored = migration(stored);
    } else if (currentVersion !== 0) {
      throw new TypeError(`${descriptor.key} settings are missing a migration from version ${currentVersion}`);
    }
    currentVersion += 1;
  }

  return { ...stored, version: descriptor.currentVersion };
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function reportSettingsIssue(level: 'error' | 'warn', message: string, error?: unknown): void {
  try {
    if (error === undefined) console[level](message);
    else console[level](message, error);
  } catch {
    // Diagnostics must not change settings persistence or refresh outcomes.
  }
}

function getLegacySettingsPath(settingsPath: string): string | null {
  const legacyRoot = process.env.RIVET_APP_SETTINGS_LEGACY_ROOT?.trim();
  const appDataRoot = process.env.RIVET_APP_DATA_ROOT?.trim();
  if (!legacyRoot || !appDataRoot) {
    return null;
  }

  const relativePath = path.relative(path.resolve(appDataRoot), path.resolve(settingsPath));
  const segments = relativePath.split(path.sep);
  if (
    segments.length !== 2
    || segments[0] !== 'settings'
    || path.extname(segments[1] ?? '') !== '.json'
  ) {
    return null;
  }

  return path.join(path.resolve(legacyRoot), 'settings', segments[1]!);
}

export class VersionedSettingsRepository<T> {
  readonly #cache = new Map<string, SettingsSnapshot<T>>();
  readonly #errors = new Map<string, unknown>();
  readonly #fileSignatures = new Map<string, string>();
  readonly #listeners = new Set<(snapshot: SettingsSnapshot<T>) => void>();
  readonly #operationQueues = new Map<string, Promise<unknown>>();
  readonly #sharedRevisions = new Map<string, bigint>();

  constructor(readonly descriptor: SettingsRepositoryDescriptor<T>) {
    repositories.add(this as VersionedSettingsRepository<unknown>);
  }

  readSync(): SettingsSnapshot<T> {
    const requestSnapshot = requestSettingsStorage.getStore()?.get(this as VersionedSettingsRepository<unknown>);
    if (requestSnapshot) {
      return requestSnapshot as SettingsSnapshot<T>;
    }

    const settingsPath = this.descriptor.getPath();
    const cachedError = this.#errors.get(settingsPath);
    if (cachedError) {
      throw cachedError;
    }
    const cached = this.#cache.get(settingsPath);
    if (cached) {
      requestSettingsStorage.getStore()?.set(
        this as VersionedSettingsRepository<unknown>,
        cached as SettingsSnapshot<unknown>,
      );
      return cached;
    }

    if (sharedBackend) {
      throw new Error(
        `Managed app setting "${this.descriptor.key}" was read before repository initialization.`,
      );
    }

    return this.#loadSync(settingsPath);
  }

  async read(): Promise<SettingsSnapshot<T>> {
    const requestSnapshot = requestSettingsStorage.getStore()?.get(this as VersionedSettingsRepository<unknown>);
    if (requestSnapshot) {
      return requestSnapshot as SettingsSnapshot<T>;
    }

    return this.refresh();
  }

  async initialize(): Promise<SettingsSnapshot<T>> {
    const settingsPath = this.descriptor.getPath();
    const cached = this.#cache.get(settingsPath);
    if (cached) {
      return cached;
    }

    return this.#enqueueOperation(settingsPath, async () => {
      const initialized = this.#cache.get(settingsPath);
      if (initialized) {
        return initialized;
      }
      return sharedBackend
        ? this.#initializeManaged(settingsPath)
        : this.#refreshNow(settingsPath);
    });
  }

  async refresh(): Promise<SettingsSnapshot<T>> {
    const settingsPath = this.descriptor.getPath();
    return this.#enqueueOperation(settingsPath, () =>
      sharedBackend ? this.#refreshManagedNow(settingsPath) : this.#refreshNow(settingsPath));
  }

  async refreshIfChanged(): Promise<void> {
    const settingsPath = this.descriptor.getPath();
    await this.#enqueueOperation(settingsPath, async () => {
      if (sharedBackend) {
        await this.#refreshManagedNow(settingsPath);
        return;
      }

      const signature = await this.#readFileSignature(settingsPath);
      if (this.#fileSignatures.get(settingsPath) === signature) {
        return;
      }

      try {
        await this.#refreshNow(settingsPath);
      } catch (error) {
        this.#fileSignatures.set(settingsPath, signature);
        throw error;
      }
    });
  }

  async update(
    updateValue: (current: Readonly<T>) => T,
    expectedRevision?: string,
  ): Promise<SettingsSnapshot<T>> {
    const settingsPath = this.descriptor.getPath();
    return this.#enqueueOperation(settingsPath, async () => {
      if (sharedBackend) {
        return this.#updateManaged(settingsPath, updateValue, expectedRevision);
      }

      const current = await this.#refreshNow(settingsPath);
      if (expectedRevision && expectedRevision !== current.revision) {
        throw new SettingsRevisionConflictError();
      }
      const nextValue = updateValue(current.value);
      const serialized = {
        version: this.descriptor.currentVersion,
        ...this.descriptor.serialize(nextValue),
      };
      await writeJsonSettingsFile(settingsPath, serialized, this.descriptor.mode ?? 0o600);
      const snapshot = this.#remember(settingsPath, nextValue);
      this.#fileSignatures.set(settingsPath, await this.#readFileSignature(settingsPath));
      return snapshot;
    });
  }

  invalidate(settingsPath?: string): void {
    if (settingsPath) {
      this.#cache.delete(settingsPath);
      this.#errors.delete(settingsPath);
      this.#fileSignatures.delete(settingsPath);
      this.#sharedRevisions.delete(settingsPath);
      return;
    }

    this.#cache.clear();
    this.#errors.clear();
    this.#fileSignatures.clear();
    this.#sharedRevisions.clear();
  }

  subscribe(listener: (snapshot: SettingsSnapshot<T>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    repositories.delete(this as VersionedSettingsRepository<unknown>);
    this.#cache.clear();
    this.#errors.clear();
    this.#fileSignatures.clear();
    this.#sharedRevisions.clear();
    this.#listeners.clear();
    this.#operationQueues.clear();
  }

  #enqueueOperation<R>(settingsPath: string, operation: () => Promise<R>): Promise<R> {
    const previousOperation = this.#operationQueues.get(settingsPath) ?? Promise.resolve();
    const nextOperation = previousOperation.catch(() => undefined).then(operation);
    this.#operationQueues.set(settingsPath, nextOperation);

    return nextOperation.finally(() => {
      if (this.#operationQueues.get(settingsPath) === nextOperation) {
        this.#operationQueues.delete(settingsPath);
      }
    });
  }

  async #initializeManaged(settingsPath: string): Promise<SettingsSnapshot<T>> {
    const existing = await sharedBackend!.read(this.descriptor.key);
    if (existing) {
      return this.#rememberManaged(settingsPath, existing);
    }

    let initialValue: T | undefined;
    let sourceHash: string | null = null;
    const legacySettingsPath = getLegacySettingsPath(settingsPath);
    if (legacySettingsPath) {
      try {
        const legacyStat = await fsp.lstat(legacySettingsPath);
        if (legacyStat.isFile() && !legacyStat.isSymbolicLink()) {
          const sourceText = await fsp.readFile(legacySettingsPath, 'utf8');
          initialValue = this.#parse(sourceText);
          sourceHash = createHash('sha256').update(sourceText).digest('hex');
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          reportSettingsIssue(
            'warn',
            `[app-settings] Ignoring unusable legacy ${this.descriptor.key} settings and using the candidate bootstrap.`,
          );
        }
      }
    }

    if (initialValue === undefined) {
      try {
        const sourceText = await fsp.readFile(settingsPath, 'utf8');
        initialValue = this.#parse(sourceText);
        sourceHash = createHash('sha256').update(sourceText).digest('hex');
      } catch (error) {
        if (!isMissingFileError(error)) {
          const recovered = this.descriptor.recoverReadError?.(error);
          if (recovered === undefined) {
            throw error;
          }
          initialValue = recovered;
        } else {
          initialValue = this.descriptor.getDefault();
        }
      }
    }

    const serialized = {
      version: this.descriptor.currentVersion,
      ...this.descriptor.serialize(initialValue),
    };
    const inserted = await sharedBackend!.write({
      key: this.descriptor.key,
      expectedRevision: null,
      schemaVersion: this.descriptor.currentVersion,
      value: serialized,
      sourceHash,
    });
    return inserted
      ? this.#rememberManaged(settingsPath, inserted)
      : this.#refreshManagedNow(settingsPath);
  }

  async #refreshManagedNow(settingsPath: string): Promise<SettingsSnapshot<T>> {
    const record = await sharedBackend!.read(this.descriptor.key);
    if (!record) {
      return this.#initializeManaged(settingsPath);
    }
    return this.#rememberManaged(settingsPath, record);
  }

  async #updateManaged(
    settingsPath: string,
    updateValue: (current: Readonly<T>) => T,
    expectedRevision?: string,
  ): Promise<SettingsSnapshot<T>> {
    for (let attempt = 0; attempt < getManagedSettingsWriteRetryLimit(); attempt += 1) {
      const current = await this.#refreshManagedNow(settingsPath);
      if (expectedRevision && expectedRevision !== current.revision) {
        throw new SettingsRevisionConflictError();
      }

      const nextValue = updateValue(current.value);
      const serialized = {
        version: this.descriptor.currentVersion,
        ...this.descriptor.serialize(nextValue),
      };
      const persisted = await sharedBackend!.write({
        key: this.descriptor.key,
        expectedRevision: this.#sharedRevisions.get(settingsPath) ?? null,
        schemaVersion: this.descriptor.currentVersion,
        value: serialized,
      });
      if (persisted) {
        return this.#rememberManaged(settingsPath, persisted);
      }
      if (expectedRevision) {
        throw new SettingsRevisionConflictError();
      }
    }

    throw new SettingsRevisionConflictError();
  }

  #rememberManaged(settingsPath: string, record: ManagedSettingsRecord): SettingsSnapshot<T> {
    const parsed = this.descriptor.parseStored(
      parseStoredObject(JSON.stringify(record.value), this.descriptor as SettingsRepositoryDescriptor<unknown>),
    );
    this.#sharedRevisions.set(settingsPath, record.revision);
    return this.#remember(settingsPath, parsed);
  }

  async #refreshNow(settingsPath: string): Promise<SettingsSnapshot<T>> {
    try {
      const snapshot = this.#remember(settingsPath, this.#parse(await fsp.readFile(settingsPath, 'utf8')));
      this.#fileSignatures.set(settingsPath, await this.#readFileSignature(settingsPath));
      return snapshot;
    } catch (error) {
      return this.#handleReadError(settingsPath, error);
    }
  }

  #loadSync(settingsPath: string): SettingsSnapshot<T> {
    try {
      const snapshot = this.#remember(settingsPath, this.#parse(fs.readFileSync(settingsPath, 'utf8')));
      const stat = fs.statSync(settingsPath);
      this.#fileSignatures.set(settingsPath, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
      return snapshot;
    } catch (error) {
      return this.#handleReadError(settingsPath, error);
    }
  }

  #parse(text: string): T {
    const stored = parseStoredObject(text, this.descriptor as SettingsRepositoryDescriptor<unknown>);
    return this.descriptor.parseStored(stored);
  }

  #handleReadError(settingsPath: string, error: unknown): SettingsSnapshot<T> {
    if (isMissingFileError(error)) {
      this.#fileSignatures.set(settingsPath, 'missing');
      return this.#remember(settingsPath, this.descriptor.getDefault());
    }

    const recovered = this.descriptor.recoverReadError?.(error);
    if (recovered !== undefined) {
      this.#fileSignatures.set(settingsPath, 'invalid');
      return this.#remember(settingsPath, recovered);
    }

    this.#errors.set(settingsPath, error);
    throw error;
  }

  #remember(settingsPath: string, value: T): SettingsSnapshot<T> {
    const frozenValue = freezeValue(value);
    const revision = createHash('sha256')
      .update(JSON.stringify({
        version: this.descriptor.currentVersion,
        ...this.descriptor.serialize(frozenValue as T),
      }))
      .digest('base64url');
    const existing = this.#cache.get(settingsPath);
    if (existing?.revision === revision) {
      this.#errors.delete(settingsPath);
      requestSettingsStorage.getStore()?.set(
        this as VersionedSettingsRepository<unknown>,
        existing as SettingsSnapshot<unknown>,
      );
      return existing;
    }

    const snapshot = Object.freeze({ path: settingsPath, revision, value: frozenValue });
    this.#errors.delete(settingsPath);
    this.#cache.set(settingsPath, snapshot);
    requestSettingsStorage.getStore()?.set(
      this as VersionedSettingsRepository<unknown>,
      snapshot as SettingsSnapshot<unknown>,
    );
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        reportSettingsIssue('error', `[app-settings] ${this.descriptor.key} subscriber failed:`, error);
      }
    }
    return snapshot;
  }

  async #readFileSignature(settingsPath: string): Promise<string> {
    try {
      const stat = await fsp.stat(settingsPath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (isMissingFileError(error)) {
        return 'missing';
      }
      throw error;
    }
  }
}

function subscribeToSharedBackend(backend: AppSettingsBackend): void {
  unsubscribeSharedBackend?.();
  unsubscribeSharedBackend = backend.subscribe(async (key) => {
    const refreshes: Promise<unknown>[] = [];
    for (const repository of repositories) {
      if (repository.descriptor.key !== key) {
        continue;
      }
      refreshes.push(repository.refresh());
    }
    await Promise.all(refreshes);
  });
}
async function initializeSharedBackend(): Promise<void> {
  if (!isPostgresAppSettingsBackendEnabled() || sharedBackend) {
    return;
  }

  sharedBackendInitialization ??= (async () => {
    const backend = createPostgresAppSettingsBackendFromEnv();
    try {
      await backend.initialize();
      sharedBackend = backend;
      subscribeToSharedBackend(backend);
    } catch (error) {
      await backend.dispose().catch(() => undefined);
      throw error;
    }
  })();

  const initialization = sharedBackendInitialization;
  try {
    await initialization;
  } finally {
    if (sharedBackendInitialization === initialization) {
      sharedBackendInitialization = null;
    }
  }
}

export async function initializeAppSettingsRepositories(): Promise<void> {
  await initializeSharedBackend();
  await Promise.all([...repositories].map((repository) => repository.initialize()));
  if (!sharedBackend && !settingsPollTimer) {
    settingsPollTimer = setInterval(() => {
      for (const repository of repositories) {
        void repository.refreshIfChanged().catch((error) => {
          reportSettingsIssue(
            'error',
            `[app-settings] Failed to refresh ${repository.descriptor.key} settings:`,
            error,
          );
        });
      }
    }, 5_000);
    settingsPollTimer.unref?.();
  }
}

export function runWithAppSettingsSnapshot<T>(callback: () => T): T {
  const snapshots: SettingsRequestStore = new Map();
  for (const repository of repositories) {
    snapshots.set(repository, repository.readSync());
  }
  return requestSettingsStorage.run(snapshots, callback);
}

export function invalidateAppSettingsRepositories(): void {
  for (const repository of repositories) {
    repository.invalidate();
  }
}

export function getAppSettingsBackendKind(): 'file' | 'postgres' {
  return sharedBackend ? 'postgres' : 'file';
}

export async function configureAppSettingsBackendForTests(
  backend: AppSettingsBackend | null,
): Promise<void> {
  await disposeAppSettingsRepositories();
  sharedBackend = backend;
  if (backend) {
    await backend.initialize();
    subscribeToSharedBackend(backend);
  }
  for (const repository of repositories) {
    repository.invalidate();
  }
}

export async function disposeAppSettingsRepositories(): Promise<void> {
  if (settingsPollTimer) {
    clearInterval(settingsPollTimer);
    settingsPollTimer = undefined;
  }
  unsubscribeSharedBackend?.();
  unsubscribeSharedBackend = undefined;
  const initialization = sharedBackendInitialization;
  sharedBackendInitialization = null;
  await initialization?.catch(() => undefined);
  const backend = sharedBackend;
  sharedBackend = null;
  await backend?.dispose();
}
