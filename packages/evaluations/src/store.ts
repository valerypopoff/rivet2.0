import { assertEvaluationDatasetSnapshot } from './canonical.js';
import { normalizeEvaluationRun, preserveEvaluationRunName, shouldReplaceEvaluationRun } from './normalization.js';
import type {
  EvaluationDatasetSnapshot,
  EvaluationRecordingArtifact,
  EvaluationRun,
  EvaluationRunStore,
} from './types.js';

export class InMemoryEvaluationRunStore implements EvaluationRunStore {
  readonly #runs = new Map<string, EvaluationRun>();
  readonly #datasetSnapshots = new Map<string, EvaluationDatasetSnapshot>();
  readonly #recordings = new Map<string, EvaluationRecordingArtifact>();

  async put(run: EvaluationRun): Promise<void> {
    const normalized = normalizeEvaluationRun(run);
    const key = `${normalized.projectId}/${normalized.id}`;
    const existing = this.#runs.get(key);
    const next = preserveEvaluationRunName(existing, normalized);
    if (!shouldReplaceEvaluationRun(existing, next)) return;
    this.#runs.set(key, structuredClone(next));
  }

  async updateRunName(input: { projectId: string; runId: string; name?: string }): Promise<EvaluationRun | undefined> {
    const key = `${input.projectId}/${input.runId}`;
    const existing = this.#runs.get(key);
    if (!existing) return undefined;
    const renamed = normalizeEvaluationRun({ ...existing, name: input.name });
    this.#runs.set(key, structuredClone(renamed));
    return structuredClone(renamed);
  }

  async get(input: { projectId: string; runId: string }): Promise<EvaluationRun | undefined> {
    const run = this.#runs.get(`${input.projectId}/${input.runId}`);
    return run ? normalizeEvaluationRun(run) : undefined;
  }

  async list(input: { projectId: string; suiteId?: string }): Promise<readonly EvaluationRun[]> {
    return Array.from(this.#runs.values())
      .filter(
        (run) => run.projectId === input.projectId && (input.suiteId === undefined || run.suiteId === input.suiteId),
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(normalizeEvaluationRun);
  }

  async delete(input: { projectId: string; runId: string }): Promise<void> {
    this.#runs.delete(`${input.projectId}/${input.runId}`);
    for (const [key, artifact] of this.#recordings) {
      if (artifact.projectId === input.projectId && artifact.runId === input.runId) this.#recordings.delete(key);
    }
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    const key = `${snapshot.projectId}/${snapshot.fingerprint}`;
    // A content-addressed historical snapshot must never be rewritten by a
    // later edit of the live evaluation dataset.
    if (this.#datasetSnapshots.has(key)) return;
    this.#datasetSnapshots.set(key, structuredClone(snapshot));
  }

  async getDatasetSnapshot(input: {
    projectId: string;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    const snapshot = this.#datasetSnapshots.get(`${input.projectId}/${input.fingerprint}`);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    const key = `${artifact.projectId}/${artifact.reference.id}`;
    const existing = this.#recordings.get(key);
    if (existing && (existing.runId !== artifact.runId || existing.trialId !== artifact.trialId)) {
      throw new Error('An evaluation recording ID cannot be reassigned to another run or trial.');
    }
    const next = structuredClone(artifact);
    // Artifact persistence never owns retention transitions. A duplicate or
    // delayed write keeps whatever explicit update/promotion already decided.
    if (existing) next.reference = structuredClone(existing.reference);
    this.#recordings.set(key, next);
  }

  async getRecording(input: {
    projectId: string;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    const artifact = this.#recordings.get(`${input.projectId}/${input.recordingId}`);
    if (!artifact) return undefined;
    if (
      artifact.reference.retention === 'temporary' &&
      artifact.reference.expiresAt &&
      Date.parse(artifact.reference.expiresAt) <= Date.now()
    ) {
      this.#recordings.delete(`${input.projectId}/${input.recordingId}`);
      return undefined;
    }
    return structuredClone(artifact);
  }

  async updateRecordingRetention(input: {
    projectId: string;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<void> {
    const key = `${input.projectId}/${input.recordingId}`;
    const artifact = this.#recordings.get(key);
    if (!artifact) return;
    artifact.reference = {
      id: artifact.reference.id,
      retention: input.retention,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
  }

  async promoteBaseline(input: { projectId: string; runId: string }): Promise<void> {
    for (const artifact of this.#recordings.values()) {
      if (artifact.projectId !== input.projectId || artifact.runId !== input.runId) continue;
      artifact.reference = { id: artifact.reference.id, retention: 'baseline' };
    }
  }
}
