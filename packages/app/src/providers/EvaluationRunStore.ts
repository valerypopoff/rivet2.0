import {
  assertEvaluationDatasetSnapshot,
  fingerprintEvaluationDataset,
  normalizeEvaluationRun,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
  type EvaluationRunStore,
} from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';

const PREFIX = 'rivet-evaluation-runs:';
const RECORDING_PREFIX = 'rivet-evaluation-recordings:';
const DATASET_SNAPSHOT_PREFIX = 'rivet-evaluation-dataset-snapshots:';
const MAX_RUNS_PER_PROJECT = 100;
const MAX_RECORDING_BYTES_PER_PROJECT = 20 * 1024 * 1024;

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

  async put(run: EvaluationRun): Promise<void> {
    await this.queueRunWrite(run.projectId, () => {
      const storedRecordings = this.readRecordings(run.projectId);
      const recordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      const protectedRunIds = new Set(
        recordings.filter((artifact) => artifact.reference.retention !== 'temporary').map((artifact) => artifact.runId),
      );
      const prunedRunIds = this.putSerialized(run, protectedRunIds);
      if (prunedRunIds.length > 0 || recordings.length !== storedRecordings.length) {
        if (
          !this.writeRecordings(
            run.projectId,
            recordings.filter((artifact) => !prunedRunIds.includes(artifact.runId)),
          )
        ) {
          throw new Error('The browser could not retain evaluation recordings.');
        }
      }
    });
  }

  async get(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined> {
    return (await this.list({ projectId: input.projectId })).find((candidate) => candidate.id === input.runId);
  }

  async list(input: { projectId: ProjectId; suiteId?: string }): Promise<readonly EvaluationRun[]> {
    await this.queueRunWrite(input.projectId, () => {
      const storedRecordings = this.readRecordings(input.projectId);
      const activeRecordings = storedRecordings.filter((artifact) => !this.isExpired(artifact, Date.now()));
      if (activeRecordings.length !== storedRecordings.length) this.writeRecordings(input.projectId, activeRecordings);
    });
    return this.readRuns(input.projectId)
      .filter((candidate) => input.suiteId == null || candidate.suiteId === input.suiteId)
      .map((candidate) => structuredClone(candidate));
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueRunWrite(input.projectId, () => {
      if (
        !this.write(
          input.projectId,
          this.readRuns(input.projectId).filter((candidate) => candidate.id !== input.runId),
        )
      ) {
        throw new Error('The browser could not update evaluation run history.');
      }
      if (
        !this.writeRecordings(
          input.projectId,
          this.readRecordings(input.projectId).filter((artifact) => artifact.runId !== input.runId),
        )
      ) {
        throw new Error('The browser could not update evaluation recordings.');
      }
    });
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    await this.queueRunWrite(snapshot.projectId, () => {
      const snapshots = this.readDatasetSnapshots(snapshot.projectId);
      if (snapshots[snapshot.fingerprint] !== undefined) return;
      snapshots[snapshot.fingerprint] = structuredClone(snapshot);
      if (!this.writeDatasetSnapshots(snapshot.projectId, snapshots)) {
        throw new Error('The browser could not retain this evaluation dataset snapshot.');
      }
    });
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    // Join an in-flight snapshot write for this project before returning a
    // historical dataset. This is also harmless when there is no write.
    await this.queueRunWrite(input.projectId, () => undefined);
    const snapshot = this.readDatasetSnapshots(input.projectId)[input.fingerprint];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    await this.queueRunWrite(artifact.projectId, () => {
      const now = Date.now();
      const stored = this.readRecordings(artifact.projectId);
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
      if (!this.writeRecordings(artifact.projectId, retained)) {
        throw new Error('The browser could not retain this evaluation recording.');
      }
    });
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    let found: EvaluationRecordingArtifact | undefined;
    await this.queueRunWrite(input.projectId, () => {
      const records = this.readRecordings(input.projectId);
      const active = records.filter((artifact) => !this.isExpired(artifact, Date.now()));
      if (active.length !== records.length) this.writeRecordings(input.projectId, active);
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
    await this.queueRunWrite(input.projectId, () => {
      if (
        !this.writeRecordings(
          input.projectId,
          this.readRecordings(input.projectId).map((artifact) => {
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
        )
      ) {
        throw new Error('The browser could not update evaluation recording retention.');
      }
    });
  }

  async promoteBaseline(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await this.queueRunWrite(input.projectId, () => {
      if (
        !this.writeRecordings(
          input.projectId,
          this.readRecordings(input.projectId).map((artifact) =>
            artifact.runId !== input.runId
              ? artifact
              : {
                  ...artifact,
                  reference: { id: artifact.reference.id, retention: 'baseline' },
                },
          ),
        )
      ) {
        throw new Error('The browser could not retain the evaluation baseline recording.');
      }
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
  private putSerialized(run: EvaluationRun, protectedRunIds: ReadonlySet<string>): string[] {
    const runs = this.readRuns(run.projectId);
    const existing = runs.find((candidate) => candidate.id === run.id);
    if ((existing?.revision ?? 0) > (run.revision ?? 0)) return [];
    const ordered = [run, ...runs.filter((candidate) => candidate.id !== run.id)];
    let unprotectedCount = 0;
    const next = ordered.filter((candidate) => {
      if (protectedRunIds.has(candidate.id)) return true;
      unprotectedCount += 1;
      return unprotectedCount <= MAX_RUNS_PER_PROJECT;
    });
    if (!this.write(run.projectId, next)) {
      throw new Error('The browser could not retain this evaluation run.');
    }
    const kept = new Set(next.map((candidate) => candidate.id));
    return runs.filter((candidate) => !kept.has(candidate.id)).map((candidate) => candidate.id);
  }
  private storage(): Storage | undefined {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  }
  private write(projectId: ProjectId, runs: readonly EvaluationRun[]): boolean {
    try {
      const storage = this.storage();
      if (!storage) return false;
      storage.setItem(this.key(projectId), JSON.stringify(runs));
      return true;
    } catch {
      return false;
    }
  }

  private readRuns(projectId: ProjectId): EvaluationRun[] {
    const storage = this.storage();
    if (!storage) return [];
    try {
      const parsed: unknown = JSON.parse(storage.getItem(this.key(projectId)) ?? '[]');
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

  private readRecordings(projectId: ProjectId): EvaluationRecordingArtifact[] {
    const storage = this.storage();
    if (!storage) return [];
    try {
      const parsed: unknown = JSON.parse(storage.getItem(this.recordingKey(projectId)) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((value): value is EvaluationRecordingArtifact =>
        this.isRecordingForProject(value, projectId),
      );
    } catch {
      return [];
    }
  }

  private writeRecordings(projectId: ProjectId, recordings: readonly EvaluationRecordingArtifact[]): boolean {
    try {
      const storage = this.storage();
      if (!storage) return false;
      storage.setItem(this.recordingKey(projectId), JSON.stringify(this.enforceRecordingBudget(recordings)));
      return true;
    } catch {
      return false;
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

  private readDatasetSnapshots(projectId: ProjectId): Record<string, EvaluationDatasetSnapshot> {
    const storage = this.storage();
    if (!storage) return {};
    try {
      const parsed: unknown = JSON.parse(storage.getItem(this.datasetSnapshotKey(projectId)) ?? '{}');
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

  private writeDatasetSnapshots(
    projectId: ProjectId,
    snapshots: Readonly<Record<string, EvaluationDatasetSnapshot>>,
  ): boolean {
    try {
      const storage = this.storage();
      if (!storage) return false;
      storage.setItem(this.datasetSnapshotKey(projectId), JSON.stringify(snapshots));
      return true;
    } catch {
      return false;
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
