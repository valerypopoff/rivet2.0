import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { writeJsonSettingsFile } from '../settings-file-writer.js';

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

export class VersionedSettingsRepository<T> {
  readonly #cache = new Map<string, SettingsSnapshot<T>>();
  readonly #errors = new Map<string, unknown>();
  readonly #fileSignatures = new Map<string, string>();
  readonly #listeners = new Set<(snapshot: SettingsSnapshot<T>) => void>();
  readonly #operationQueues = new Map<string, Promise<unknown>>();

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
      return initialized ?? this.#refreshNow(settingsPath);
    });
  }

  async refresh(): Promise<SettingsSnapshot<T>> {
    const settingsPath = this.descriptor.getPath();
    return this.#enqueueOperation(settingsPath, () => this.#refreshNow(settingsPath));
  }

  async refreshIfChanged(): Promise<void> {
    const settingsPath = this.descriptor.getPath();
    await this.#enqueueOperation(settingsPath, async () => {
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
      return;
    }

    this.#cache.clear();
    this.#errors.clear();
    this.#fileSignatures.clear();
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
      listener(snapshot);
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

export async function initializeAppSettingsRepositories(): Promise<void> {
  await Promise.all([...repositories].map((repository) => repository.initialize()));
  if (!settingsPollTimer) {
    settingsPollTimer = setInterval(() => {
      for (const repository of repositories) {
        void repository.refreshIfChanged().catch((error) => {
          console.error(`[app-settings] Failed to refresh ${repository.descriptor.key} settings:`, error);
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
