import {
  assertEvaluationDatasetSnapshot,
  assertEvaluationRecordingArtifact,
  createEmptyEvaluationLibrary,
  fingerprintEvaluationDataset,
  normalizeEvaluationRun,
  normalizeEvaluationLibrary,
  reconcileEvaluationRunSnapshots,
  type EvaluationDatasetSnapshot,
  type EvaluationLibrary,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
  type EvaluationStore,
} from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { IndexedDBStorage } from '../state/storage/indexedDB.js';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

const PREFIX = 'rivet-evaluation-runs:';
const RECORDING_PREFIX = 'rivet-evaluation-recordings:';
const RECORDING_ARTIFACT_PREFIX = 'rivet-evaluation-recording:';
const DATASET_SNAPSHOT_PREFIX = 'rivet-evaluation-dataset-snapshots:';
const LIBRARY_KEY = 'rivet-evaluation-library:v1';
const LEGACY_LIBRARY_KEY = 'evaluation-library';
const DATABASE_NAME = 'rivet_evaluation_history';
const DATABASE_STORE = 'values';
const MAX_RUNS_PER_PROJECT = 100;

type EvaluationRecordingManifest = {
  version: 1;
  recordingIds: string[];
};

interface EvaluationRunDatabase extends DBSchema {
  values: {
    key: string;
    value: string;
  };
}

export type EvaluationStoreEntry = { key: string; value: string };

export type EvaluationKeyValueBackend = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  entries?(): Promise<readonly EvaluationStoreEntry[]>;
};

type LegacyEvaluationLibraryStorage = Pick<IndexedDBStorage, 'getItem'>;

function isEvaluationLibraryEnvelope(value: unknown): value is EvaluationLibrary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<EvaluationLibrary>;
  return (
    candidate.version === 1 &&
    typeof candidate.data === 'object' &&
    candidate.data !== null &&
    !Array.isArray(candidate.data) &&
    Array.isArray(candidate.datasets) &&
    Array.isArray(candidate.migratedLegacyProjectIds)
  );
}

function openEvaluationRunDatabase(onUnavailable: () => void): Promise<IDBPDatabase<EvaluationRunDatabase>> {
  let database: IDBPDatabase<EvaluationRunDatabase> | undefined;
  return openDB<EvaluationRunDatabase>(DATABASE_NAME, 1, {
    upgrade(upgradeDatabase) {
      if (!upgradeDatabase.objectStoreNames.contains(DATABASE_STORE)) {
        upgradeDatabase.createObjectStore(DATABASE_STORE);
      }
    },
    blocking() {
      database?.close();
      onUnavailable();
    },
    terminated() {
      onUnavailable();
    },
  }).then((openedDatabase) => {
    database = openedDatabase;
    return openedDatabase;
  });
}

/**
 * Browser-backed complete evaluation store and reusable key/value-backed store
 * implementation for native adapters. It is intentionally outside project
 * files and is replaced wholesale when a hosted editor supplies its own store.
 */
export class LocalEvaluationRunStore implements EvaluationStore {
  readonly #pendingProjectOperations = new Map<ProjectId, Promise<void>>();
  readonly #getDatabase = createRecoverableIndexedDbConnection(openEvaluationRunDatabase);
  readonly #migratedLegacyKeys = new Set<string>();
  readonly #backend?: EvaluationKeyValueBackend;
  readonly #legacyLibraryStorage: LegacyEvaluationLibraryStorage;
  readonly #storageLabel: string;
  #legacyLibraryReadError?: unknown;
  #storageBackend: 'unknown' | 'indexeddb' | 'legacy' = 'unknown';
  #initializePromise?: Promise<void>;
  #libraryWrite = Promise.resolve();

  constructor(
    options: {
      backend?: EvaluationKeyValueBackend;
      legacyLibraryStorage?: LegacyEvaluationLibraryStorage;
      storageLabel?: string;
    } = {},
  ) {
    this.#backend = options.backend;
    this.#legacyLibraryStorage = options.legacyLibraryStorage ?? new IndexedDBStorage();
    this.#storageLabel = options.storageLabel ?? 'application storage';
  }

  async initialize(): Promise<void> {
    this.#initializePromise ??= this.migrateLegacyLibrary();
    await this.#initializePromise;
  }

  async getLibrary(): Promise<EvaluationLibrary> {
    await this.initialize();
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(LIBRARY_KEY);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read the evaluation library`, error);
    }
    if (serialized === null) return createEmptyEvaluationLibrary();
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isEvaluationLibraryEnvelope(parsed)) throw new Error('The stored library envelope is invalid.');
      return normalizeEvaluationLibrary(parsed);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation library`, error);
    }
  }

  async putLibrary(library: EvaluationLibrary): Promise<void> {
    await this.initialize();
    const serialized = JSON.stringify(normalizeEvaluationLibrary(library));
    const write = this.#libraryWrite
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.writeSerialized(LIBRARY_KEY, serialized);
        } catch (error) {
          throw this.storageError(`The ${this.#storageLabel} could not retain the evaluation library`, error);
        }
      });
    this.#libraryWrite = write;
    await write;
  }

  /** Raw, lossless migration payload used only when the desktop store adopts browser-era data. */
  async exportEntries(options: { requireIndexedDb?: boolean } = {}): Promise<readonly EvaluationStoreEntry[]> {
    await this.initialize();
    if (options.requireIndexedDb && this.#legacyLibraryReadError !== undefined) {
      throw this.storageError(
        'Desktop evaluation migration could not verify the legacy evaluation library',
        this.#legacyLibraryReadError,
      );
    }
    if (this.#backend?.entries) {
      return (await this.#backend.entries()).filter((entry) => this.isEvaluationStorageKey(entry.key));
    }

    const entries = new Map<string, string>();
    const database = await this.database();
    if (options.requireIndexedDb && typeof indexedDB !== 'undefined' && !database) {
      throw new Error('Desktop evaluation migration requires access to the existing IndexedDB database.');
    }
    if (database) {
      const transaction = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readonly'));
      const [keys, values] = await Promise.all([transaction.store.getAllKeys(), transaction.store.getAll()]);
      keys.forEach((key, index) => entries.set(String(key), values[index]!));
    }
    for (const entry of this.legacyStorageEntries()) {
      if (!entries.has(entry.key)) entries.set(entry.key, entry.value);
    }
    return [...entries].map(([key, value]) => ({ key, value }));
  }

  async put(run: EvaluationRun): Promise<void> {
    const normalized = normalizeEvaluationRun(run);
    await this.queueProjectOperation(normalized.projectId, async () => {
      const storedRecordings = await this.readRecordings(normalized.projectId);
      const recordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      const protectedRunIds = new Set(
        recordings.filter((artifact) => artifact.reference.retention !== 'temporary').map((artifact) => artifact.runId),
      );
      const prunedRunIds = await this.putSerialized(normalized, protectedRunIds);
      if (prunedRunIds.length > 0 || recordings.length !== storedRecordings.length) {
        await this.writeRecordings(
          normalized.projectId,
          storedRecordings,
          recordings.filter((artifact) => !prunedRunIds.includes(artifact.runId)),
        );
      }
    });
  }

  async updateRunName(input: {
    projectId: ProjectId;
    runId: string;
    name?: string;
  }): Promise<EvaluationRun | undefined> {
    let renamed: EvaluationRun | undefined;
    await this.queueProjectOperation(input.projectId, async () => {
      const runs = await this.readRuns(input.projectId);
      const index = runs.findIndex((candidate) => candidate.id === input.runId);
      if (index === -1) return;
      renamed = normalizeEvaluationRun({ ...runs[index]!, name: input.name });
      await this.write(
        input.projectId,
        runs.map((candidate, candidateIndex) => (candidateIndex === index ? renamed! : candidate)),
      );
    });
    return renamed ? structuredClone(renamed) : undefined;
  }

  async get(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined> {
    return (await this.list({ projectId: input.projectId })).find((candidate) => candidate.id === input.runId);
  }

  async list(input: { projectId: ProjectId; suiteId?: string }): Promise<readonly EvaluationRun[]> {
    await this.queueProjectOperation(input.projectId, async () => {
      const storedRecordings = await this.readRecordings(input.projectId);
      const activeRecordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      if (activeRecordings.length !== storedRecordings.length) {
        await this.writeRecordings(input.projectId, storedRecordings, activeRecordings);
      }
    });
    return (await this.readRuns(input.projectId))
      .filter((candidate) => input.suiteId == null || candidate.suiteId === input.suiteId)
      .map((candidate) => structuredClone(candidate));
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueProjectOperation(input.projectId, async () => {
      await this.write(
        input.projectId,
        (await this.readRuns(input.projectId)).filter((candidate) => candidate.id !== input.runId),
      );
      const recordings = await this.readRecordings(input.projectId);
      await this.writeRecordings(
        input.projectId,
        recordings,
        recordings.filter((artifact) => artifact.runId !== input.runId),
      );
    });
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    await this.queueProjectOperation(snapshot.projectId, async () => {
      const snapshots = await this.readDatasetSnapshots(snapshot.projectId);
      if (snapshots[snapshot.fingerprint] !== undefined) return;
      snapshots[snapshot.fingerprint] = structuredClone(snapshot);
      await this.writeDatasetSnapshots(snapshot.projectId, snapshots);
    });
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    // Join an in-flight snapshot write for this project before returning a
    // historical dataset. This is also harmless when there is no write.
    await this.queueProjectOperation(input.projectId, () => undefined);
    const snapshot = (await this.readDatasetSnapshots(input.projectId))[input.fingerprint];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    assertEvaluationRecordingArtifact(artifact);
    await this.queueProjectOperation(artifact.projectId, async () => {
      const recordingIds = await this.readRecordingIds(artifact.projectId);
      const existing = await this.readRecordingArtifact(artifact.projectId, artifact.reference.id);
      if (existing && (existing.runId !== artifact.runId || existing.trialId !== artifact.trialId)) {
        throw new Error('An evaluation recording ID cannot be reassigned to another run or trial.');
      }
      const next = structuredClone(artifact);
      if (existing) next.reference = structuredClone(existing.reference);
      try {
        await this.writeSerialized(
          this.recordingArtifactKey(artifact.projectId, artifact.reference.id),
          JSON.stringify(next),
        );
        await this.writeRecordingManifest(artifact.projectId, [...recordingIds, artifact.reference.id]);
      } catch (error) {
        throw this.storageError(`The ${this.#storageLabel} could not retain evaluation recordings`, error);
      }
    });
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    let found: EvaluationRecordingArtifact | undefined;
    await this.queueProjectOperation(input.projectId, async () => {
      const recordingIds = await this.readRecordingIds(input.projectId);
      if (!recordingIds.includes(input.recordingId)) return;
      const artifact = await this.readRecordingArtifact(input.projectId, input.recordingId);
      if (artifact && !this.isExpired(artifact, Date.now())) {
        found = artifact;
        return;
      }
      await this.writeRecordingManifest(
        input.projectId,
        recordingIds.filter((recordingId) => recordingId !== input.recordingId),
      );
      await this.deleteSerialized(this.recordingArtifactKey(input.projectId, input.recordingId));
    });
    return found ? structuredClone(found) : undefined;
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<void> {
    await this.queueProjectOperation(input.projectId, async () => {
      const artifact = await this.readRecordingArtifact(input.projectId, input.recordingId);
      if (!artifact) return;
      const updated: EvaluationRecordingArtifact = {
        ...artifact,
        reference: {
          id: artifact.reference.id,
          retention: input.retention,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
      };
      try {
        await this.writeSerialized(
          this.recordingArtifactKey(input.projectId, input.recordingId),
          JSON.stringify(updated),
        );
      } catch (error) {
        throw this.storageError(`The ${this.#storageLabel} could not retain evaluation recordings`, error);
      }
    });
  }

  async promoteBaseline(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueProjectOperation(input.projectId, async () => {
      const recordings = await this.readRecordings(input.projectId);
      await this.writeRecordings(
        input.projectId,
        recordings,
        recordings.map((artifact) =>
          artifact.runId !== input.runId
            ? artifact
            : {
                ...artifact,
                reference: { id: artifact.reference.id, retention: 'baseline' },
              },
        ),
      );
    });
  }

  private key(projectId: ProjectId): string {
    return `${PREFIX}${projectId}`;
  }
  private recordingKey(projectId: ProjectId): string {
    return `${RECORDING_PREFIX}${projectId}`;
  }
  private recordingArtifactKey(projectId: ProjectId, recordingId: string): string {
    return `${RECORDING_ARTIFACT_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(recordingId)}`;
  }
  private datasetSnapshotKey(projectId: ProjectId): string {
    return `${DATASET_SNAPSHOT_PREFIX}${projectId}`;
  }
  private async putSerialized(run: EvaluationRun, protectedRunIds: ReadonlySet<string>): Promise<string[]> {
    const runs = await this.readRuns(run.projectId);
    const existing = runs.find((candidate) => candidate.id === run.id);
    const nextRun = reconcileEvaluationRunSnapshots(existing, run);
    if (nextRun === existing) return [];
    const ordered = [nextRun, ...runs.filter((candidate) => candidate.id !== run.id)];
    let unprotectedCount = 0;
    const next = ordered.filter((candidate) => {
      if (protectedRunIds.has(candidate.id)) return true;
      unprotectedCount += 1;
      return unprotectedCount <= MAX_RUNS_PER_PROJECT;
    });
    await this.write(run.projectId, next);
    const kept = new Set(next.map((candidate) => candidate.id));
    return runs.filter((candidate) => !kept.has(candidate.id)).map((candidate) => candidate.id);
  }

  private legacyStorage(): Storage | undefined {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
      return undefined;
    }
  }

  private legacyStorageEntries(): EvaluationStoreEntry[] {
    const storage = this.legacyStorage();
    if (!storage) return [];
    const entries: EvaluationStoreEntry[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null || !this.isEvaluationStorageKey(key)) continue;
        const value = storage.getItem(key);
        if (value !== null) entries.push({ key, value });
      }
    } catch {
      // A privacy-restricted shell may expose localStorage but reject iteration.
    }
    return entries;
  }

  private isEvaluationStorageKey(key: string): boolean {
    return (
      key === LIBRARY_KEY ||
      key.startsWith(PREFIX) ||
      key.startsWith(RECORDING_PREFIX) ||
      key.startsWith(RECORDING_ARTIFACT_PREFIX) ||
      key.startsWith(DATASET_SNAPSHOT_PREFIX)
    );
  }

  private async migrateLegacyLibrary(): Promise<void> {
    if ((await this.readSerialized(LIBRARY_KEY)) !== null) return;

    let legacy: string | null = null;
    if (this.#backend === undefined && typeof indexedDB !== 'undefined') {
      try {
        legacy = await this.#legacyLibraryStorage.getItem(LEGACY_LIBRARY_KEY);
      } catch (error) {
        this.#legacyLibraryReadError = error;
        // The old Jotai database may not exist or may be blocked. The fallback
        // below still handles very old localStorage-only installations.
      }
    }
    if (legacy === null && this.#backend === undefined) {
      try {
        legacy = this.legacyStorage()?.getItem(LEGACY_LIBRARY_KEY) ?? null;
      } catch {
        // Keep an empty library when browser storage is unavailable.
      }
    }
    if (legacy === null) return;

    // A readable localStorage copy is sufficient evidence even when the old
    // Jotai database is temporarily unavailable.
    this.#legacyLibraryReadError = undefined;

    try {
      const parsed: unknown = JSON.parse(legacy);
      const candidate =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'library' in parsed
          ? (parsed as { library?: unknown }).library
          : parsed;
      if (!isEvaluationLibraryEnvelope(candidate)) return;
      await this.writeSerialized(LIBRARY_KEY, JSON.stringify(normalizeEvaluationLibrary(candidate)));
    } catch {
      // Corrupt legacy data must not prevent Rivet from opening. The old copy
      // is left untouched for diagnosis and the new store starts empty.
    }
  }

  /**
   * A few browser shells expose `indexedDB` but reject opening it. Use the
   * legacy store only when that happens before this instance has successfully
   * used IndexedDB; switching backends after a successful write could make an
   * older IndexedDB record hide newer fallback data.
   */
  private async database(): Promise<IDBPDatabase<EvaluationRunDatabase> | undefined> {
    if (this.#storageBackend === 'legacy') return undefined;
    if (typeof indexedDB === 'undefined') {
      if (this.#storageBackend === 'indexeddb') throw new Error('IndexedDB is no longer available.');
      this.#storageBackend = 'legacy';
      return undefined;
    }

    try {
      const database = await this.#getDatabase();
      this.#storageBackend = 'indexeddb';
      return database;
    } catch (error) {
      if (this.#storageBackend === 'unknown' && this.legacyStorage()) {
        this.#storageBackend = 'legacy';
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Evaluation results can contain full target and evaluator outputs, which
   * are much larger than browser localStorage's practical quota. IndexedDB is
   * the durable application-local store; localStorage is read once only to
   * migrate history created by older Rivet versions or to support runtimes
   * that genuinely lack IndexedDB.
   */
  private async readSerialized(key: string): Promise<string | null> {
    if (this.#backend) return this.#backend.get(key);
    const database = await this.database();
    if (!database) return this.legacyStorage()?.getItem(key) ?? null;

    const transaction = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readonly'));
    const stored = (await transaction.store.get(key)) ?? null;
    if (stored !== null || this.#migratedLegacyKeys.has(key)) return stored;

    const legacy = this.legacyStorage()?.getItem(key) ?? null;
    if (legacy === null) {
      this.#migratedLegacyKeys.add(key);
      return null;
    }

    try {
      const migration = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readwrite'));
      await migration.store.put(legacy, key);
      await migration.done;
    } catch {
      // Reading old history must not depend on having enough IndexedDB space to
      // copy it. Leave the source intact and retry migration later.
      return legacy;
    }
    this.#migratedLegacyKeys.add(key);
    // Do not keep a second full copy in quota-limited localStorage. A completed
    // IndexedDB transaction means the migrated record survives this removal.
    try {
      this.legacyStorage()?.removeItem(key);
    } catch {
      // Leaving the old copy behind is harmless; IndexedDB stays authoritative.
    }
    return legacy;
  }

  private async writeSerialized(key: string, value: string): Promise<void> {
    if (this.#backend) {
      await this.#backend.set(key, value);
      return;
    }
    const database = await this.database();
    if (!database) {
      const storage = this.legacyStorage();
      if (!storage) throw new Error(`${this.#storageLabel} is unavailable`);
      storage.setItem(key, value);
      return;
    }

    const transaction = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readwrite'));
    await transaction.store.put(value, key);
    await transaction.done;
    this.#migratedLegacyKeys.add(key);
    try {
      this.legacyStorage()?.removeItem(key);
    } catch {
      // IndexedDB is already durable. A stale legacy copy cannot override it.
    }
  }

  private async deleteSerialized(key: string): Promise<void> {
    if (this.#backend) {
      await this.#backend.delete(key);
      return;
    }
    const database = await this.database();
    if (!database) {
      this.legacyStorage()?.removeItem(key);
      return;
    }

    const transaction = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readwrite'));
    await transaction.store.delete(key);
    await transaction.done;
    this.#migratedLegacyKeys.add(key);
    try {
      this.legacyStorage()?.removeItem(key);
    } catch {
      // IndexedDB no longer references the artifact. A fallback copy can be
      // ignored because this store never switches backends after first use.
    }
  }

  private storageError(message: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(detail ? `${message}: ${detail}` : message);
  }

  private async write(projectId: ProjectId, runs: readonly EvaluationRun[]): Promise<void> {
    try {
      await this.writeSerialized(this.key(projectId), JSON.stringify(runs));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not retain this evaluation run`, error);
    }
  }

  private async readRuns(projectId: ProjectId): Promise<EvaluationRun[]> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.key(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation run history`, error);
    }
    if (serialized === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains unreadable evaluation run history`, error);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation run-history envelope.`);
    }
    try {
      return parsed.map((candidate) => {
        if (!this.isRunForProject(candidate, projectId)) {
          throw new Error('A stored run does not belong to its project-scoped history record.');
        }
        return normalizeEvaluationRun(candidate);
      });
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains invalid evaluation run history`, error);
    }
  }
  private isRunForProject(value: unknown, projectId: ProjectId): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { projectId?: unknown; id?: unknown }).projectId === projectId &&
      typeof (value as { id?: unknown }).id === 'string'
    );
  }

  private async readRecordings(projectId: ProjectId): Promise<EvaluationRecordingArtifact[]> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.recordingKey(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation recordings`, error);
    }
    if (serialized === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains unreadable evaluation recordings`, error);
    }
    if (Array.isArray(parsed)) {
      const legacyRecordings = parsed.filter((value): value is EvaluationRecordingArtifact =>
        this.isRecordingForProject(value, projectId),
      );
      if (legacyRecordings.length !== parsed.length) {
        throw new Error(`The ${this.#storageLabel} contains invalid legacy evaluation recordings.`);
      }
      await this.writeRecordings(projectId, [], legacyRecordings);
      return legacyRecordings;
    }
    if (!this.isRecordingManifest(parsed)) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation recording manifest.`);
    }

    let recordings: EvaluationRecordingArtifact[];
    try {
      recordings = (
        await Promise.all(parsed.recordingIds.map((recordingId) => this.readRecordingArtifact(projectId, recordingId)))
      ).filter((artifact): artifact is EvaluationRecordingArtifact => artifact !== undefined);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation recordings`, error);
    }
    if (recordings.length !== parsed.recordingIds.length) {
      await this.writeRecordingManifest(
        projectId,
        recordings.map((artifact) => artifact.reference.id),
      );
    }
    return recordings;
  }

  private async readRecordingIds(projectId: ProjectId): Promise<string[]> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.recordingKey(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation recordings`, error);
    }
    if (serialized === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains unreadable evaluation recordings`, error);
    }
    if (this.isRecordingManifest(parsed)) return [...new Set(parsed.recordingIds)];
    // The old format is an aggregate artifact array. The full reader validates
    // and migrates it once; subsequent operations read only the small manifest.
    if (Array.isArray(parsed)) return (await this.readRecordings(projectId)).map((artifact) => artifact.reference.id);
    throw new Error(`The ${this.#storageLabel} contains an invalid evaluation recording manifest.`);
  }

  private async readRecordingArtifact(
    projectId: ProjectId,
    recordingId: string,
  ): Promise<EvaluationRecordingArtifact | undefined> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.recordingArtifactKey(projectId, recordingId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation recordings`, error);
    }
    if (serialized === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation recording`, error);
    }
    if (!this.isRecordingForProject(parsed, projectId) || parsed.reference.id !== recordingId) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation recording artifact.`);
    }
    return parsed;
  }

  private async writeRecordings(
    projectId: ProjectId,
    previous: readonly EvaluationRecordingArtifact[],
    recordings: readonly EvaluationRecordingArtifact[],
  ): Promise<void> {
    try {
      const previousById = new Map(previous.map((artifact) => [artifact.reference.id, artifact] as const));
      const nextById = new Map(recordings.map((artifact) => [artifact.reference.id, artifact] as const));
      for (const artifact of recordings) {
        const prior = previousById.get(artifact.reference.id);
        if (prior === artifact) continue;
        await this.writeSerialized(
          this.recordingArtifactKey(projectId, artifact.reference.id),
          JSON.stringify(artifact),
        );
      }
      // The manifest is the commit point. New artifacts written before it are
      // harmless orphans after an interrupted write; removed artifacts stay
      // reachable until this update commits.
      await this.writeRecordingManifest(projectId, [...nextById.keys()]);
      for (const recordingId of previousById.keys()) {
        if (!nextById.has(recordingId)) await this.deleteSerialized(this.recordingArtifactKey(projectId, recordingId));
      }
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not retain evaluation recordings`, error);
    }
  }

  private async writeRecordingManifest(projectId: ProjectId, recordingIds: readonly string[]): Promise<void> {
    const manifest: EvaluationRecordingManifest = { version: 1, recordingIds: [...new Set(recordingIds)] };
    await this.writeSerialized(this.recordingKey(projectId), JSON.stringify(manifest));
  }

  private isRecordingManifest(value: unknown): value is EvaluationRecordingManifest {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Partial<EvaluationRecordingManifest>).version === 1 &&
      Array.isArray((value as Partial<EvaluationRecordingManifest>).recordingIds) &&
      (value as EvaluationRecordingManifest).recordingIds.every((id) => typeof id === 'string')
    );
  }

  private isRecordingForProject(value: unknown, projectId: ProjectId): value is EvaluationRecordingArtifact {
    try {
      assertEvaluationRecordingArtifact(value);
      return value.projectId === projectId;
    } catch {
      return false;
    }
  }

  private async readDatasetSnapshots(projectId: ProjectId): Promise<Record<string, EvaluationDatasetSnapshot>> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.datasetSnapshotKey(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation dataset snapshots`, error);
    }
    if (serialized === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains unreadable evaluation dataset snapshots`, error);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation dataset-snapshot envelope.`);
    }
    const entries = Object.entries(parsed);
    if (entries.some(([fingerprint, value]) => !this.isDatasetSnapshotForProject(value, projectId, fingerprint))) {
      throw new Error(`The ${this.#storageLabel} contains invalid evaluation dataset snapshots.`);
    }
    return Object.fromEntries(entries) as Record<string, EvaluationDatasetSnapshot>;
  }

  private async writeDatasetSnapshots(
    projectId: ProjectId,
    snapshots: Readonly<Record<string, EvaluationDatasetSnapshot>>,
  ): Promise<void> {
    try {
      await this.writeSerialized(this.datasetSnapshotKey(projectId), JSON.stringify(snapshots));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not retain this evaluation dataset snapshot`, error);
    }
  }

  private isDatasetSnapshotForProject(
    value: unknown,
    projectId: ProjectId,
    fingerprint: string,
  ): value is EvaluationDatasetSnapshot {
    if (typeof value !== 'object' || value === null) return false;
    const snapshot = value as Partial<EvaluationDatasetSnapshot>;
    if (
      !(
        snapshot.projectId === projectId &&
        snapshot.fingerprint === fingerprint &&
        typeof snapshot.createdAt === 'string' &&
        typeof snapshot.dataset === 'object' &&
        snapshot.dataset !== null &&
        snapshot.dataset.projectId === projectId
      )
    )
      return false;
    try {
      return fingerprintEvaluationDataset(snapshot.dataset) === fingerprint;
    } catch {
      return false;
    }
  }

  private isExpired(artifact: EvaluationRecordingArtifact, now: number): boolean {
    return (
      artifact.reference.retention === 'temporary' &&
      artifact.reference.expiresAt != null &&
      Date.parse(artifact.reference.expiresAt) <= now
    );
  }

  private async queueProjectOperation(projectId: ProjectId, operation: () => void | Promise<void>): Promise<void> {
    const previous = this.#pendingProjectOperations.get(projectId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(operation);
    this.#pendingProjectOperations.set(projectId, write);
    try {
      await write;
    } finally {
      if (this.#pendingProjectOperations.get(projectId) === write) this.#pendingProjectOperations.delete(projectId);
    }
  }
}
