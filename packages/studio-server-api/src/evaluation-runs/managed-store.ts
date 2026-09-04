import type { Pool, PoolClient } from "pg";
import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  assertEvaluationDatasetSnapshot,
  assertEvaluationRecordingArtifact,
  createEmptyEvaluationLibrary,
  normalizeEvaluationLibrary,
  normalizeEvaluationRun,
  reconcileEvaluationRunSnapshots,
  type EvaluationDatasetSnapshot,
  type EvaluationLibrary,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
  type EvaluationRunEvent,
} from "@valerypopoff/rivet2-evaluations";

import {
  EvaluationLibraryConflictError,
  applyCheckedEvaluationLibraryMutation,
  mergeEvaluationLibraries,
  toEvaluationLibrarySyncSnapshot,
  type EvaluationLibrarySnapshot,
  type RivetStudioEvaluationStore,
} from "./store.js";

type Row = { run_json: EvaluationRun | string };
type RecordingRow = {
  artifact_json: EvaluationRecordingArtifact | string;
  protected_from_expiry?: boolean;
};
type DatasetSnapshotRow = { snapshot_json: EvaluationDatasetSnapshot | string };
type LibraryRow = {
  revision: number;
  library_json: EvaluationLibrary | string;
};

function parseRun(row: Row | undefined): EvaluationRun | undefined {
  if (!row) return undefined;
  return normalizeEvaluationRun(
    typeof row.run_json === "string" ? JSON.parse(row.run_json) : row.run_json,
  );
}

function parseRecording(
  row: RecordingRow | undefined,
): EvaluationRecordingArtifact | undefined {
  if (!row) return undefined;
  const artifact =
    typeof row.artifact_json === "string"
      ? (JSON.parse(row.artifact_json) as EvaluationRecordingArtifact)
      : row.artifact_json;
  assertEvaluationRecordingArtifact(artifact);
  return artifact;
}

function parseDatasetSnapshot(
  row: DatasetSnapshotRow | undefined,
): EvaluationDatasetSnapshot | undefined {
  if (!row) return undefined;
  const snapshot =
    typeof row.snapshot_json === "string"
      ? (JSON.parse(row.snapshot_json) as EvaluationDatasetSnapshot)
      : row.snapshot_json;
  assertEvaluationDatasetSnapshot(snapshot);
  return snapshot;
}

function isExpired(artifact: EvaluationRecordingArtifact): boolean {
  return (
    artifact.reference.retention === "temporary" &&
    artifact.reference.expiresAt != null &&
    Date.parse(artifact.reference.expiresAt) <= Date.now()
  );
}

/** PostgreSQL implementation shared by every Studio Server execution pod. */
export class PostgresRivetEvaluationStore
  implements RivetStudioEvaluationStore
{
  readonly #pool: Pool;
  #observedLibraryRevision: number | undefined;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async #withLibraryLock<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "rivet-evaluation-library",
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #readLibrarySnapshot(
    queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  ): Promise<EvaluationLibrarySnapshot> {
    const result = await queryable.query<LibraryRow>(
      "SELECT revision, library_json FROM evaluation_library WHERE singleton_key = TRUE",
    );
    const row = result.rows[0];
    if (!row) return { revision: 0, library: createEmptyEvaluationLibrary() };
    try {
      return {
        revision: Number(row.revision),
        library: normalizeEvaluationLibrary(
          typeof row.library_json === "string"
            ? JSON.parse(row.library_json)
            : row.library_json,
        ),
      };
    } catch (error) {
      throw new Error("The managed evaluation library is unreadable.", {
        cause: error,
      });
    }
  }

  async #writeLibrary(
    client: PoolClient,
    revision: number,
    library: EvaluationLibrary,
  ): Promise<EvaluationLibrarySnapshot> {
    const normalized = normalizeEvaluationLibrary(library);
    await client.query(
      `
      INSERT INTO evaluation_library (singleton_key, revision, library_json, updated_at)
      VALUES (TRUE, $1, $2::jsonb, NOW())
      ON CONFLICT (singleton_key) DO UPDATE SET
        revision = EXCLUDED.revision,
        library_json = EXCLUDED.library_json,
        updated_at = NOW()
    `,
      [revision, JSON.stringify(normalized)],
    );
    return { revision, library: structuredClone(normalized) };
  }

  async getLibrarySnapshot(): Promise<EvaluationLibrarySnapshot> {
    return structuredClone(await this.#readLibrarySnapshot(this.#pool));
  }

  async getLibrarySyncSnapshot() {
    return toEvaluationLibrarySyncSnapshot(await this.getLibrarySnapshot());
  }

  async getLibrary(): Promise<EvaluationLibrary> {
    const snapshot = await this.getLibrarySnapshot();
    this.#observedLibraryRevision = snapshot.revision;
    return snapshot.library;
  }

  async replaceLibrary(input: {
    expectedRevision: number;
    library: EvaluationLibrary;
  }): Promise<EvaluationLibrarySnapshot> {
    const snapshot = await this.#withLibraryLock(async (client) => {
      const current = await this.#readLibrarySnapshot(client);
      if (current.revision !== input.expectedRevision) {
        throw new EvaluationLibraryConflictError();
      }
      const normalized = normalizeEvaluationLibrary(input.library);
      if (JSON.stringify(normalized) === JSON.stringify(current.library)) {
        return current;
      }
      return this.#writeLibrary(client, current.revision + 1, normalized);
    });
    this.#observedLibraryRevision = snapshot.revision;
    return snapshot;
  }

  async mutateLibrary(input: import("@valerypopoff/rivet2-evaluations").EvaluationLibraryMutation) {
    const snapshot = await this.#withLibraryLock(async (client) => {
      const current = await this.#readLibrarySnapshot(client);
      const result = applyCheckedEvaluationLibraryMutation(current.library, input);
      return result.changed ? this.#writeLibrary(client, current.revision + 1, result.library) : current;
    });
    this.#observedLibraryRevision = snapshot.revision;
    return toEvaluationLibrarySyncSnapshot(snapshot);
  }

  async putLibrary(library: EvaluationLibrary): Promise<void> {
    const expectedRevision =
      this.#observedLibraryRevision ??
      (await this.getLibrarySnapshot()).revision;
    await this.replaceLibrary({ expectedRevision, library });
  }

  async importLegacyLibrary(input: {
    sourceFingerprint: string;
    library: EvaluationLibrary;
  }): Promise<EvaluationLibrarySnapshot> {
    const snapshot = await this.#withLibraryLock(async (client) => {
      const current = await this.#readLibrarySnapshot(client);
      const imported = await client.query(
        "SELECT 1 FROM evaluation_library_imports WHERE source_fingerprint = $1",
        [input.sourceFingerprint],
      );
      if (imported.rowCount) return current;

      const merged = mergeEvaluationLibraries(current.library, input.library);
      const changed =
        JSON.stringify(merged) !== JSON.stringify(current.library);
      const next = changed
        ? await this.#writeLibrary(client, current.revision + 1, merged)
        : current;
      await client.query(
        "INSERT INTO evaluation_library_imports (source_fingerprint, imported_at) VALUES ($1, NOW())",
        [input.sourceFingerprint],
      );
      return next;
    });
    this.#observedLibraryRevision = snapshot.revision;
    return structuredClone(snapshot);
  }

  async #withRunLock<T>(
    input: { projectId: ProjectId; runId: string },
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(input.projectId), input.runId],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async put(run: EvaluationRun): Promise<void> {
    const incoming = normalizeEvaluationRun(run);
    await this.#withRunLock(
      { projectId: incoming.projectId, runId: incoming.id },
      async (client) => {
        const current = await client.query<Row>(
          "SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE",
          [String(incoming.projectId), incoming.id],
        );
        const existing = parseRun(current.rows[0]);
        const next = reconcileEvaluationRunSnapshots(existing, incoming);
        if (next === existing) return;
        if (existing) {
          await client.query(
            `
          UPDATE evaluation_runs
          SET suite_id = $3, started_at = $4, run_json = $5::jsonb, updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2
        `,
            [
              String(next.projectId),
              next.id,
              next.suiteId,
              next.startedAt,
              JSON.stringify(next),
            ],
          );
          return;
        }
        await client.query(
          `
        INSERT INTO evaluation_runs (project_id, run_id, suite_id, started_at, run_json, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
      `,
          [
            String(next.projectId),
            next.id,
            next.suiteId,
            next.startedAt,
            JSON.stringify(next),
          ],
        );
      },
    );
  }

  async updateRunName(input: {
    projectId: ProjectId;
    runId: string;
    name?: string;
  }): Promise<EvaluationRun | undefined> {
    return this.#withRunLock(input, async (client) => {
      const current = await client.query<Row>(
        "SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE",
        [String(input.projectId), input.runId],
      );
      const existing = parseRun(current.rows[0]);
      if (!existing) return undefined;
      const renamed = normalizeEvaluationRun({ ...existing, name: input.name });
      await client.query(
        `
        UPDATE evaluation_runs
        SET run_json = $3::jsonb, updated_at = NOW()
        WHERE project_id = $1 AND run_id = $2
      `,
        [String(input.projectId), input.runId, JSON.stringify(renamed)],
      );
      return renamed;
    });
  }

  async get(input: {
    projectId: ProjectId;
    runId: string;
  }): Promise<EvaluationRun | undefined> {
    const result = await this.#pool.query<Row>(
      "SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2",
      [String(input.projectId), input.runId],
    );
    return parseRun(result.rows[0]);
  }

  async list(input: {
    projectId: ProjectId;
    suiteId?: string;
  }): Promise<readonly EvaluationRun[]> {
    const result =
      input.suiteId == null
        ? await this.#pool.query<Row>(
            "SELECT run_json FROM evaluation_runs WHERE project_id = $1 ORDER BY started_at DESC, run_id DESC",
            [String(input.projectId)],
          )
        : await this.#pool.query<Row>(
            "SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND suite_id = $2 ORDER BY started_at DESC, run_id DESC",
            [String(input.projectId), input.suiteId],
          );
    return result.rows.map((row) => parseRun(row)!);
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM evaluation_recordings WHERE project_id = $1 AND run_id = $2",
        [String(input.projectId), input.runId],
      );
      await client.query(
        "DELETE FROM evaluation_runs WHERE project_id = $1 AND run_id = $2",
        [String(input.projectId), input.runId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    await this.#pool.query(
      `
      INSERT INTO evaluation_dataset_snapshots (project_id, dataset_fingerprint, snapshot_json, created_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (project_id, dataset_fingerprint) DO NOTHING
    `,
      [
        String(snapshot.projectId),
        snapshot.fingerprint,
        JSON.stringify(snapshot),
      ],
    );
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    const result = await this.#pool.query<DatasetSnapshotRow>(
      "SELECT snapshot_json FROM evaluation_dataset_snapshots WHERE project_id = $1 AND dataset_fingerprint = $2",
      [String(input.projectId), input.fingerprint],
    );
    return parseDatasetSnapshot(result.rows[0]);
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    assertEvaluationRecordingArtifact(artifact);
    const result = await this.#pool.query<{ recording_id: string }>(
      `
      INSERT INTO evaluation_recordings (project_id, recording_id, run_id, artifact_json, created_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (project_id, recording_id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        artifact_json = jsonb_set(
          EXCLUDED.artifact_json,
          '{reference}',
          evaluation_recordings.artifact_json->'reference'
        ),
        created_at = NOW()
      WHERE evaluation_recordings.run_id = EXCLUDED.run_id
        AND evaluation_recordings.artifact_json->>'trialId' = EXCLUDED.artifact_json->>'trialId'
      RETURNING recording_id
    `,
      [
        String(artifact.projectId),
        artifact.reference.id,
        artifact.runId,
        JSON.stringify(artifact),
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "An evaluation recording ID cannot be reassigned to another run or trial.",
      );
    }
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    const result = await this.#pool.query<RecordingRow>(
      `
      SELECT recording.artifact_json,
        (
          EXISTS (
            SELECT 1
            FROM evaluation_hosted_runs AS hosted
            WHERE hosted.project_id = recording.project_id
              AND hosted.run_id = recording.run_id
              AND hosted.status IN ('queued', 'running')
          )
          OR EXISTS (
            SELECT 1
            FROM evaluation_hosted_trial_jobs AS job
            WHERE job.project_id = recording.project_id
              AND job.run_id = recording.run_id
              AND job.status IN ('queued', 'claimed', 'accepted')
          )
        ) AS protected_from_expiry
      FROM evaluation_recordings AS recording
      WHERE recording.project_id = $1 AND recording.recording_id = $2
    `,
      [String(input.projectId), input.recordingId],
    );
    const row = result.rows[0];
    const artifact = parseRecording(row);
    // The fenced cleanup worker uses the same active-parent/job predicate.
    // Never make a long-running hosted evaluation's protected recording look
    // missing merely because its provisional 24-hour window elapsed first.
    return artifact && (!isExpired(artifact) || row?.protected_from_expiry === true) ? artifact : undefined;
  }
  async #updateRecordingRetentionWithClient(
    client: PoolClient,
    input: {
      projectId: ProjectId;
      recordingId: string;
      retention: EvaluationRecordingArtifact['reference']['retention'];
      expiresAt?: string;
    },
  ): Promise<boolean> {
    const result = await client.query<RecordingRow>(
      'SELECT artifact_json FROM evaluation_recordings WHERE project_id = $1 AND recording_id = $2 FOR UPDATE',
      [String(input.projectId), input.recordingId],
    );
    const artifact = parseRecording(result.rows[0]);
    if (!artifact) return false;
    artifact.reference = {
      id: artifact.reference.id,
      retention: input.retention,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    await client.query(
      'UPDATE evaluation_recordings SET artifact_json = $1::jsonb WHERE project_id = $2 AND recording_id = $3',
      [JSON.stringify(artifact), String(input.projectId), input.recordingId],
    );
    return true;
  }

  /**
   * Applies a terminal retention transition inside the caller's transaction.
   * Hosted evaluation projection must use this form so an expired temporary
   * artifact cannot be swept between marking a run complete and extending its
   * retention window.
   */
  async updateRecordingRetentionInTransaction(
    client: PoolClient,
    input: {
      projectId: ProjectId;
      recordingId: string;
      retention: EvaluationRecordingArtifact['reference']['retention'];
      expiresAt?: string;
    },
  ): Promise<boolean> {
    return this.#updateRecordingRetentionWithClient(client, input);
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await this.#updateRecordingRetentionWithClient(client, input);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async promoteBaseline(input: {
    projectId: ProjectId;
    runId: string;
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RecordingRow>(
        "SELECT artifact_json FROM evaluation_recordings WHERE project_id = $1 AND run_id = $2 FOR UPDATE",
        [String(input.projectId), input.runId],
      );
      for (const row of result.rows) {
        const artifact = parseRecording(row)!;
        artifact.reference = {
          id: artifact.reference.id,
          retention: "baseline",
        };
        await client.query(
          "UPDATE evaluation_recordings SET artifact_json = $1::jsonb WHERE project_id = $2 AND recording_id = $3",
          [
            JSON.stringify(artifact),
            String(input.projectId),
            artifact.reference.id,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async applyRunEvent(event: EvaluationRunEvent): Promise<void> {
    if (event.type === "run-started" || event.type === "run-finalized") {
      await this.put(event.run);
      return;
    }

    await this.#withRunLock(event, async (client) => {
      const result = await client.query<Row>(
        "SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE",
        [String(event.projectId), event.runId],
      );
      const existing = parseRun(result.rows[0]);
      if (!existing) {
        throw new Error(
          "Evaluation run checkpoint arrived before its run-started event.",
        );
      }
      if (existing.suiteId !== event.suiteId) {
        throw new Error("Evaluation run checkpoint does not match its suite.");
      }
      if ((existing.revision ?? 0) >= event.revision) return;

      const trials = [...existing.trials];
      const trialIndex = trials.findIndex(
        (trial) =>
          trial.caseId === event.trial.caseId &&
          trial.trialIndex === event.trial.trialIndex,
      );
      if (trialIndex >= 0) trials[trialIndex] = event.trial;
      else trials.push(event.trial);
      trials.sort(
        (left, right) =>
          left.caseIndex - right.caseIndex ||
          left.trialIndex - right.trialIndex,
      );
      const next = normalizeEvaluationRun({
        ...existing,
        revision: event.revision,
        requestedTrialCount: event.requestedTrialCount,
        trials,
      });
      await client.query(
        `
        UPDATE evaluation_runs
        SET run_json = $3::jsonb, updated_at = NOW()
        WHERE project_id = $1 AND run_id = $2
      `,
        [String(event.projectId), event.runId, JSON.stringify(next)],
      );
    });
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM evaluation_recordings WHERE project_id = $1",
        [String(projectId)],
      );
      await client.query(
        "DELETE FROM evaluation_dataset_snapshots WHERE project_id = $1",
        [String(projectId)],
      );
      await client.query("DELETE FROM evaluation_runs WHERE project_id = $1", [
        String(projectId),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
