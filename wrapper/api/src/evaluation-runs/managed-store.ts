import type { Pool, PoolClient } from "pg";
import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  assertEvaluationDatasetSnapshot,
  normalizeEvaluationRun,
  reconcileEvaluationRunSnapshots,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
} from "@valerypopoff/rivet2-evaluations";

import type { RivetStudioEvaluationRunStore } from "./store.js";

type Row = { run_json: EvaluationRun | string };
type RecordingRow = { artifact_json: EvaluationRecordingArtifact | string };
type DatasetSnapshotRow = { snapshot_json: EvaluationDatasetSnapshot | string };

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
  return typeof row.artifact_json === "string"
    ? (JSON.parse(row.artifact_json) as EvaluationRecordingArtifact)
    : row.artifact_json;
}

function parseDatasetSnapshot(
  row: DatasetSnapshotRow | undefined,
): EvaluationDatasetSnapshot | undefined {
  if (!row) return undefined;
  return typeof row.snapshot_json === "string"
    ? (JSON.parse(row.snapshot_json) as EvaluationDatasetSnapshot)
    : row.snapshot_json;
}

function isExpired(artifact: EvaluationRecordingArtifact): boolean {
  return (
    artifact.reference.retention === "temporary" &&
    artifact.reference.expiresAt != null &&
    Date.parse(artifact.reference.expiresAt) <= Date.now()
  );
}

/** PostgreSQL implementation shared by every Studio Server execution pod. */
export class PostgresRivetEvaluationRunStore
  implements RivetStudioEvaluationRunStore
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
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

  /** See the filesystem store: browsing a project's run history must also
   * reclaim expired temporary candidate artifacts. */
  async #deleteExpiredTemporaryRecordings(projectId: ProjectId): Promise<void> {
    await this.#pool.query(
      `
      DELETE FROM evaluation_recordings
      WHERE project_id = $1
        AND artifact_json->'reference'->>'retention' = 'temporary'
        AND artifact_json->'reference'->>'expiresAt' IS NOT NULL
        AND (artifact_json->'reference'->>'expiresAt')::timestamptz <= NOW()
    `,
      [String(projectId)],
    );
  }

  async put(run: EvaluationRun): Promise<void> {
    const incoming = normalizeEvaluationRun(run);
    await this.#withRunLock({ projectId: incoming.projectId, runId: incoming.id }, async (client) => {
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
    });
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
    await this.#deleteExpiredTemporaryRecordings(input.projectId);
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
    await this.#deleteExpiredTemporaryRecordings(input.projectId);
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
    // Expire temporary artifacts during ordinary writes, rather than relying
    // on a later read of the exact recording id to perform cleanup.
    await this.#deleteExpiredTemporaryRecordings(artifact.projectId);
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
    await this.#deleteExpiredTemporaryRecordings(input.projectId);
    const result = await this.#pool.query<RecordingRow>(
      "SELECT artifact_json FROM evaluation_recordings WHERE project_id = $1 AND recording_id = $2",
      [String(input.projectId), input.recordingId],
    );
    const artifact = parseRecording(result.rows[0]);
    if (!artifact || !isExpired(artifact)) return artifact;
    await this.#pool.query(
      "DELETE FROM evaluation_recordings WHERE project_id = $1 AND recording_id = $2",
      [String(input.projectId), input.recordingId],
    );
    return undefined;
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact["reference"]["retention"];
    expiresAt?: string;
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RecordingRow>(
        "SELECT artifact_json FROM evaluation_recordings WHERE project_id = $1 AND recording_id = $2 FOR UPDATE",
        [String(input.projectId), input.recordingId],
      );
      const artifact = parseRecording(result.rows[0]);
      if (artifact) {
        artifact.reference = {
          id: artifact.reference.id,
          retention: input.retention,
          ...(input.expiresAt === undefined
            ? {}
            : { expiresAt: input.expiresAt }),
        };
        await client.query(
          "UPDATE evaluation_recordings SET artifact_json = $1::jsonb WHERE project_id = $2 AND recording_id = $3",
          [
            JSON.stringify(artifact),
            String(input.projectId),
            input.recordingId,
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
