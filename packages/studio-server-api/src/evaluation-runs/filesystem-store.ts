import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

import { getAppDataRoot } from "../security.js";
import {
  EvaluationLibraryConflictError,
  applyCheckedEvaluationLibraryMutation,
  mergeEvaluationLibraries,
  toEvaluationLibrarySyncSnapshot,
  type EvaluationLibrarySnapshot,
  type RivetStudioEvaluationStore,
} from "./store.js";

type Row = { run_json: string };
type RecordingRow = { artifact_json: string };
type DatasetSnapshotRow = { snapshot_json: string };
type LibraryRow = { revision: number; library_json: string };

export function getFilesystemEvaluationRunsDatabasePath(): string {
  return path.join(getAppDataRoot(), "evaluation-runs.sqlite");
}

function parseRun(row: Row | undefined): EvaluationRun | undefined {
  return row ? normalizeEvaluationRun(JSON.parse(row.run_json)) : undefined;
}

function parseRecording(
  row: RecordingRow | undefined,
): EvaluationRecordingArtifact | undefined {
  if (!row) return undefined;
  const artifact = JSON.parse(row.artifact_json) as EvaluationRecordingArtifact;
  assertEvaluationRecordingArtifact(artifact);
  return artifact;
}

function parseDatasetSnapshot(
  row: DatasetSnapshotRow | undefined,
): EvaluationDatasetSnapshot | undefined {
  if (!row) return undefined;
  const snapshot = JSON.parse(row.snapshot_json) as EvaluationDatasetSnapshot;
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

function withImmediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the operation error; SQLite may already have rolled back a
      // transaction after a fatal statement failure.
    }
    throw error;
  }
}

/** SQLite's project ID predicates are the storage isolation boundary. */
export class FilesystemRivetEvaluationStore
  implements RivetStudioEvaluationStore
{
  readonly #databasePath: string;
  #databasePromise: Promise<DatabaseSync> | null = null;
  #disposePromise: Promise<void> | null = null;
  #disposed = false;
  #observedLibraryRevision: number | undefined;

  constructor(databasePath = getFilesystemEvaluationRunsDatabasePath()) {
    this.#databasePath = databasePath;
  }

  async #database(): Promise<DatabaseSync> {
    if (this.#disposed) {
      throw new Error(
        "The filesystem evaluation run store is already disposed.",
      );
    }
    this.#databasePromise ??= (async () => {
      await fs.mkdir(path.dirname(this.#databasePath), { recursive: true });
      const database = new DatabaseSync(this.#databasePath);
      try {
        database.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA journal_mode = DELETE;
          CREATE TABLE IF NOT EXISTS evaluation_library (
            singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
            revision INTEGER NOT NULL,
            library_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS evaluation_library_imports (
            source_fingerprint TEXT PRIMARY KEY,
            imported_at_ms INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS evaluation_runs (
            project_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            suite_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            run_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (project_id, run_id)
          );
          CREATE INDEX IF NOT EXISTS evaluation_runs_project_started_idx
            ON evaluation_runs(project_id, started_at DESC);
          CREATE INDEX IF NOT EXISTS evaluation_runs_project_suite_idx
            ON evaluation_runs(project_id, suite_id);
          CREATE TABLE IF NOT EXISTS evaluation_recordings (
            project_id TEXT NOT NULL,
            recording_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            artifact_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (project_id, recording_id)
          );
          CREATE INDEX IF NOT EXISTS evaluation_recordings_project_run_idx
            ON evaluation_recordings(project_id, run_id);
          CREATE TABLE IF NOT EXISTS evaluation_dataset_snapshots (
            project_id TEXT NOT NULL,
            dataset_fingerprint TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (project_id, dataset_fingerprint)
          );
          CREATE TABLE IF NOT EXISTS evaluation_deleted_projects (
            project_id TEXT PRIMARY KEY,
            deleted_at_ms INTEGER NOT NULL
          );
        `);
      } catch (error) {
        database.close();
        throw error;
      }
      return database;
    })().catch((error) => {
      this.#databasePromise = null;
      throw error;
    });
    return this.#databasePromise;
  }

  /**
   * Temporary candidate artifacts are deliberately short-lived. Run-history
   * reads are a natural cleanup point too: an idle project should not need a
   * later evaluation write or a request for the exact expired recording to
   * reclaim that storage.
   */
  #deleteExpiredTemporaryRecordings(
    database: DatabaseSync,
    projectId: ProjectId,
  ): void {
    database
      .prepare(
        `
      DELETE FROM evaluation_recordings
      WHERE project_id = ?
        AND json_extract(artifact_json, '$.reference.retention') = 'temporary'
        AND json_extract(artifact_json, '$.reference.expiresAt') IS NOT NULL
        AND datetime(json_extract(artifact_json, '$.reference.expiresAt')) <= datetime('now')
    `,
      )
      .run(String(projectId));
  }

  #assertProjectWritable(database: DatabaseSync, projectId: ProjectId): void {
    const deleted = database
      .prepare("SELECT 1 FROM evaluation_deleted_projects WHERE project_id = ?")
      .get(String(projectId));
    if (deleted) {
      throw new Error(
        "Evaluation history cannot be written after its project was deleted.",
      );
    }
  }

  #readLibrarySnapshot(database: DatabaseSync): EvaluationLibrarySnapshot {
    const row = database
      .prepare(
        "SELECT revision, library_json FROM evaluation_library WHERE singleton_key = 1",
      )
      .get<LibraryRow>();
    if (!row) {
      return { revision: 0, library: createEmptyEvaluationLibrary() };
    }
    try {
      return {
        revision: row.revision,
        library: normalizeEvaluationLibrary(JSON.parse(row.library_json)),
      };
    } catch (error) {
      throw new Error("The filesystem evaluation library is unreadable.", {
        cause: error,
      });
    }
  }

  #writeLibrary(
    database: DatabaseSync,
    revision: number,
    library: EvaluationLibrary,
  ): EvaluationLibrarySnapshot {
    const normalized = normalizeEvaluationLibrary(library);
    database
      .prepare(
        `
        INSERT INTO evaluation_library (singleton_key, revision, library_json, updated_at_ms)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton_key) DO UPDATE SET
          revision = excluded.revision,
          library_json = excluded.library_json,
          updated_at_ms = excluded.updated_at_ms
      `,
      )
      .run(revision, JSON.stringify(normalized), Date.now());
    return { revision, library: structuredClone(normalized) };
  }

  async getLibrarySnapshot(): Promise<EvaluationLibrarySnapshot> {
    const snapshot = this.#readLibrarySnapshot(await this.#database());
    return structuredClone(snapshot);
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
    const database = await this.#database();
    const snapshot = withImmediateTransaction(database, () => {
      const current = this.#readLibrarySnapshot(database);
      if (current.revision !== input.expectedRevision) {
        throw new EvaluationLibraryConflictError();
      }
      const normalized = normalizeEvaluationLibrary(input.library);
      if (JSON.stringify(normalized) === JSON.stringify(current.library)) {
        return current;
      }
      return this.#writeLibrary(database, current.revision + 1, normalized);
    });
    this.#observedLibraryRevision = snapshot.revision;
    return snapshot;
  }

  async mutateLibrary(input: import("@valerypopoff/rivet2-evaluations").EvaluationLibraryMutation) {
    const database = await this.#database();
    const snapshot = withImmediateTransaction(database, () => {
      const current = this.#readLibrarySnapshot(database);
      const result = applyCheckedEvaluationLibraryMutation(current.library, input);
      return result.changed ? this.#writeLibrary(database, current.revision + 1, result.library) : current;
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
    const database = await this.#database();
    const snapshot = withImmediateTransaction(database, () => {
      const current = this.#readLibrarySnapshot(database);
      const imported = database
        .prepare(
          "SELECT 1 FROM evaluation_library_imports WHERE source_fingerprint = ?",
        )
        .get(input.sourceFingerprint);
      if (imported) return current;

      const merged = mergeEvaluationLibraries(current.library, input.library);
      const changed =
        JSON.stringify(merged) !== JSON.stringify(current.library);
      const next = changed
        ? this.#writeLibrary(database, current.revision + 1, merged)
        : current;
      database
        .prepare(
          "INSERT INTO evaluation_library_imports (source_fingerprint, imported_at_ms) VALUES (?, ?)",
        )
        .run(input.sourceFingerprint, Date.now());
      return next;
    });
    this.#observedLibraryRevision = snapshot.revision;
    return structuredClone(snapshot);
  }

  async put(run: EvaluationRun): Promise<void> {
    const database = await this.#database();
    withImmediateTransaction(database, () => {
      const incoming = normalizeEvaluationRun(run);
      this.#assertProjectWritable(database, incoming.projectId);
      const existing = parseRun(
        database
          .prepare(
            "SELECT run_json FROM evaluation_runs WHERE project_id = ? AND run_id = ?",
          )
          .get<Row>(String(incoming.projectId), incoming.id),
      );
      const next = reconcileEvaluationRunSnapshots(existing, incoming);
      if (next === existing) return;
      database
        .prepare(
          `
        INSERT INTO evaluation_runs (project_id, run_id, suite_id, started_at, run_json, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, run_id) DO UPDATE SET
          suite_id = excluded.suite_id,
          started_at = excluded.started_at,
          run_json = excluded.run_json,
          updated_at_ms = excluded.updated_at_ms
      `,
        )
        .run(
          String(next.projectId),
          next.id,
          next.suiteId,
          next.startedAt,
          JSON.stringify(next),
          Date.now(),
        );
    });
  }

  async updateRunName(input: {
    projectId: ProjectId;
    runId: string;
    name?: string;
  }): Promise<EvaluationRun | undefined> {
    const database = await this.#database();
    return withImmediateTransaction(database, () => {
      const existing = parseRun(
        database
          .prepare(
            "SELECT run_json FROM evaluation_runs WHERE project_id = ? AND run_id = ?",
          )
          .get<Row>(String(input.projectId), input.runId),
      );
      if (!existing) return undefined;
      const renamed = normalizeEvaluationRun({ ...existing, name: input.name });
      database
        .prepare(
          "UPDATE evaluation_runs SET run_json = ?, updated_at_ms = ? WHERE project_id = ? AND run_id = ?",
        )
        .run(
          JSON.stringify(renamed),
          Date.now(),
          String(input.projectId),
          input.runId,
        );
      return renamed;
    });
  }

  async get(input: {
    projectId: ProjectId;
    runId: string;
  }): Promise<EvaluationRun | undefined> {
    const database = await this.#database();
    this.#deleteExpiredTemporaryRecordings(database, input.projectId);
    return parseRun(
      database
        .prepare(
          "SELECT run_json FROM evaluation_runs WHERE project_id = ? AND run_id = ?",
        )
        .get<Row>(String(input.projectId), input.runId),
    );
  }

  async list(input: {
    projectId: ProjectId;
    suiteId?: string;
  }): Promise<readonly EvaluationRun[]> {
    const database = await this.#database();
    this.#deleteExpiredTemporaryRecordings(database, input.projectId);
    const rows =
      input.suiteId == null
        ? database
            .prepare(
              "SELECT run_json FROM evaluation_runs WHERE project_id = ? ORDER BY started_at DESC, run_id DESC",
            )
            .all<Row>(String(input.projectId))
        : database
            .prepare(
              "SELECT run_json FROM evaluation_runs WHERE project_id = ? AND suite_id = ? ORDER BY started_at DESC, run_id DESC",
            )
            .all<Row>(String(input.projectId), input.suiteId);
    return rows.map((row) => parseRun(row)!);
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    const database = await this.#database();
    withImmediateTransaction(database, () => {
      database
        .prepare(
          "DELETE FROM evaluation_recordings WHERE project_id = ? AND run_id = ?",
        )
        .run(String(input.projectId), input.runId);
      database
        .prepare(
          "DELETE FROM evaluation_runs WHERE project_id = ? AND run_id = ?",
        )
        .run(String(input.projectId), input.runId);
    });
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    assertEvaluationDatasetSnapshot(snapshot);
    const database = await this.#database();
    withImmediateTransaction(database, () => {
      this.#assertProjectWritable(database, snapshot.projectId);
      database
        .prepare(
          `
        INSERT INTO evaluation_dataset_snapshots (project_id, dataset_fingerprint, snapshot_json, created_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, dataset_fingerprint) DO NOTHING
      `,
        )
        .run(
          String(snapshot.projectId),
          snapshot.fingerprint,
          JSON.stringify(snapshot),
          Date.now(),
        );
    });
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    const database = await this.#database();
    return parseDatasetSnapshot(
      database
        .prepare(
          "SELECT snapshot_json FROM evaluation_dataset_snapshots WHERE project_id = ? AND dataset_fingerprint = ?",
        )
        .get<DatasetSnapshotRow>(String(input.projectId), input.fingerprint),
    );
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    assertEvaluationRecordingArtifact(artifact);
    const database = await this.#database();
    // Retention must make space without waiting for a user to reopen an old
    // recording. JSON values preserve the compact artifact envelope without
    // introducing redundant expiry columns.
    withImmediateTransaction(database, () => {
      this.#assertProjectWritable(database, artifact.projectId);
      this.#deleteExpiredTemporaryRecordings(database, artifact.projectId);
      const existing = parseRecording(
        database
          .prepare(
            "SELECT artifact_json FROM evaluation_recordings WHERE project_id = ? AND recording_id = ?",
          )
          .get<RecordingRow>(String(artifact.projectId), artifact.reference.id),
      );
      if (
        existing &&
        (existing.runId !== artifact.runId ||
          existing.trialId !== artifact.trialId)
      ) {
        throw new Error(
          "An evaluation recording ID cannot be reassigned to another run or trial.",
        );
      }
      const next = structuredClone(artifact);
      if (existing) next.reference = structuredClone(existing.reference);
      database
        .prepare(
          `
        INSERT INTO evaluation_recordings (project_id, recording_id, run_id, artifact_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, recording_id) DO UPDATE SET
          run_id = excluded.run_id,
          artifact_json = excluded.artifact_json,
          created_at_ms = excluded.created_at_ms
      `,
        )
        .run(
          String(artifact.projectId),
          artifact.reference.id,
          artifact.runId,
          JSON.stringify(next),
          Date.now(),
        );
    });
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    const database = await this.#database();
    this.#deleteExpiredTemporaryRecordings(database, input.projectId);
    const artifact = parseRecording(
      database
        .prepare(
          "SELECT artifact_json FROM evaluation_recordings WHERE project_id = ? AND recording_id = ?",
        )
        .get<RecordingRow>(String(input.projectId), input.recordingId),
    );
    if (!artifact || !isExpired(artifact)) return artifact;
    database
      .prepare(
        "DELETE FROM evaluation_recordings WHERE project_id = ? AND recording_id = ?",
      )
      .run(String(input.projectId), input.recordingId);
    return undefined;
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact["reference"]["retention"];
    expiresAt?: string;
  }): Promise<boolean> {
    const database = await this.#database();
    return withImmediateTransaction(database, () => {
      const artifact = parseRecording(
        database
          .prepare(
            "SELECT artifact_json FROM evaluation_recordings WHERE project_id = ? AND recording_id = ?",
          )
          .get<RecordingRow>(String(input.projectId), input.recordingId),
      );
      if (!artifact) return false;
      artifact.reference = {
        id: artifact.reference.id,
        retention: input.retention,
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt }),
      };
      database
        .prepare(
          "UPDATE evaluation_recordings SET artifact_json = ? WHERE project_id = ? AND recording_id = ?",
        )
        .run(
          JSON.stringify(artifact),
          String(input.projectId),
          input.recordingId,
        );
      return true;
    });
  }

  async promoteBaseline(input: {
    projectId: ProjectId;
    runId: string;
  }): Promise<void> {
    const database = await this.#database();
    withImmediateTransaction(database, () => {
      const rows = database
        .prepare(
          "SELECT artifact_json FROM evaluation_recordings WHERE project_id = ? AND run_id = ?",
        )
        .all<RecordingRow>(String(input.projectId), input.runId);
      const update = database.prepare(
        "UPDATE evaluation_recordings SET artifact_json = ? WHERE project_id = ? AND recording_id = ?",
      );
      for (const row of rows) {
        const artifact = parseRecording(row)!;
        artifact.reference = {
          id: artifact.reference.id,
          retention: "baseline",
        };
        update.run(
          JSON.stringify(artifact),
          String(input.projectId),
          artifact.reference.id,
        );
      }
    });
  }

  async applyRunEvent(event: EvaluationRunEvent): Promise<void> {
    if (event.type === "run-started" || event.type === "run-finalized") {
      await this.put(event.run);
      return;
    }

    const database = await this.#database();
    withImmediateTransaction(database, () => {
      this.#assertProjectWritable(database, event.projectId);
      const existing = parseRun(
        database
          .prepare(
            "SELECT run_json FROM evaluation_runs WHERE project_id = ? AND run_id = ?",
          )
          .get<Row>(String(event.projectId), event.runId),
      );
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
      database
        .prepare(
          "UPDATE evaluation_runs SET run_json = ?, updated_at_ms = ? WHERE project_id = ? AND run_id = ?",
        )
        .run(
          JSON.stringify(next),
          Date.now(),
          String(event.projectId),
          event.runId,
        );
    });
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const database = await this.#database();
    const key = String(projectId);
    withImmediateTransaction(database, () => {
      database
        .prepare(
          `INSERT INTO evaluation_deleted_projects (project_id, deleted_at_ms)
           VALUES (?, ?)
           ON CONFLICT(project_id) DO UPDATE SET deleted_at_ms = excluded.deleted_at_ms`,
        )
        .run(key, Date.now());
      database
        .prepare(
          "DELETE FROM evaluation_dataset_snapshots WHERE project_id = ?",
        )
        .run(key);
      database
        .prepare("DELETE FROM evaluation_recordings WHERE project_id = ?")
        .run(key);
      database
        .prepare("DELETE FROM evaluation_runs WHERE project_id = ?")
        .run(key);
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposePromise ??= (async () => {
      const promise = this.#databasePromise;
      if (promise) (await promise).close();
      this.#databasePromise = null;
    })();
    await this.#disposePromise;
  }
}
