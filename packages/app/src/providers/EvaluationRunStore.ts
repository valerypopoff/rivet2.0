import {
  assertEvaluationDatasetSnapshot,
  fingerprintEvaluationDataset,
  normalizeEvaluationRun,
  preserveEvaluationRunName,
  shouldReplaceEvaluationRun,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
  type EvaluationRunStore,
} from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createRecoverableIndexedDbConnection, preserveIndexedDbRequestTiming } from '../utils/indexedDb.js';

const PREFIX = 'rivet-evaluation-runs:';
const RECORDING_PREFIX = 'rivet-evaluation-recordings:';
const DATASET_SNAPSHOT_PREFIX = 'rivet-evaluation-dataset-snapshots:';
const DATABASE_NAME = 'rivet_evaluation_history';
const DATABASE_STORE = 'values';
const MAX_RUNS_PER_PROJECT = 100;
const MAX_RECORDING_BYTES_PER_PROJECT = 20 * 1024 * 1024;

interface EvaluationRunDatabase extends DBSchema {
  values: {
    key: string;
    value: string;
  };
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Durable browser/desktop default for evaluation history. It is intentionally
 * outside the project file and is replaced by Studio Server's shared store
 * when an editor is hosted there.
 */
export class LocalEvaluationRunStore implements EvaluationRunStore {
  readonly #pendingWrites = new Map<ProjectId, Promise<void>>();
  readonly #getDatabase = createRecoverableIndexedDbConnection(openEvaluationRunDatabase);
  readonly #migratedLegacyKeys = new Set<string>();
  #storageBackend: 'unknown' | 'indexeddb' | 'legacy' = 'unknown';

  async put(run: EvaluationRun): Promise<void> {
    const normalized = normalizeEvaluationRun(run);
    await this.queueRunWrite(normalized.projectId, async () => {
      const storedRecordings = await this.readRecordings(normalized.projectId);
      const recordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      const protectedRunIds = new Set(
        recordings.filter((artifact) => artifact.reference.retention !== 'temporary').map((artifact) => artifact.runId),
      );
      const prunedRunIds = await this.putSerialized(normalized, protectedRunIds);
      if (prunedRunIds.length > 0 || recordings.length !== storedRecordings.length) {
        await this.writeRecordings(
          normalized.projectId,
          recordings.filter((artifact) => !prunedRunIds.includes(artifact.runId)),
        );
      }
    });
  }

  async updateRunName(input: { projectId: ProjectId; runId: string; name?: string }): Promise<EvaluationRun | undefined> {
    let renamed: EvaluationRun | undefined;
    await this.queueRunWrite(input.projectId, async () => {
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
    await this.queueRunWrite(input.projectId, async () => {
      const storedRecordings = await this.readRecordings(input.projectId);
      const activeRecordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      if (activeRecordings.length !== storedRecordings.length) await this.writeRecordings(input.projectId, activeRecordings);
    });
    return (await this.readRuns(input.projectId))
      .filter((candidate) => input.suiteId == null || candidate.suiteId === input.suiteId)
      .map((candidate) => structuredClone(candidate));
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueRunWrite(input.projectId, async () => {
      await this.write(
        input.projectId,
        (await this.readRuns(input.projectId)).filter((candidate) => candidate.id !== input.runId),
      );
      await this.writeRecordings(
        input.projectId,
        (await this.readRecordings(input.projectId)).filter((artifact) => artifact.runId !== input.runId),
      );
    });
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    await this.queueRunWrite(snapshot.projectId, async () => {
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
    await this.queueRunWrite(input.projectId, () => undefined);
    const snapshot = (await this.readDatasetSnapshots(input.projectId))[input.fingerprint];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    await this.queueRunWrite(artifact.projectId, async () => {
      const now = Date.now();
      const stored = await this.readRecordings(artifact.projectId);
      const existing = stored.find((item) => item.reference.id === artifact.reference.id);
      if (existing && (existing.runId !== artifact.runId || existing.trialId !== artifact.trialId)) {
        throw new Error('An evaluation recording ID cannot be reassigned to another run or trial.');
      }
      const next = structuredClone(artifact);
      if (existing) next.reference = structuredClone(existing.reference);
      const records = stored
        .filter((item) => item.reference.id !== artifact.reference.id)
        .filter((item) => !this.isExpired(item, now));
      records.push(next);
      const retained = this.enforceRecordingBudget(records);
      if (!retained.some((candidate) => candidate.reference.id === artifact.reference.id)) {
        throw new Error('Evaluation recording exceeds the browser storage retention limit.');
      }
      await this.writeRecordings(artifact.projectId, retained);
    });
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    let found: EvaluationRecordingArtifact | undefined;
    await this.queueRunWrite(input.projectId, async () => {
      const records = await this.readRecordings(input.projectId);
      const active = records.filter((artifact) => !this.isExpired(artifact, Date.now()));
      if (active.length !== records.length) await this.writeRecordings(input.projectId, active);
      found = active.find((candidate) => candidate.reference.id === input.recordingId);
    });
    return found ? structuredClone(found) : undefined;
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<void> {
    await this.queueRunWrite(input.projectId, async () => {
      await this.writeRecordings(
        input.projectId,
        (await this.readRecordings(input.projectId)).map((artifact) => {
          if (artifact.reference.id !== input.recordingId) return artifact;
          return {
            ...artifact,
            reference: {
              id: artifact.reference.id,
              retention: input.retention,
              ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            },
          };
        }),
      );
    });
  }

  async promoteBaseline(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueRunWrite(input.projectId, async () => {
      await this.writeRecordings(
        input.projectId,
        (await this.readRecordings(input.projectId)).map((artifact) =>
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
  private datasetSnapshotKey(projectId: ProjectId): string {
    return `${DATASET_SNAPSHOT_PREFIX}${projectId}`;
  }
  private async putSerialized(run: EvaluationRun, protectedRunIds: ReadonlySet<string>): Promise<string[]> {
    const runs = await this.readRuns(run.projectId);
    const existing = runs.find((candidate) => candidate.id === run.id);
    const nextRun = preserveEvaluationRunName(existing, run);
    if (!shouldReplaceEvaluationRun(existing, nextRun)) return [];
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
    const database = await this.database();
    if (!database) {
      const storage = this.legacyStorage();
      if (!storage) throw new Error('browser storage is unavailable');
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

  private storageError(message: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(detail ? `${message}: ${detail}` : message);
  }

  private async write(projectId: ProjectId, runs: readonly EvaluationRun[]): Promise<void> {
    try {
      await this.writeSerialized(this.key(projectId), JSON.stringify(runs));
    } catch (error) {
      throw this.storageError('The browser could not retain this evaluation run', error);
    }
  }

  private async readRuns(projectId: ProjectId): Promise<EvaluationRun[]> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.key(projectId));
    } catch (error) {
      throw this.storageError('The browser could not read evaluation run history', error);
    }
    try {
      const parsed: unknown = JSON.parse(serialized ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((candidate) => {
        if (!this.isRunForProject(candidate, projectId)) return [];
        try {
          return [normalizeEvaluationRun(candidate)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
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
      throw this.storageError('The browser could not read evaluation recordings', error);
    }
    try {
      const parsed: unknown = JSON.parse(serialized ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((value): value is EvaluationRecordingArtifact =>
        this.isRecordingForProject(value, projectId),
      );
    } catch {
      return [];
    }
  }

  private async writeRecordings(projectId: ProjectId, recordings: readonly EvaluationRecordingArtifact[]): Promise<void> {
    try {
      await this.writeSerialized(this.recordingKey(projectId), JSON.stringify(this.enforceRecordingBudget(recordings)));
    } catch (error) {
      throw this.storageError('The browser could not retain evaluation recordings', error);
    }
  }

  private isRecordingForProject(value: unknown, projectId: ProjectId): value is EvaluationRecordingArtifact {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<EvaluationRecordingArtifact>;
    return (
      candidate.projectId === projectId &&
      typeof candidate.runId === 'string' &&
      typeof candidate.trialId === 'string' &&
      typeof candidate.serialized === 'string' &&
      typeof candidate.reference?.id === 'string'
    );
  }

  private async readDatasetSnapshots(projectId: ProjectId): Promise<Record<string, EvaluationDatasetSnapshot>> {
    let serialized: string | null;
    try {
      serialized = await this.readSerialized(this.datasetSnapshotKey(projectId));
    } catch (error) {
      throw this.storageError('The browser could not read evaluation dataset snapshots', error);
    }
    try {
      const parsed: unknown = JSON.parse(serialized ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([fingerprint, value]) =>
          this.isDatasetSnapshotForProject(value, projectId, fingerprint),
        ),
      );
    } catch {
      return {};
    }
  }

  private async writeDatasetSnapshots(
    projectId: ProjectId,
    snapshots: Readonly<Record<string, EvaluationDatasetSnapshot>>,
  ): Promise<void> {
    try {
      await this.writeSerialized(this.datasetSnapshotKey(projectId), JSON.stringify(snapshots));
    } catch (error) {
      throw this.storageError('The browser could not retain this evaluation dataset snapshot', error);
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

  private enforceRecordingBudget(recordings: readonly EvaluationRecordingArtifact[]): EvaluationRecordingArtifact[] {
    const retained = recordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
    const byteLengths = new Map(
      retained.map((artifact) => [artifact.reference.id, utf8ByteLength(artifact.serialized)] as const),
    );
    let bytes = Array.from(byteLengths.values()).reduce((total, size) => total + size, 0);
    const temporary = retained
      .filter((artifact) => artifact.reference.retention === 'temporary')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const evicted = new Set<string>();
    for (const artifact of temporary) {
      if (bytes <= MAX_RECORDING_BYTES_PER_PROJECT) break;
      bytes -= byteLengths.get(artifact.reference.id) ?? 0;
      evicted.add(artifact.reference.id);
    }
    return retained.filter((artifact) => !evicted.has(artifact.reference.id));
  }

  private async queueRunWrite(projectId: ProjectId, operation: () => void | Promise<void>): Promise<void> {
    const previous = this.#pendingWrites.get(projectId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(operation);
    this.#pendingWrites.set(projectId, write);
    try {
      await write;
    } finally {
      if (this.#pendingWrites.get(projectId) === write) this.#pendingWrites.delete(projectId);
    }
  }
}
