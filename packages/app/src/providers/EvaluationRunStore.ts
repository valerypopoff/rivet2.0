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
  type EvaluationRunEvent,
  type EvaluationStore,
} from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { IndexedDBStorage } from '../state/storage/indexedDB.js';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

const PREFIX = 'rivet-evaluation-runs:';
const RUN_INDEX_PREFIX = 'rivet-evaluation-run-index:v2:';
const RUN_ARTIFACT_PREFIX = 'rivet-evaluation-run:v2:';
const RECORDING_PREFIX = 'rivet-evaluation-recordings:';
const RECORDING_ARTIFACT_PREFIX = 'rivet-evaluation-recording:';
const DATASET_SNAPSHOT_PREFIX = 'rivet-evaluation-dataset-snapshots:';
const DATASET_SNAPSHOT_ARTIFACT_PREFIX = 'rivet-evaluation-dataset-snapshot:v2:';
const LIBRARY_KEY = 'rivet-evaluation-library:v1';
const LEGACY_LIBRARY_KEY = 'evaluation-library';
const DATABASE_NAME = 'rivet_evaluation_history';
const DATABASE_STORE = 'values';
const MAX_RUNS_PER_PROJECT = 100;

type EvaluationRecordingManifest = {
  version: 1;
  recordingIds: string[];
};

type EvaluationRunIndex = {
  version: 2;
  runIds: string[];
};

type RevisionedEvaluationLibrary = {
  version: 2;
  revision: number;
  library: EvaluationLibrary;
};

interface EvaluationRunDatabase extends DBSchema {
  values: {
    key: string;
    value: string;
  };
}

export type EvaluationStoreEntry = { key: string; value: string };

export type EvaluationStoreBatchCheck = { key: string; expected: string | null };
export type EvaluationStoreBatchMutation =
  | { type: 'set'; key: string; value: string }
  | { type: 'delete'; key: string };

export type EvaluationKeyValueBackend = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  entries?(): Promise<readonly EvaluationStoreEntry[]>;
  /** Applies all mutations only when every expected value still matches. */
  applyBatch?(input: {
    checks: readonly EvaluationStoreBatchCheck[];
    mutations: readonly EvaluationStoreBatchMutation[];
  }): Promise<boolean>;
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
  #observedLibrarySerialized: string | null | undefined;

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
    if (serialized === null) {
      this.#observedLibrarySerialized = null;
      return createEmptyEvaluationLibrary();
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      const library = this.isRevisionedLibrary(parsed) ? parsed.library : parsed;
      if (!isEvaluationLibraryEnvelope(library)) throw new Error('The stored library envelope is invalid.');
      this.#observedLibrarySerialized = serialized;
      return normalizeEvaluationLibrary(library);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation library`, error);
    }
  }

  async putLibrary(library: EvaluationLibrary): Promise<void> {
    await this.initialize();
    const write = this.#libraryWrite
      .catch(() => undefined)
      .then(async () => {
        try {
          const currentSerialized = await this.readSerialized(LIBRARY_KEY);
          if (this.#observedLibrarySerialized !== undefined && currentSerialized !== this.#observedLibrarySerialized) {
            throw new Error('The evaluation library changed in another window. Reload before saving your changes.');
          }
          const currentRevision = this.parseLibraryRevision(currentSerialized);
          const serialized = JSON.stringify({
            version: 2,
            revision: currentRevision + 1,
            library: normalizeEvaluationLibrary(library),
          } satisfies RevisionedEvaluationLibrary);
          const committed = await this.applyBatch(
            [{ key: LIBRARY_KEY, expected: currentSerialized }],
            [{ type: 'set', key: LIBRARY_KEY, value: serialized }],
          );
          if (!committed) {
            throw new Error('The evaluation library changed in another window. Reload before saving your changes.');
          }
          this.#observedLibrarySerialized = serialized;
        } catch (error) {
          throw this.storageError(`The ${this.#storageLabel} could not retain the evaluation library`, error);
        }
      });
    this.#libraryWrite = write;
    await write;
  }

  private isRevisionedLibrary(value: unknown): value is RevisionedEvaluationLibrary {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Partial<RevisionedEvaluationLibrary>).version === 2 &&
      Number.isInteger((value as Partial<RevisionedEvaluationLibrary>).revision) &&
      (value as Partial<RevisionedEvaluationLibrary>).library !== undefined
    );
  }

  private parseLibraryRevision(serialized: string | null): number {
    if (serialized === null) return 0;
    try {
      const parsed: unknown = JSON.parse(serialized);
      return this.isRevisionedLibrary(parsed) ? parsed.revision : 0;
    } catch {
      return 0;
    }
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
    try {
      await this.queueProjectOperation(normalized.projectId, async () => {
        const storedRecordings = await this.readRecordings(normalized.projectId);
        const recordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
        const protectedRunIds = new Set(
          recordings
            .filter((artifact) => artifact.reference.retention !== 'temporary')
            .map((artifact) => artifact.runId),
        );
        const prunedRunIds = await this.putRunRecord(normalized, protectedRunIds);
        if (prunedRunIds.length > 0 || recordings.length !== storedRecordings.length) {
          await this.writeRecordings(
            normalized.projectId,
            storedRecordings,
            recordings.filter((artifact) => !prunedRunIds.includes(artifact.runId)),
          );
        }
      });
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not retain this evaluation run`, error);
    }
  }

  async updateRunName(input: {
    projectId: ProjectId;
    runId: string;
    name?: string;
  }): Promise<EvaluationRun | undefined> {
    let renamed: EvaluationRun | undefined;
    await this.queueProjectOperation(input.projectId, async () => {
      renamed = await this.updateRunRecord(input.projectId, input.runId, (run) =>
        normalizeEvaluationRun({ ...run, name: input.name }),
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
      await this.deleteRunRecord(input.projectId, input.runId);
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
      const key = this.datasetSnapshotArtifactKey(snapshot.projectId, snapshot.fingerprint);
      const existingSerialized = await this.readSerialized(key);
      if (existingSerialized !== null) {
        this.parseDatasetSnapshot(existingSerialized, snapshot.projectId, snapshot.fingerprint);
        return;
      }

      const legacy = await this.readLegacyDatasetSnapshot(snapshot.projectId, snapshot.fingerprint);
      const value = legacy ?? structuredClone(snapshot);
      const committed = await this.applyBatch(
        [{ key, expected: null }],
        [{ type: 'set', key, value: JSON.stringify(value) }],
      );
      if (!committed) {
        const concurrent = await this.readSerialized(key);
        if (concurrent === null) throw new Error('The evaluation dataset snapshot changed concurrently.');
        this.parseDatasetSnapshot(concurrent, snapshot.projectId, snapshot.fingerprint);
      }
    });
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    await this.queueProjectOperation(input.projectId, () => undefined);
    const key = this.datasetSnapshotArtifactKey(input.projectId, input.fingerprint);
    const serialized = await this.readSerialized(key);
    if (serialized !== null) {
      return structuredClone(this.parseDatasetSnapshot(serialized, input.projectId, input.fingerprint));
    }

    const legacy = await this.readLegacyDatasetSnapshot(input.projectId, input.fingerprint);
    if (!legacy) return undefined;
    const committed = await this.applyBatch(
      [{ key, expected: null }],
      [{ type: 'set', key, value: JSON.stringify(legacy) }],
    );
    if (committed) return structuredClone(legacy);
    const concurrent = await this.readSerialized(key);
    if (concurrent === null) throw new Error('The evaluation dataset snapshot changed concurrently.');
    return structuredClone(this.parseDatasetSnapshot(concurrent, input.projectId, input.fingerprint));
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    assertEvaluationRecordingArtifact(artifact);
    await this.queueProjectOperation(artifact.projectId, async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const manifestKey = this.recordingKey(artifact.projectId);
        const { serialized: manifestSerialized, recordingIds } = await this.readRecordingManifestState(
          artifact.projectId,
        );
        const artifactKey = this.recordingArtifactKey(artifact.projectId, artifact.reference.id);
        const existingSerialized = await this.readSerialized(artifactKey);
        const existing =
          existingSerialized === null
            ? undefined
            : this.parseRecordingArtifact(existingSerialized, artifact.projectId, artifact.reference.id);
        if (existing && (existing.runId !== artifact.runId || existing.trialId !== artifact.trialId)) {
          throw new Error('An evaluation recording ID cannot be reassigned to another run or trial.');
        }
        const next = structuredClone(artifact);
        if (existing) next.reference = structuredClone(existing.reference);
        const manifest: EvaluationRecordingManifest = {
          version: 1,
          recordingIds: [...new Set([...recordingIds, artifact.reference.id])],
        };
        const committed = await this.applyBatch(
          [
            { key: manifestKey, expected: manifestSerialized },
            { key: artifactKey, expected: existingSerialized },
          ],
          [
            { type: 'set', key: artifactKey, value: JSON.stringify(next) },
            { type: 'set', key: manifestKey, value: JSON.stringify(manifest) },
          ],
        );
        if (committed) return;
      }
      throw new Error('Evaluation recordings changed concurrently; retry the operation.');
    });
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    let found: EvaluationRecordingArtifact | undefined;
    await this.queueProjectOperation(input.projectId, async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { serialized: manifestSerialized, recordingIds } = await this.readRecordingManifestState(input.projectId);
        if (!recordingIds.includes(input.recordingId)) return;
        const artifactKey = this.recordingArtifactKey(input.projectId, input.recordingId);
        const artifactSerialized = await this.readSerialized(artifactKey);
        const artifact =
          artifactSerialized === null
            ? undefined
            : this.parseRecordingArtifact(artifactSerialized, input.projectId, input.recordingId);
        if (artifact && !this.isExpired(artifact, Date.now())) {
          found = artifact;
          return;
        }
        const manifest: EvaluationRecordingManifest = {
          version: 1,
          recordingIds: recordingIds.filter((recordingId) => recordingId !== input.recordingId),
        };
        if (
          await this.applyBatch(
            [
              { key: this.recordingKey(input.projectId), expected: manifestSerialized },
              { key: artifactKey, expected: artifactSerialized },
            ],
            [
              { type: 'set', key: this.recordingKey(input.projectId), value: JSON.stringify(manifest) },
              { type: 'delete', key: artifactKey },
            ],
          )
        ) {
          return;
        }
      }
      throw new Error('Evaluation recordings changed concurrently; retry the operation.');
    });
    return found ? structuredClone(found) : undefined;
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<boolean> {
    let updated = false;
    await this.queueProjectOperation(input.projectId, async () => {
      const key = this.recordingArtifactKey(input.projectId, input.recordingId);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const serialized = await this.readSerialized(key);
        if (serialized === null) return;
        const artifact = this.parseRecordingArtifact(serialized, input.projectId, input.recordingId);
        const next: EvaluationRecordingArtifact = {
          ...artifact,
          reference: {
            id: artifact.reference.id,
            retention: input.retention,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          },
        };
        if (
          await this.applyBatch([{ key, expected: serialized }], [{ type: 'set', key, value: JSON.stringify(next) }])
        ) {
          updated = true;
          return;
        }
      }
      throw new Error('Evaluation recording retention changed concurrently; retry the operation.');
    });
    return updated;
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

  async applyRunEvent(event: EvaluationRunEvent): Promise<void> {
    if (event.type === 'run-started' || event.type === 'run-finalized') {
      await this.put(event.run);
      return;
    }

    await this.queueProjectOperation(event.projectId, async () => {
      await this.updateRunRecord(event.projectId, event.runId, (existing) => {
        if ((existing.revision ?? 0) >= event.revision) return existing;
        const trialIndex = existing.trials.findIndex(
          (trial) => trial.caseId === event.trial.caseId && trial.trialIndex === event.trial.trialIndex,
        );
        const trials = [...existing.trials];
        if (trialIndex >= 0) trials[trialIndex] = event.trial;
        else trials.push(event.trial);
        trials.sort((left, right) => left.caseIndex - right.caseIndex || left.trialIndex - right.trialIndex);
        return normalizeEvaluationRun({
          ...existing,
          revision: event.revision,
          requestedTrialCount: event.requestedTrialCount,
          trials,
        });
      });
    });
  }

  private key(projectId: ProjectId): string {
    return `${PREFIX}${projectId}`;
  }
  private runIndexKey(projectId: ProjectId): string {
    return `${RUN_INDEX_PREFIX}${encodeURIComponent(projectId)}`;
  }
  private runArtifactKey(projectId: ProjectId, runId: string): string {
    return `${RUN_ARTIFACT_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}`;
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
  private datasetSnapshotArtifactKey(projectId: ProjectId, fingerprint: string): string {
    return `${DATASET_SNAPSHOT_ARTIFACT_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(fingerprint)}`;
  }

  private async putRunRecord(run: EvaluationRun, protectedRunIds: ReadonlySet<string>): Promise<string[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { serialized: indexSerialized, index } = await this.readRunIndex(run.projectId);
      const runKey = this.runArtifactKey(run.projectId, run.id);
      const existingSerialized = await this.readSerialized(runKey);
      const existing =
        existingSerialized === null ? undefined : this.parseRun(existingSerialized, run.projectId, run.id);
      const nextRun = reconcileEvaluationRunSnapshots(existing, run);
      if (nextRun === existing) return [];

      const orderedIds = [run.id, ...index.runIds.filter((runId) => runId !== run.id)];
      let unprotectedCount = 0;
      const nextRunIds = orderedIds.filter((runId) => {
        if (protectedRunIds.has(runId)) return true;
        unprotectedCount += 1;
        return unprotectedCount <= MAX_RUNS_PER_PROJECT;
      });
      const kept = new Set(nextRunIds);
      const prunedRunIds = index.runIds.filter((runId) => !kept.has(runId));
      const nextIndex: EvaluationRunIndex = { version: 2, runIds: nextRunIds };
      const committed = await this.applyBatch(
        [
          { key: this.runIndexKey(run.projectId), expected: indexSerialized },
          { key: runKey, expected: existingSerialized },
        ],
        [
          { type: 'set', key: runKey, value: JSON.stringify(nextRun) },
          { type: 'set', key: this.runIndexKey(run.projectId), value: JSON.stringify(nextIndex) },
          ...prunedRunIds.map(
            (runId): EvaluationStoreBatchMutation => ({
              type: 'delete',
              key: this.runArtifactKey(run.projectId, runId),
            }),
          ),
        ],
      );
      if (committed) return prunedRunIds;
    }
    throw new Error('Evaluation run history changed concurrently; retry the operation.');
  }

  private async updateRunRecord(
    projectId: ProjectId,
    runId: string,
    update: (run: EvaluationRun) => EvaluationRun,
  ): Promise<EvaluationRun | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { index } = await this.readRunIndex(projectId);
      if (!index.runIds.includes(runId)) return undefined;
      const runKey = this.runArtifactKey(projectId, runId);
      const existingSerialized = await this.readSerialized(runKey);
      if (existingSerialized === null) return undefined;
      const existing = this.parseRun(existingSerialized, projectId, runId);
      const updated = update(existing);
      if (updated === existing) return existing;
      const committed = await this.applyBatch(
        [{ key: runKey, expected: existingSerialized }],
        [{ type: 'set', key: runKey, value: JSON.stringify(updated) }],
      );
      if (committed) return updated;
    }
    throw new Error('Evaluation run changed concurrently; retry the operation.');
  }

  private async deleteRunRecord(projectId: ProjectId, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { serialized, index } = await this.readRunIndex(projectId);
      if (!index.runIds.includes(runId)) return;
      const nextIndex: EvaluationRunIndex = {
        version: 2,
        runIds: index.runIds.filter((candidate) => candidate !== runId),
      };
      const committed = await this.applyBatch(
        [{ key: this.runIndexKey(projectId), expected: serialized }],
        [
          { type: 'set', key: this.runIndexKey(projectId), value: JSON.stringify(nextIndex) },
          { type: 'delete', key: this.runArtifactKey(projectId, runId) },
        ],
      );
      if (committed) return;
    }
    throw new Error('Evaluation run history changed concurrently; retry the deletion.');
  }

  private async readRunIndex(projectId: ProjectId): Promise<{ serialized: string | null; index: EvaluationRunIndex }> {
    const key = this.runIndexKey(projectId);
    let serialized = await this.readSerialized(key);
    if (serialized === null) {
      serialized = await this.migrateLegacyRuns(projectId);
      if (serialized === null) return { serialized: null, index: { version: 2, runIds: [] } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation run index`, error);
    }
    if (!this.isRunIndex(parsed)) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation run index.`);
    }
    return { serialized, index: { version: 2, runIds: [...new Set(parsed.runIds)] } };
  }

  private async migrateLegacyRuns(projectId: ProjectId): Promise<string | null> {
    const legacySerialized = await this.readSerialized(this.key(projectId));
    if (legacySerialized === null) return null;
    const runs = this.parseLegacyRuns(legacySerialized, projectId);
    const index: EvaluationRunIndex = { version: 2, runIds: runs.map((run) => run.id) };
    const serializedIndex = JSON.stringify(index);
    const committed = await this.applyBatch(
      [{ key: this.runIndexKey(projectId), expected: null }],
      [
        ...runs.map(
          (run): EvaluationStoreBatchMutation => ({
            type: 'set',
            key: this.runArtifactKey(projectId, run.id),
            value: JSON.stringify(run),
          }),
        ),
        { type: 'set', key: this.runIndexKey(projectId), value: serializedIndex },
      ],
    );
    return committed ? serializedIndex : this.readSerialized(this.runIndexKey(projectId));
  }

  private isRunIndex(value: unknown): value is EvaluationRunIndex {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Partial<EvaluationRunIndex>).version === 2 &&
      Array.isArray((value as Partial<EvaluationRunIndex>).runIds) &&
      (value as EvaluationRunIndex).runIds.every((runId) => typeof runId === 'string')
    );
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
      key.startsWith(RUN_INDEX_PREFIX) ||
      key.startsWith(RUN_ARTIFACT_PREFIX) ||
      key.startsWith(RECORDING_PREFIX) ||
      key.startsWith(RECORDING_ARTIFACT_PREFIX) ||
      key.startsWith(DATASET_SNAPSHOT_PREFIX) ||
      key.startsWith(DATASET_SNAPSHOT_ARTIFACT_PREFIX)
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

  private async applyBatch(
    checks: readonly EvaluationStoreBatchCheck[],
    mutations: readonly EvaluationStoreBatchMutation[],
  ): Promise<boolean> {
    if (this.#backend?.applyBatch) return this.#backend.applyBatch({ checks, mutations });
    if (this.#backend) {
      for (const check of checks) {
        if ((await this.#backend.get(check.key)) !== check.expected) return false;
      }
      for (const mutation of mutations) {
        if (mutation.type === 'set') await this.#backend.set(mutation.key, mutation.value);
        else await this.#backend.delete(mutation.key);
      }
      return true;
    }

    const database = await this.database();
    if (!database) {
      const storage = this.legacyStorage();
      if (!storage) throw new Error(`${this.#storageLabel} is unavailable`);
      for (const check of checks) {
        if (storage.getItem(check.key) !== check.expected) return false;
      }
      for (const mutation of mutations) {
        if (mutation.type === 'set') storage.setItem(mutation.key, mutation.value);
        else storage.removeItem(mutation.key);
      }
      return true;
    }

    const transaction = preserveIndexedDbRequestTiming(database.transaction(DATABASE_STORE, 'readwrite'));
    for (const check of checks) {
      const actual = (await transaction.store.get(check.key)) ?? null;
      if (actual !== check.expected) {
        transaction.abort();
        try {
          await transaction.done;
        } catch {
          // An aborted compare-and-swap is an ordinary conflict.
        }
        return false;
      }
    }
    for (const mutation of mutations) {
      if (mutation.type === 'set') await transaction.store.put(mutation.value, mutation.key);
      else await transaction.store.delete(mutation.key);
    }
    await transaction.done;
    for (const mutation of mutations) this.#migratedLegacyKeys.add(mutation.key);
    return true;
  }

  private storageError(message: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(detail ? `${message}: ${detail}` : message);
  }

  private async readRuns(projectId: ProjectId): Promise<EvaluationRun[]> {
    try {
      const { index } = await this.readRunIndex(projectId);
      const runs = await Promise.all(
        index.runIds.map(async (runId) => {
          const serialized = await this.readSerialized(this.runArtifactKey(projectId, runId));
          if (serialized === null) {
            throw new Error(`The evaluation run index references missing run "${runId}".`);
          }
          return this.parseRun(serialized, projectId, runId);
        }),
      );
      return runs;
    } catch (error) {
      // V1 remains authoritative until a complete V2 index commit succeeds.
      // This makes a quota/disk failure during the one-way migration safely
      // retryable on the next read without hiding existing history.
      if ((await this.readSerialized(this.runIndexKey(projectId))) !== null) {
        throw this.storageError(`The ${this.#storageLabel} could not read evaluation run history`, error);
      }
      const legacySerialized = await this.readSerialized(this.key(projectId));
      if (legacySerialized !== null) return this.parseLegacyRuns(legacySerialized, projectId);
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation run history`, error);
    }
  }

  private parseLegacyRuns(serialized: string, projectId: ProjectId): EvaluationRun[] {
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
      return parsed.map((candidate: unknown) => {
        if (!this.isRunForProject(candidate, projectId)) {
          throw new Error('A stored run does not belong to its project-scoped history record.');
        }
        return normalizeEvaluationRun(candidate);
      });
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains invalid evaluation run history`, error);
    }
  }

  private parseRun(serialized: string, projectId: ProjectId, runId: string): EvaluationRun {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation run`, error);
    }
    if (!this.isRunForProject(parsed, projectId) || parsed.id !== runId) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation run record.`);
    }
    return normalizeEvaluationRun(parsed);
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
      const manifest: EvaluationRecordingManifest = {
        version: 1,
        recordingIds: recordings.map((artifact) => artifact.reference.id),
      };
      await this.applyBatch(
        [{ key: this.recordingKey(projectId), expected: serialized }],
        [{ type: 'set', key: this.recordingKey(projectId), value: JSON.stringify(manifest) }],
      );
    }
    return recordings;
  }

  private async readRecordingManifestState(
    projectId: ProjectId,
  ): Promise<{ serialized: string | null; recordingIds: string[] }> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.recordingKey(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation recordings`, error);
    }
    if (serialized === null) return { serialized, recordingIds: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains unreadable evaluation recordings`, error);
    }
    if (this.isRecordingManifest(parsed)) {
      return { serialized, recordingIds: [...new Set(parsed.recordingIds)] };
    }
    if (Array.isArray(parsed)) {
      await this.readRecordings(projectId);
      return this.readRecordingManifestState(projectId);
    }
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
    return this.parseRecordingArtifact(serialized, projectId, recordingId);
  }

  private parseRecordingArtifact(
    serialized: string,
    projectId: ProjectId,
    recordingId: string,
  ): EvaluationRecordingArtifact {
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
      const manifestKey = this.recordingKey(projectId);
      const manifestSerialized = await this.readSerialized(manifestKey);
      const checks: EvaluationStoreBatchCheck[] = [{ key: manifestKey, expected: manifestSerialized }];
      const mutations: EvaluationStoreBatchMutation[] = [];
      for (const artifact of recordings) {
        const prior = previousById.get(artifact.reference.id);
        if (prior === artifact) continue;
        const key = this.recordingArtifactKey(projectId, artifact.reference.id);
        checks.push({ key, expected: prior === undefined ? null : JSON.stringify(prior) });
        mutations.push({ type: 'set', key, value: JSON.stringify(artifact) });
      }
      for (const recordingId of previousById.keys()) {
        if (nextById.has(recordingId)) continue;
        const key = this.recordingArtifactKey(projectId, recordingId);
        checks.push({ key, expected: JSON.stringify(previousById.get(recordingId)) });
        mutations.push({ type: 'delete', key });
      }
      const manifest: EvaluationRecordingManifest = { version: 1, recordingIds: [...nextById.keys()] };
      mutations.push({ type: 'set', key: manifestKey, value: JSON.stringify(manifest) });
      if (!(await this.applyBatch(checks, mutations))) {
        throw new Error('Evaluation recordings changed concurrently; retry the operation.');
      }
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not retain evaluation recordings`, error);
    }
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

  private async readLegacyDatasetSnapshot(
    projectId: ProjectId,
    fingerprint: string,
  ): Promise<EvaluationDatasetSnapshot | undefined> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.datasetSnapshotKey(projectId));
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} could not read evaluation dataset snapshots`, error);
    }
    if (serialized === null) return undefined;
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
    const snapshot = Object.fromEntries(entries)[fingerprint];
    return snapshot as EvaluationDatasetSnapshot | undefined;
  }

  private parseDatasetSnapshot(
    serialized: string,
    projectId: ProjectId,
    fingerprint: string,
  ): EvaluationDatasetSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw this.storageError(`The ${this.#storageLabel} contains an unreadable evaluation dataset snapshot`, error);
    }
    if (!this.isDatasetSnapshotForProject(parsed, projectId, fingerprint)) {
      throw new Error(`The ${this.#storageLabel} contains an invalid evaluation dataset snapshot.`);
    }
    return parsed;
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
