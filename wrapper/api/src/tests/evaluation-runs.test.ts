import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { Pool } from "pg";
import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  fingerprintEvaluationDataset,
  normalizeEvaluationRun,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
} from "@valerypopoff/rivet2-evaluations";

import { FilesystemRivetEvaluationRunStore } from "../evaluation-runs/filesystem-store.js";
import { PostgresRivetEvaluationRunStore } from "../evaluation-runs/managed-store.js";
import {
  evaluationRecordingSchema,
  evaluationRunSchema,
  MAX_EVALUATION_RECORDING_BYTES,
} from "../routes/workflows/evaluation-runs.js";
import { createHttpEvaluationRunStore } from "../../../shared/evaluationRunHttpStore.js";
import { createApiApp } from "../app.js";

const projectA = "project-a" as ProjectId;
const projectB = "project-b" as ProjectId;

test("evaluation history API is behind the global control-plane authentication boundary", async () => {
  const server = http.createServer(createApiApp("control"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workflows/evaluation-runs?projectId=${projectA}`,
    );
    assert.equal(response.status, 403);
  } finally {
    server.close();
    await once(server, "close");
  }
});

function run(projectId: ProjectId, id: string): EvaluationRun {
  return {
    version: 2,
    id,
    projectId,
    suiteId: "suite",
    suiteName: "Suite",
    startedAt: "2026-08-15T00:00:00.000Z",
    purpose: "evaluation",
    executionStatus: "completed",
    qualityStatus: "passed",
    qualityReason: {
      code: "checks-passed",
      message: "All required quality criteria passed.",
    },
    accountingStatus: "complete",
    provenance: {
      projectFingerprint: "project",
      suiteFingerprint: "suite",
      datasetFingerprint: "dataset",
      targetFingerprint: "target",
      evaluatorFingerprints: {},
      executionMode: "test",
      accountingComplete: true,
    },
    aggregate: {
      trialCount: 1,
      evaluatedTrialCount: 1,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
      passedTrialCount: 1,
      failedTrialCount: 0,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      passRate: 1,
      averageLatencyMs: 1,
      p95LatencyMs: 1,
      targetErrorRate: 0,
      evaluatorErrorRate: 0,
      toolFailureRate: 0,
      metrics: {},
    },
    thresholdResults: [],
    trials: [
      {
        id: "trial",
        caseId: "case",
        caseName: "Case",
        caseIndex: 0,
        trialIndex: 0,
        executionStatus: "completed",
        qualityStatus: "passed",
        qualityReason: {
          code: "checks-passed",
          message: "All required quality criteria passed.",
        },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 0 },
        totalMetrics: { durationMs: 1 },
      },
    ],
    warnings: [],
  };
}

function legacyRun(projectId: ProjectId, id: string): EvaluationRun {
  const legacy = structuredClone(run(projectId, id)) as unknown as Record<
    string,
    unknown
  >;
  delete legacy.version;
  delete legacy.purpose;
  delete legacy.qualityStatus;
  delete legacy.qualityReason;
  delete legacy.accountingStatus;
  delete legacy.thresholdResults;
  legacy.verdict = "pass";
  legacy.trials = (legacy.trials as Array<Record<string, unknown>>).map(
    (trial) => {
      const oldTrial: Record<string, unknown> = {
        ...trial,
        status: "passed",
      };
      delete oldTrial.executionStatus;
      delete oldTrial.qualityStatus;
      delete oldTrial.qualityReason;
      return oldTrial;
    },
  );
  return legacy as unknown as EvaluationRun;
}

test("evaluation run API accepts v2 writes and rejects legacy write envelopes", () => {
  const current = run(projectA, "run-v2");
  assert.equal(evaluationRunSchema.safeParse(current).success, true);

  assert.equal(
    evaluationRunSchema.safeParse({ ...current, verdict: "pass" }).success,
    false,
  );
  assert.equal(
    evaluationRunSchema.safeParse({
      ...current,
      trials: [{ ...current.trials[0], status: "passed" }],
    }).success,
    false,
  );

  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  delete legacy.version;
  delete legacy.purpose;
  delete legacy.qualityStatus;
  delete legacy.qualityReason;
  delete legacy.accountingStatus;
  delete legacy.thresholdResults;
  assert.equal(evaluationRunSchema.safeParse(legacy).success, false);

  const missingTrialQuality = structuredClone(current) as unknown as Record<
    string,
    unknown
  >;
  missingTrialQuality.trials = [
    {
      ...(current.trials[0] as object),
      qualityStatus: undefined,
    },
  ];
  assert.equal(
    evaluationRunSchema.safeParse(missingTrialQuality).success,
    false,
  );
});

test("evaluation recording API enforces UTF-8 byte limits and coherent temporary expiry", () => {
  const artifact = recording(
    projectA,
    "recording-schema",
    "temporary",
    "2099-01-01T00:00:00.000Z",
  );
  assert.equal(evaluationRecordingSchema.safeParse(artifact).success, true);
  assert.equal(
    evaluationRecordingSchema.safeParse({
      ...artifact,
      reference: { id: artifact.reference.id, retention: "temporary" },
    }).success,
    false,
  );
  assert.equal(
    evaluationRecordingSchema.safeParse({
      ...artifact,
      reference: {
        id: artifact.reference.id,
        retention: "failure",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }).success,
    false,
  );

  const nonAsciiPayload = "€".repeat(Math.floor(MAX_EVALUATION_RECORDING_BYTES / 3) + 1);
  assert.equal(nonAsciiPayload.length < MAX_EVALUATION_RECORDING_BYTES, true);
  assert.equal(
    evaluationRecordingSchema.safeParse({ ...artifact, serialized: nonAsciiPayload }).success,
    false,
  );
});

test("hosted HTTP evaluation store normalizes legacy run responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const legacy = legacyRun(projectA, "legacy-http-run");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://rivet.example" } },
  });
  globalThis.fetch = async (input) => {
    const requestUrl = new URL(String(input));
    return Response.json(
      requestUrl.pathname.endsWith("/legacy-http-run") ? legacy : [legacy],
    );
  };
  try {
    const store = createHttpEvaluationRunStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
    });
    const [normalized] = await store.list({
      projectId: projectA,
    });
    assert.equal(normalized?.version, 2);
    assert.equal(normalized?.purpose, "evaluation");
    assert.equal(normalized?.qualityStatus, "not-evaluated");
    assert.equal("verdict" in (normalized ?? {}), false);
    assert.equal("status" in (normalized?.trials[0] ?? {}), false);
    assert.deepEqual(normalized?.thresholdResults, []);

    const normalizedById = await store.get({
      projectId: projectA,
      runId: "legacy-http-run",
    });
    assert.equal(normalizedById?.qualityStatus, "not-evaluated");
    assert.equal("verdict" in (normalizedById ?? {}), false);
    assert.equal("status" in (normalizedById?.trials[0] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("hosted HTTP evaluation store sends project-scoped run name updates", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const saved = { ...run(projectA, "renamed-http-run"), name: "Baseline" };
  let request: { url: string; init: RequestInit | undefined } | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://rivet.example" } },
  });
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return Response.json(saved);
  };
  try {
    const store = createHttpEvaluationRunStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
    });
    const renamed = await store.updateRunName({
      projectId: projectA,
      runId: "renamed-http-run",
      name: "  Baseline  ",
    });
    assert.equal(renamed?.name, "Baseline");
    assert.equal(request?.url, "/api/workflows/evaluation-runs/renamed-http-run");
    assert.equal(request?.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      projectId: projectA,
      name: "  Baseline  ",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("filesystem evaluation store preserves user-assigned names across snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rivet-evaluations-names-"));
  const store = new FilesystemRivetEvaluationRunStore(path.join(root, "evaluations.sqlite"));
  try {
    const initial = run(projectA, "named-filesystem-run");
    await store.put(initial);
    assert.equal(
      (await store.updateRunName({
        projectId: projectA,
        runId: initial.id,
        name: "  Baseline  ",
      }))?.name,
      "Baseline",
    );
    await store.put({ ...initial, revision: 1 });
    assert.equal(
      (await store.get({ projectId: projectA, runId: initial.id }))?.name,
      "Baseline",
    );
    await store.updateRunName({ projectId: projectA, runId: initial.id });
    await store.put({ ...initial, revision: 2 });
    assert.equal(
      (await store.get({ projectId: projectA, runId: initial.id }))?.name,
      undefined,
    );
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("filesystem evaluation store normalizes legacy run history at its read boundary", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-legacy-"),
  );
  const store = new FilesystemRivetEvaluationRunStore(
    path.join(root, "evaluations.sqlite"),
  );
  try {
    await store.put(legacyRun(projectA, "legacy-run"));

    const normalized = await store.get({
      projectId: projectA,
      runId: "legacy-run",
    });
    assert.equal(normalized?.version, 2);
    assert.equal(normalized?.purpose, "evaluation");
    assert.equal(normalized?.qualityStatus, "not-evaluated");
    assert.equal(normalized?.accountingStatus, "complete");
    assert.equal("verdict" in (normalized ?? {}), false);
    assert.equal("status" in (normalized?.trials[0] ?? {}), false);
    assert.deepEqual(normalized?.thresholdResults, []);
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function recording(
  projectId: ProjectId,
  id: string,
  retention: EvaluationRecordingArtifact["reference"]["retention"],
  expiresAt?: string,
): EvaluationRecordingArtifact {
  return {
    projectId,
    runId: `run-${String(projectId)}`,
    trialId: "trial",
    reference: {
      id,
      retention,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    serialized: `recording:${id}`,
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

function datasetSnapshot(projectId: ProjectId): EvaluationDatasetSnapshot {
  const dataset = {
    id: "dataset",
    projectId,
    name: "Dataset",
    fields: [
      {
        id: "input",
        name: "Input",
        dataType: "string",
        role: "input" as const,
      },
    ],
    cases: [
      { id: "case", name: "Case", values: { input: "historical input" } },
    ],
  };
  return {
    projectId,
    fingerprint: fingerprintEvaluationDataset(dataset),
    createdAt: "2026-08-15T00:00:00.000Z",
    dataset,
  };
}

test("filesystem evaluation store isolates projects, expires temporary artifacts during history reads, and pins baseline artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rivet-evaluations-"));
  const store = new FilesystemRivetEvaluationRunStore(
    path.join(root, "evaluations.sqlite"),
  );
  try {
    await store.put(run(projectA, "run-a"));
    await store.put(run(projectB, "run-b"));
    await store.putRecording(
      recording(projectA, "expired-a", "temporary", "2020-01-01T00:00:00.000Z"),
    );
    await store.putRecording(
      recording(projectB, "current-b", "temporary", "2099-01-01T00:00:00.000Z"),
    );
    await store.putRecording(
      recording(
        projectA,
        "baseline-a",
        "temporary",
        "2099-01-01T00:00:00.000Z",
      ),
    );
    await store.putDatasetSnapshot(datasetSnapshot(projectA));

    assert.deepEqual(
      (await store.list({ projectId: projectA })).map((item) => item.id),
      ["run-a"],
    );
    assert.equal(
      await store.getRecording({
        projectId: projectA,
        recordingId: "expired-a",
      }),
      undefined,
    );
    assert.equal(
      (
        await store.getRecording({
          projectId: projectB,
          recordingId: "current-b",
        })
      )?.serialized,
      "recording:current-b",
    );
    const snapshot = datasetSnapshot(projectA);
    assert.equal(
      (
        await store.getDatasetSnapshot({
          projectId: projectA,
          fingerprint: snapshot.fingerprint,
        })
      )?.dataset.cases[0]?.values.input,
      "historical input",
    );
    assert.equal(
      await store.getDatasetSnapshot({
        projectId: projectB,
        fingerprint: snapshot.fingerprint,
      }),
      undefined,
    );

    await store.promoteBaseline({
      projectId: projectA,
      runId: "run-project-a",
    });
    await store.putRecording(
      recording(
        projectA,
        "baseline-a",
        "temporary",
        "2099-01-01T00:00:00.000Z",
      ),
    );
    assert.equal(
      (
        await store.getRecording({
          projectId: projectA,
          recordingId: "baseline-a",
        })
      )?.reference.retention,
      "baseline",
    );
    await assert.rejects(
      store.putRecording({
        ...recording(
          projectA,
          "baseline-a",
          "temporary",
          "2099-01-01T00:00:00.000Z",
        ),
        runId: "another-run",
      }),
      /cannot be reassigned/u,
    );

    await store.deleteProject(projectA);
    assert.equal(
      await store.get({ projectId: projectA, runId: "run-a" }),
      undefined,
    );
    assert.equal(
      await store.getRecording({
        projectId: projectA,
        recordingId: "baseline-a",
      }),
      undefined,
    );
    assert.equal(
      await store.getDatasetSnapshot({
        projectId: projectA,
        fingerprint: snapshot.fingerprint,
      }),
      undefined,
    );
    assert.equal(
      (await store.get({ projectId: projectB, runId: "run-b" }))?.id,
      "run-b",
    );
    assert.equal(
      (
        await store.getRecording({
          projectId: projectB,
          recordingId: "current-b",
        })
      )?.serialized,
      "recording:current-b",
    );
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem project cleanup rolls back every row and its write fence when deletion fails", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-rollback-"),
  );
  const databasePath = path.join(root, "evaluations.sqlite");
  const store = new FilesystemRivetEvaluationRunStore(databasePath);
  try {
    await store.put(run(projectA, "run-project-a"));
    await store.putRecording(recording(projectA, "retained-a", "retained"));

    const triggerDatabase = new DatabaseSync(databasePath);
    triggerDatabase.exec(`
      CREATE TRIGGER reject_evaluation_run_delete
      BEFORE DELETE ON evaluation_runs
      WHEN OLD.project_id = 'project-a' AND OLD.run_id = 'run-project-a'
      BEGIN
        SELECT RAISE(ABORT, 'forced run deletion failure');
      END;
    `);
    triggerDatabase.close();

    await assert.rejects(
      store.deleteProject(projectA),
      /forced run deletion failure/u,
    );
    assert.equal(
      (await store.get({ projectId: projectA, runId: "run-project-a" }))?.id,
      "run-project-a",
    );
    assert.equal(
      (
        await store.getRecording({
          projectId: projectA,
          recordingId: "retained-a",
        })
      )?.serialized,
      "recording:retained-a",
    );
    await store.put(run(projectA, "run-after-failed-delete"));
    assert.equal(
      (
        await store.get({
          projectId: projectA,
          runId: "run-after-failed-delete",
        })
      )?.id,
      "run-after-failed-delete",
    );
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem project cleanup fences delayed run, snapshot, and recording writes", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-delete-fence-"),
  );
  const databasePath = path.join(root, "evaluations.sqlite");
  const store = new FilesystemRivetEvaluationRunStore(
    databasePath,
  );
  let reopenedStore: FilesystemRivetEvaluationRunStore | undefined;
  let releaseLateWrite!: () => void;
  let markLateWriteStarted!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseLateWrite = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markLateWriteStarted = resolve;
  });
  try {
    await store.put(run(projectA, "run-before-delete"));
    const lateWrite = (async () => {
      markLateWriteStarted();
      await release;
      return store.put(run(projectA, "run-after-delete"));
    })();
    await started;

    await store.deleteProject(projectA);
    releaseLateWrite();
    await assert.rejects(lateWrite, /after its project was deleted/u);
    await assert.rejects(
      store.putDatasetSnapshot(datasetSnapshot(projectA)),
      /after its project was deleted/u,
    );
    await assert.rejects(
      store.putRecording(recording(projectA, "late-recording", "retained")),
      /after its project was deleted/u,
    );
    assert.deepEqual(await store.list({ projectId: projectA }), []);

    await store.put(run(projectB, "neighbor-run"));
    assert.equal(
      (await store.get({ projectId: projectB, runId: "neighbor-run" }))?.id,
      "neighbor-run",
    );

    await store.dispose();
    reopenedStore = new FilesystemRivetEvaluationRunStore(databasePath);
    await assert.rejects(
      reopenedStore.put(run(projectA, "run-after-restart")),
      /after its project was deleted/u,
    );
    await reopenedStore.put(run(projectB, "neighbor-after-restart"));
  } finally {
    releaseLateWrite();
    await reopenedStore?.dispose();
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disposed filesystem evaluation stores cannot silently reopen their database", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-dispose-"),
  );
  const store = new FilesystemRivetEvaluationRunStore(
    path.join(root, "evaluations.sqlite"),
  );
  try {
    await store.put(run(projectA, "run-a"));
    await Promise.all([store.dispose(), store.dispose()]);
    await assert.rejects(
      store.list({ projectId: projectA }),
      /already disposed/u,
    );
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

type ManagedRecordingRow = {
  projectId: string;
  runId: string;
  artifact: EvaluationRecordingArtifact;
};

/** Small behavioral PostgreSQL double: it models only evaluation SQL used by this test. */
class FakeManagedEvaluationPool {
  readonly recordings = new Map<string, ManagedRecordingRow>();
  readonly runs = new Map<string, EvaluationRun>();
  readonly datasetSnapshots = new Set<string>();

  private key(projectId: unknown, recordingId: unknown): string {
    return `${String(projectId)}:${String(recordingId)}`;
  }

  private removeExpired(projectId: unknown): void {
    for (const [key, row] of this.recordings) {
      if (
        row.projectId === String(projectId) &&
        row.artifact.reference.retention === "temporary" &&
        row.artifact.reference.expiresAt !== undefined &&
        Date.parse(row.artifact.reference.expiresAt) <= Date.now()
      ) {
        this.recordings.delete(key);
      }
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith(
        "delete from evaluation_recordings where project_id = $1 and artifact_json",
      )
    ) {
      this.removeExpired(values[0]);
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("insert into evaluation_recordings")) {
      const projectId = String(values[0]);
      const recordingId = String(values[1]);
      const runId = String(values[2]);
      const incoming = JSON.parse(String(values[3])) as EvaluationRecordingArtifact;
      const key = this.key(projectId, recordingId);
      const existing = this.recordings.get(key);
      if (
        existing !== undefined &&
        (existing.runId !== runId || existing.artifact.trialId !== incoming.trialId)
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (existing !== undefined) {
        incoming.reference = structuredClone(existing.artifact.reference);
      }
      this.recordings.set(key, { projectId, runId, artifact: incoming });
      return {
        rows: [{ recording_id: recordingId } as T],
        rowCount: 1,
      };
    }
    if (
      normalized.startsWith(
        "select artifact_json from evaluation_recordings where project_id = $1 and recording_id = $2",
      )
    ) {
      const row = this.recordings.get(this.key(values[0], values[1]));
      return {
        rows: row === undefined ? [] : [{ artifact_json: row.artifact } as T],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (
      normalized.startsWith(
        "select run_json from evaluation_runs where project_id = $1 and run_id = $2",
      )
    ) {
      const row = this.runs.get(this.key(values[0], values[1]));
      return {
        rows: row === undefined ? [] : [{ run_json: row } as T],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (normalized.startsWith("insert into evaluation_runs")) {
      const projectId = String(values[0]);
      const runId = String(values[1]);
      this.runs.set(
        this.key(projectId, runId),
        JSON.parse(String(values[4])) as EvaluationRun,
      );
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update evaluation_runs set")) {
      const projectId = String(values[0]);
      const runId = String(values[1]);
      this.runs.set(
        this.key(projectId, runId),
        JSON.parse(String(values.at(-1))) as EvaluationRun,
      );
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith(
        "delete from evaluation_recordings where project_id = $1",
      )
    ) {
      const projectId = String(values[0]);
      for (const [key, row] of this.recordings)
        if (row.projectId === projectId) this.recordings.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith(
        "delete from evaluation_dataset_snapshots where project_id = $1",
      )
    ) {
      const projectId = String(values[0]);
      for (const key of this.datasetSnapshots) {
        if (key.startsWith(`${projectId}:`)) this.datasetSnapshots.delete(key);
      }
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("delete from evaluation_runs where project_id = $1")
    ) {
      const projectId = String(values[0]);
      for (const [key, row] of this.runs)
        if (String(row.projectId) === projectId) this.runs.delete(key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected managed evaluation SQL: ${normalized}`);
  }

  async connect() {
    return {
      query: <T = Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ) => this.query<T>(sql, values),
      release() {},
    };
  }
}

test("managed evaluation store applies temporary-artifact cleanup and project scope independently", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationRunStore(pool as unknown as Pool);
  const expiredA = recording(
    projectA,
    "expired-a",
    "temporary",
    "2020-01-01T00:00:00.000Z",
  );
  const currentB = recording(
    projectB,
    "current-b",
    "temporary",
    "2099-01-01T00:00:00.000Z",
  );
  const retainedA = recording(projectA, "retained-a", "retained");
  pool.recordings.set(`${projectA}:expired-a`, {
    projectId: String(projectA),
    runId: expiredA.runId,
    artifact: expiredA,
  });
  pool.recordings.set(`${projectB}:current-b`, {
    projectId: String(projectB),
    runId: currentB.runId,
    artifact: currentB,
  });
  pool.recordings.set(`${projectA}:retained-a`, {
    projectId: String(projectA),
    runId: retainedA.runId,
    artifact: retainedA,
  });
  pool.runs.set(`${projectA}:run-a`, run(projectA, "run-a"));
  pool.runs.set(`${projectB}:run-b`, run(projectB, "run-b"));
  pool.datasetSnapshots.add(`${projectA}:dataset-a`);
  pool.datasetSnapshots.add(`${projectB}:dataset-b`);

  assert.equal(
    await store.getRecording({ projectId: projectA, recordingId: "expired-a" }),
    undefined,
  );
  assert.equal(
    (
      await store.getRecording({
        projectId: projectB,
        recordingId: "current-b",
      })
    )?.serialized,
    "recording:current-b",
  );

  await store.deleteProject(projectA);
  assert.equal(pool.recordings.has(`${projectA}:expired-a`), false);
  assert.equal(pool.recordings.has(`${projectA}:retained-a`), false);
  assert.equal(pool.runs.has(`${projectA}:run-a`), false);
  assert.equal(pool.datasetSnapshots.has(`${projectA}:dataset-a`), false);
  assert.equal(pool.runs.has(`${projectB}:run-b`), true);
  assert.equal(pool.datasetSnapshots.has(`${projectB}:dataset-b`), true);
  assert.equal(
    (
      await store.getRecording({
        projectId: projectB,
        recordingId: "current-b",
      })
    )?.serialized,
    "recording:current-b",
  );
});

test("managed evaluation recording upserts preserve durable retention and reject ID reassignment", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationRunStore(pool as unknown as Pool);
  const provisional = recording(
    projectA,
    "managed-recording",
    "temporary",
    "2099-01-01T00:00:00.000Z",
  );
  await store.putRecording(provisional);
  pool.recordings.get(`${projectA}:managed-recording`)!.artifact.reference = {
    id: "managed-recording",
    retention: "failure",
  };

  await store.putRecording(provisional);
  assert.deepEqual(
    pool.recordings.get(`${projectA}:managed-recording`)?.artifact.reference,
    { id: "managed-recording", retention: "failure" },
  );
  await assert.rejects(
    store.putRecording({ ...provisional, runId: "another-run" }),
    /cannot be reassigned/u,
  );
});

test("managed evaluation store preserves user-assigned names across snapshots", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationRunStore(pool as unknown as Pool);
  const initial = run(projectA, "named-managed-run");
  await store.put(initial);
  assert.equal(
    (await store.updateRunName({
      projectId: projectA,
      runId: initial.id,
      name: "  Candidate  ",
    }))?.name,
    "Candidate",
  );
  await store.put({ ...initial, revision: 1 });
  assert.equal(
    (await store.get({ projectId: projectA, runId: initial.id }))?.name,
    "Candidate",
  );
  assert.equal(
    (await store.updateRunName({
      projectId: projectA,
      runId: "missing-managed-run",
      name: "Ignored",
    })),
    undefined,
  );
});
test("managed evaluation store normalizes legacy run history at its read boundary", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationRunStore(pool as unknown as Pool);
  pool.runs.set(
    `${projectA}:legacy-managed-run`,
    legacyRun(projectA, "legacy-managed-run"),
  );

  const normalized = await store.get({
    projectId: projectA,
    runId: "legacy-managed-run",
  });
  assert.equal(normalized?.version, 2);
  assert.equal(normalized?.purpose, "evaluation");
  assert.equal(normalized?.qualityStatus, "not-evaluated");
  assert.equal(normalized?.accountingStatus, "complete");
  assert.equal("verdict" in (normalized ?? {}), false);
  assert.equal("status" in (normalized?.trials[0] ?? {}), false);
  assert.deepEqual(normalized?.thresholdResults, []);
});
