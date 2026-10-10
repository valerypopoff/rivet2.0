import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { Pool, PoolClient } from "pg";
import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  fingerprintEvaluationDataset,
  normalizeEvaluationLibrary,
  normalizeEvaluationRun,
  type EvaluationDatasetSnapshot,
  type EvaluationLibrary,
  type EvaluationLibrarySyncIssue,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
} from "@valerypopoff/rivet2-evaluations";

import { FilesystemRivetEvaluationStore } from "../evaluation-runs/filesystem-store.js";
import {
  applyCheckedEvaluationLibraryMutation,
  EvaluationLibraryResourceConflictError,
  getEvaluationLibraryResourceVersions,
  type RivetStudioEvaluationStore,
} from "../evaluation-runs/store.js";
import { PostgresRivetEvaluationStore } from "../evaluation-runs/managed-store.js";
import {
  evaluationRecordingSchema,
  evaluationRunSchema,
  hostedSubmissionSchema,
  MAX_EVALUATION_RECORDING_BYTES,
} from "../routes/workflows/evaluation-runs.js";
import { createHttpEvaluationStore } from "../../../studio-server-shared/evaluationRunHttpStore.js";
import { createApiApp } from "../app.js";
import { evaluationHistoryPageQuery, type EvaluationHistoryRow } from "../evaluation-runs/history-page.js";

const projectA = "project-a" as ProjectId;
const projectB = "project-b" as ProjectId;

test("history cursors use verified SQL identities and preserve legacy normalization", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const legacy = legacyRun(projectA, "legacy-page");
    const row = {
      run_id: legacy.id,
      project_id: String(projectA),
      suite_id: legacy.suiteId,
      started_at: dialect === "postgres" ? new Date(legacy.startedAt) : legacy.startedAt,
      summary_json: JSON.stringify(legacy),
    };
    const query = evaluationHistoryPageQuery(dialect, { projectId: projectA, limit: 1 });
    const page = query.page([row, row]);
    assert.equal(page.runs[0]?.qualityStatus, "not-evaluated");
    assert.equal("trials" in page.runs[0]!, false);
    assert.equal(page.nextCursor !== undefined, true);
    for (const corrupted of [
      { ...row, run_id: "wrong" },
      { ...row, suite_id: "wrong" },
      { ...row, project_id: String(projectB) },
      { ...row, started_at: "2000-01-01T00:00:00.000Z" },
    ]) {
      assert.throws(() => query.page([corrupted]), /Invalid evaluation history metadata/);
    }
  }
});

test("history cursors preserve the exact database timestamp, not its JSON spelling or Date precision", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const value = run(projectA, "cursor-precision");
    const storedTimestamp =
      dialect === "postgres"
        ? "2026-01-01T00:00:00.000123Z"
        : "2026-01-01T00:00:00Z";
    const row = {
      run_id: value.id,
      project_id: String(projectA),
      suite_id: value.suiteId,
      // A non-ISO PostgreSQL DateStyle can defeat pg's built-in Date parser.
      // The explicitly formatted SQL value owns validation and pagination.
      started_at: dialect === "postgres" ? new Date(Number.NaN) : storedTimestamp,
      started_at_cursor: storedTimestamp,
      summary_json: JSON.stringify({ ...value, startedAt: "2026-01-01T00:00:00.000Z" }),
    };
    const query = evaluationHistoryPageQuery(dialect, { projectId: projectA, limit: 1 });
    const page = query.page([row, row]);
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    assert.equal(cursor[2], storedTimestamp);
    const next = evaluationHistoryPageQuery(dialect, { projectId: projectA, after: page.nextCursor });
    assert.equal(next.values[1], storedTimestamp);
  }
});

test("SQLite history pagination does not omit equivalent differently formatted timestamps", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE evaluation_runs (run_id TEXT, project_id TEXT, suite_id TEXT, started_at TEXT, run_json TEXT)",
    );
    for (const id of ["a", "b", "c"]) {
      database.prepare("INSERT INTO evaluation_runs VALUES (?, ?, ?, ?, ?)").run(
        id,
        String(projectA),
        "suite",
        "2026-01-01T00:00:00Z",
        JSON.stringify({ ...run(projectA, id), startedAt: "2026-01-01T00:00:00.000Z" }),
      );
    }
    let after: string | undefined;
    const ids: string[] = [];
    do {
      const query = evaluationHistoryPageQuery("sqlite", { projectId: projectA, limit: 1, after });
      const rows = database
        .prepare(query.sql)
        .all(...(query.values as (string | number)[])) as unknown as EvaluationHistoryRow[];
      const page = query.page(rows);
      ids.push(...page.runs.map((value) => value.id));
      after = page.nextCursor;
    } while (after && ids.length < 5);
    assert.deepEqual(ids, ["c", "b", "a"]);
  } finally {
    database.close();
  }
});

test("evaluation history pages are compact, stable across equal timestamps and scoped", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluation-pages-"),
  );
  const store = new FilesystemRivetEvaluationStore(
    path.join(root, "history.sqlite"),
  );
  try {
    for (let index = 0; index < 6; index++)
      await store.put(run(projectA, `run-${index}`));
    await store.put(run(projectB, "foreign-run"));
    const first = await store.listPage({
      projectId: projectA,
      suiteId: "suite",
      limit: 2,
    });
    assert.deepEqual(
      first.runs.map((run) => run.id),
      ["run-5", "run-4"],
    );
    assert.equal("trials" in first.runs[0]!, false);
    assert.equal("provenance" in first.runs[0]!, false);
    const second = await store.listPage({
      projectId: projectA,
      suiteId: "suite",
      limit: 2,
      after: first.nextCursor,
    });
    assert.deepEqual(
      second.runs.map((run) => run.id),
      ["run-3", "run-2"],
    );
    const last = await store.listPage({
      projectId: projectA,
      suiteId: "suite",
      limit: 2,
      after: second.nextCursor,
    });
    assert.deepEqual(
      last.runs.map((run) => run.id),
      ["run-1", "run-0"],
    );
    assert.equal(last.nextCursor, undefined);
    assert.equal(
      (await store.get({ projectId: projectA, runId: "run-5" }))?.trials.length,
      1,
    );
    await assert.rejects(
      store.listPage({
        projectId: projectB,
        suiteId: "suite",
        after: first.nextCursor,
      }),
      /cursor/,
    );
    await assert.rejects(
      store.listPage({
        projectId: projectA,
        suiteId: "other",
        after: first.nextCursor,
      }),
      /cursor/,
    );
    await assert.rejects(
      store.listPage({ projectId: projectA, limit: 1000 }),
      /page size/,
    );
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

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

function library(
  suiteId = "library-suite",
  datasetId = "library-dataset",
): EvaluationLibrary {
  return {
    version: 1,
    data: {
      version: 1,
      suites: [
        {
          id: suiteId,
          name: `Suite ${suiteId}`,
          targetGraphId:
            "target-graph" as EvaluationLibrary["data"]["suites"][number]["targetGraphId"],
          datasetId,
          inputBindings: [],
          assertions: [],
          evaluators: [],
        },
      ],
      baselines: [],
    },
    datasets: [
      {
        id: datasetId,
        name: `Dataset ${datasetId}`,
        fields: [
          {
            id: "input",
            name: "Input",
            dataType: "string",
            role: "input",
          },
        ],
        cases: [
          {
            id: "case",
            name: "Case",
            values: { input: "hello" },
          },
        ],
      },
    ],
    migratedLegacyProjectIds: [],
  };
}

async function assertCompleteEvaluationStoreContract(
  store: RivetStudioEvaluationStore,
): Promise<void> {
  assert.deepEqual(await store.getLibrarySnapshot(), {
    revision: 0,
    library: {
      version: 1,
      data: { version: 1, suites: [], baselines: [] },
      datasets: [],
      migratedLegacyProjectIds: [],
    },
  });

  const imported = await store.importLegacyLibrary({
    sourceFingerprint: "legacy-library-a",
    library: library(),
  });
  assert.equal(imported.revision, 1);
  assert.equal(imported.library.data.suites[0]?.id, "library-suite");

  const duplicateImport = await store.importLegacyLibrary({
    sourceFingerprint: "legacy-library-a",
    library: library(),
  });
  assert.equal(duplicateImport.revision, 1);

  const secondLibrary = library("second-suite", "second-dataset");
  secondLibrary.data.suites.unshift({
    ...library().data.suites[0]!,
    name: "A stale browser copy must not replace the server suite",
  });
  secondLibrary.datasets.unshift({
    ...library().datasets[0]!,
    name: "A stale browser copy must not replace the server dataset",
  });
  const merged = await store.importLegacyLibrary({
    sourceFingerprint: "legacy-library-b",
    library: secondLibrary,
  });
  assert.equal(merged.revision, 2);
  assert.deepEqual(
    merged.library.data.suites.map((suite) => suite.name),
    ["Suite library-suite", "Suite second-suite"],
  );
  assert.deepEqual(
    merged.library.datasets.map((dataset) => dataset.name),
    ["Dataset library-dataset", "Dataset second-dataset"],
  );

  await assert.rejects(
    store.replaceLibrary({
      expectedRevision: 1,
      library: merged.library,
    }),
    /changed in another browser/u,
  );
  const replaced = await store.replaceLibrary({
    expectedRevision: merged.revision,
    library: {
      ...merged.library,
      migratedLegacyProjectIds: [projectA],
    },
  });
  assert.equal(replaced.revision, 3);
  const unchanged = await store.replaceLibrary({
    expectedRevision: replaced.revision,
    library: replaced.library,
  });
  assert.equal(unchanged.revision, replaced.revision);
  assert.deepEqual((await store.getLibrary()).migratedLegacyProjectIds, [
    projectA,
  ]);

  // Two browsers may start from the same snapshot and safely edit different
  // resources. Only a stale write to the same resource must conflict.
  const browserA = await store.getLibrarySyncSnapshot();
  const browserB = await store.getLibrarySyncSnapshot();
  const dataset = browserA.library.datasets.find((candidate) => candidate.id === "second-dataset");
  const suite = browserB.library.data.suites.find((candidate) => candidate.id === "second-suite");
  assert.ok(dataset);
  assert.ok(suite);
  const afterDatasetEdit = await store.mutateLibrary({
    changes: [
      {
        kind: "put-dataset",
        id: dataset.id,
        expectedVersion: browserA.resourceVersions.datasets[dataset.id]!,
        dataset: { ...dataset, name: "Dataset updated by browser A" },
      },
    ],
  });
  const afterSuiteEdit = await store.mutateLibrary({
    changes: [
      {
        kind: "put-suite",
        id: suite.id,
        expectedVersion: browserB.resourceVersions.suites[suite.id]!,
        suite: { ...suite, name: "Suite updated by browser B" },
        baselines: browserB.library.data.baselines.filter((baseline) => baseline.suiteId === suite.id),
      },
    ],
  });
  assert.equal(afterSuiteEdit.library.datasets.find((candidate) => candidate.id === dataset.id)?.name, "Dataset updated by browser A");
  assert.equal(afterSuiteEdit.library.data.suites.find((candidate) => candidate.id === suite.id)?.name, "Suite updated by browser B");
  await assert.rejects(
    store.mutateLibrary({
      changes: [
        {
          kind: "put-dataset",
          id: dataset.id,
          expectedVersion: browserA.resourceVersions.datasets[dataset.id]!,
          dataset: { ...dataset, name: "Stale browser A edit" },
        },
      ],
    }),
    (error: unknown) => error instanceof EvaluationLibraryResourceConflictError,
  );
  assert.equal(afterDatasetEdit.revision < afterSuiteEdit.revision, true);

  const finalized = run(projectA, "checkpoint-run");
  const started: EvaluationRun = {
    ...finalized,
    revision: 1,
    completedAt: undefined,
    executionStatus: "running",
    qualityStatus: "not-evaluated",
    qualityReason: { code: "in-progress", message: "Evaluation is running." },
    accountingStatus: "partial",
    aggregate: undefined,
    trials: [],
  };
  await store.applyRunEvent({ type: "run-started", revision: 1, run: started });
  const settledEvent = {
    type: "trial-settled" as const,
    revision: 2,
    runId: started.id,
    projectId: projectA,
    suiteId: started.suiteId,
    requestedTrialCount: 1,
    settledTrialCount: 1,
    trial: finalized.trials[0]!,
  };
  await store.applyRunEvent(settledEvent);
  await store.applyRunEvent(settledEvent);
  const checkpoint = await store.get({
    projectId: projectA,
    runId: started.id,
  });
  assert.equal(checkpoint?.revision, 2);
  assert.equal(checkpoint?.trials.length, 1);
  await assert.rejects(
    store.applyRunEvent({
      ...settledEvent,
      revision: 3,
      suiteId: "other-suite",
    }),
    /does not match its suite/u,
  );

  await store.updateRunName({
    projectId: projectA,
    runId: started.id,
    name: "Checkpoint baseline",
  });
  await store.applyRunEvent({
    type: "run-finalized",
    revision: 3,
    run: { ...finalized, revision: 3 },
  });
  const completed = await store.get({ projectId: projectA, runId: started.id });
  assert.equal(completed?.executionStatus, "completed");
  assert.equal(completed?.name, "Checkpoint baseline");
  assert.equal(completed?.trials.length, 1);
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

test("hosted Evaluation submission preserves the immutable normal-dataset sidecar", () => {
  const submission = {
    projectContents: "---\nmetadata: {}\n",
    projectPath: "tests/evaluation.rivet-project",
    datasetsContents: "version: 1\ndatasets: []\n",
    evaluationData: { version: 1, suites: [], baselines: [] },
    dataset: { id: "dataset", name: "Dataset", fields: [], cases: [] },
    suiteId: "suite",
    purpose: "evaluation",
    contextValues: { profile: { type: "string", value: "production" } },
  };
  assert.equal(hostedSubmissionSchema.safeParse(submission).success, true);
  assert.equal(
    hostedSubmissionSchema.safeParse({ ...submission, datasetsContents: "" }).success,
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

  const nonAsciiPayload = "€".repeat(
    Math.floor(MAX_EVALUATION_RECORDING_BYTES / 3) + 1,
  );
  assert.equal(nonAsciiPayload.length < MAX_EVALUATION_RECORDING_BYTES, true);
  assert.equal(
    evaluationRecordingSchema.safeParse({
      ...artifact,
      serialized: nonAsciiPayload,
    }).success,
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
    const store = createHttpEvaluationStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
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
    const store = createHttpEvaluationStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    const renamed = await store.updateRunName({
      projectId: projectA,
      runId: "renamed-http-run",
      name: "  Baseline  ",
    });
    assert.equal(renamed?.name, "Baseline");
    assert.equal(
      request?.url,
      "/api/workflows/evaluation-runs/renamed-http-run",
    );
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

test('hosted HTTP evaluation store returns confirmed recording-retention outcomes', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let request: { url: string; init: RequestInit | undefined } | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://rivet.example' } },
  });
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ updated: false });
  };
  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    assert.equal(
      await store.updateRecordingRetention({
        projectId: projectA,
        recordingId: 'missing-recording',
        retention: 'retained',
      }),
      false,
    );
    assert.equal(request?.url, '/api/workflows/evaluation-runs/recordings/missing-recording');
    assert.equal(request?.init?.method, 'PATCH');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("hosted HTTP evaluation store migrates legacy libraries and serializes writes", async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(undefined);
  const expectedRevisions: number[] = [];
  let importRequests = 0;
  let importClientId: string | null = null;

  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), "https://rivet.example");
    const method = init?.method ?? "GET";
    if (requestUrl.pathname.endsWith("/library/import") && method === "POST") {
      importRequests += 1;
      importClientId = new Headers(init?.headers).get('x-rivet-evaluation-library-client-id');
      const body = JSON.parse(String(init?.body)) as {
        library: EvaluationLibrary;
      };
      currentLibrary = normalizeEvaluationLibrary(body.library);
      revision += 1;
      return Response.json({ revision, library: currentLibrary });
    }
    if (requestUrl.pathname.endsWith("/library") && method === "GET") {
      return Response.json({ revision, library: currentLibrary });
    }
    if (requestUrl.pathname.endsWith("/library") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as {
        expectedRevision: number;
        library: EvaluationLibrary;
      };
      expectedRevisions.push(body.expectedRevision);
      if (body.expectedRevision !== revision) {
        return Response.json(
          { error: "The evaluation library changed in another browser." },
          { status: 409 },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      currentLibrary = normalizeEvaluationLibrary(body.library);
      revision += 1;
      return Response.json({ revision, library: currentLibrary });
    }
    throw new Error(
      `Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`,
    );
  };

  try {
    const legacyLibrary = library("legacy-suite", "legacy-dataset");
    const store = createHttpEvaluationStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
      legacyLibrarySource: {
        async getLibrary() {
          return legacyLibrary;
        },
      },
    });

    await store.initialize?.();
    assert.equal(importRequests, 1);
    assert.ok(importClientId);
    assert.equal((await store.getLibrary()).data.suites[0]?.id, "legacy-suite");

    const second = library("second-http-suite", "second-http-dataset");
    const third = library("third-http-suite", "third-http-dataset");
    await Promise.all([store.putLibrary(second), store.putLibrary(third)]);

    assert.deepEqual(expectedRevisions, [1, 2]);
    assert.equal(revision, 3);
    assert.equal(
      (await store.getLibrary()).data.suites[0]?.id,
      "third-http-suite",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted HTTP evaluation stores merge different-resource browser edits and reject only overlaps", async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), "https://rivet.example");
    const method = init?.method ?? "GET";
    if (requestUrl.pathname.endsWith("/library") && method === "GET") return Response.json(snapshot());
    if (requestUrl.pathname.endsWith("/library/mutations") && method === "POST") {
      const mutation = JSON.parse(String(init?.body));
      try {
        const result = applyCheckedEvaluationLibraryMutation(currentLibrary, mutation);
        if (result.changed) {
          currentLibrary = result.library;
          revision += 1;
        }
        return Response.json(snapshot());
      } catch (error) {
        if (!(error instanceof EvaluationLibraryResourceConflictError)) throw error;
        return Response.json(
          { error: error.message, conflicts: error.conflicts, snapshot: snapshot() },
          { status: 409 },
        );
      }
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const options = {
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    };
    const browserA = createHttpEvaluationStore(options);
    const browserB = createHttpEvaluationStore(options);
    await Promise.all([browserA.initialize?.(), browserB.initialize?.()]);
    const aLibrary = await browserA.getLibrary();
    const bLibrary = await browserB.getLibrary();

    await browserA.putLibrary({
      ...aLibrary,
      data: {
        ...aLibrary.data,
        suites: aLibrary.data.suites.map((suite) =>
          suite.id === "library-suite" ? { ...suite, name: "Suite edited by A" } : suite,
        ),
      },
    });
    await browserB.putLibrary({
      ...bLibrary,
      datasets: bLibrary.datasets.map((dataset) =>
        dataset.id === "library-dataset" ? { ...dataset, name: "Dataset edited by B" } : dataset,
      ),
    });
    assert.equal(currentLibrary.data.suites[0]?.name, "Suite edited by A");
    assert.equal(currentLibrary.datasets[0]?.name, "Dataset edited by B");

    const browserC = createHttpEvaluationStore(options);
    const browserD = createHttpEvaluationStore(options);
    await Promise.all([browserC.initialize?.(), browserD.initialize?.()]);
    let browserDIssue: EvaluationLibrarySyncIssue | undefined;
    const unsubscribeBrowserDIssue = browserD.subscribeLibrarySyncIssue?.((issue) => {
      browserDIssue = issue;
    });
    const cLibrary = await browserC.getLibrary();
    const dLibrary = await browserD.getLibrary();
    await browserC.putLibrary({
      ...cLibrary,
      data: {
        ...cLibrary.data,
        suites: cLibrary.data.suites.map((suite) => ({ ...suite, name: "Suite edited by C" })),
      },
    });
    await assert.rejects(
      browserD.putLibrary({
        ...dLibrary,
        data: {
          ...dLibrary.data,
          suites: dLibrary.data.suites.map((suite) => ({ ...suite, name: "Conflicting suite edit by D" })),
        },
      }),
      (error: unknown) => error instanceof Error && /changed in another browser/u.test(error.message),
    );
    assert.equal(browserDIssue?.kind, 'conflict');
    const dConflict = browserDIssue?.kind === 'conflict' ? browserDIssue.conflicts[0] : undefined;
    assert.ok(dConflict?.server.kind === 'suite' && dConflict.local.kind === 'suite');
    assert.equal(dConflict.server.value?.suite.name, 'Suite edited by C');
    assert.equal(dConflict.local.value?.suite.name, 'Conflicting suite edit by D');
    const copied = await browserD.resolveLibraryConflict!({
      issueId: browserDIssue!.id,
      kind: 'suite',
      id: 'library-suite',
      action: 'keep-mine-as-copy',
    });
    assert.equal(copied.data.suites.find((suite) => suite.id === 'library-suite')?.name, 'Suite edited by C');
    assert.equal(copied.data.suites.find((suite) => suite.id === 'library-suite-copy')?.name, 'Conflicting suite edit by D (copy)');
    assert.equal(currentLibrary.data.suites.find((suite) => suite.id === 'library-suite')?.name, 'Suite edited by C');
    assert.equal(currentLibrary.data.suites.find((suite) => suite.id === 'library-suite-copy')?.name, 'Conflicting suite edit by D (copy)');
    unsubscribeBrowserDIssue?.();

    const browserE = createHttpEvaluationStore(options);
    const browserF = createHttpEvaluationStore(options);
    await Promise.all([browserE.initialize?.(), browserF.initialize?.()]);
    let browserFIssue: EvaluationLibrarySyncIssue | undefined;
    browserF.subscribeLibrarySyncIssue?.((issue) => {
      browserFIssue = issue;
    });
    const eLibrary = await browserE.getLibrary();
    const fLibrary = await browserF.getLibrary();
    await browserE.putLibrary({
      ...eLibrary,
      data: {
        ...eLibrary.data,
        suites: eLibrary.data.suites.map((suite) =>
          suite.id === 'library-suite' ? { ...suite, name: 'Suite edited by E' } : suite,
        ),
      },
    });
    await assert.rejects(
      browserF.putLibrary({
        ...fLibrary,
        data: {
          ...fLibrary.data,
          suites: fLibrary.data.suites.map((suite) =>
            suite.id === 'library-suite' ? { ...suite, name: 'Conflicting suite edit by F' } : suite,
          ),
        },
      }),
      (error: unknown) => error instanceof Error && /changed in another browser/u.test(error.message),
    );
    const serverVersion = await browserF.resolveLibraryConflict!({
      issueId: browserFIssue!.id,
      kind: 'suite',
      id: 'library-suite',
      action: 'use-server',
    });
    assert.equal(serverVersion.data.suites.find((suite) => suite.id === 'library-suite')?.name, 'Suite edited by E');
    assert.equal(currentLibrary.data.suites.find((suite) => suite.id === 'library-suite')?.name, 'Suite edited by E');

    const browserG = createHttpEvaluationStore(options);
    const browserH = createHttpEvaluationStore(options);
    await Promise.all([browserG.initialize?.(), browserH.initialize?.()]);
    let browserHIssue: EvaluationLibrarySyncIssue | undefined;
    browserH.subscribeLibrarySyncIssue?.((issue) => {
      browserHIssue = issue;
    });
    const gLibrary = await browserG.getLibrary();
    const hLibrary = await browserH.getLibrary();
    await browserG.putLibrary({
      ...gLibrary,
      datasets: gLibrary.datasets.map((dataset) =>
        dataset.id === 'library-dataset' ? { ...dataset, name: 'Server dataset version' } : dataset,
      ),
    });
    await assert.rejects(
      browserH.putLibrary({
        ...hLibrary,
        data: {
          ...hLibrary.data,
          suites: hLibrary.data.suites.map((suite) =>
            suite.id === 'library-suite' ? { ...suite, name: 'Local existing suite edit' } : suite,
          ),
        },
        datasets: hLibrary.datasets.map((dataset) =>
          dataset.id === 'library-dataset' ? { ...dataset, name: 'Local dataset version' } : dataset,
        ),
      }),
      /changed in another browser/u,
    );
    const copiedDataset = await browserH.resolveLibraryConflict!({
      issueId: browserHIssue!.id,
      kind: 'dataset',
      id: 'library-dataset',
      action: 'keep-mine-as-copy',
    });
    assert.equal(copiedDataset.datasets.find((dataset) => dataset.id === 'library-dataset-copy')?.name, 'Local dataset version (copy)');
    assert.equal(copiedDataset.data.suites.find((suite) => suite.id === 'library-suite')?.datasetId, 'library-dataset');
    assert.equal(currentLibrary.data.suites.find((suite) => suite.id === 'library-suite')?.datasetId, 'library-dataset');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation stores preserve each queued conflict until it is resolved', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  let blockNextMutation = false;
  let releaseBlockedMutation: (() => void) | undefined;
  let signalBlockedMutation: (() => void) | undefined;
  const blockedMutationStarted = new Promise<void>((resolve) => {
    signalBlockedMutation = resolve;
  });
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') return Response.json(snapshot());
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      if (blockNextMutation) {
        blockNextMutation = false;
        signalBlockedMutation!();
        await new Promise<void>((resolve) => {
          releaseBlockedMutation = resolve;
        });
      }
      try {
        const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
        if (result.changed) {
          currentLibrary = result.library;
          revision += 1;
        }
        return Response.json(snapshot());
      } catch (error) {
        if (!(error instanceof EvaluationLibraryResourceConflictError)) throw error;
        return Response.json(
          { error: error.message, conflicts: error.conflicts, snapshot: snapshot() },
          { status: 409 },
        );
      }
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const options = {
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    };
    const writer = createHttpEvaluationStore(options);
    const staleBrowser = createHttpEvaluationStore(options);
    await Promise.all([writer.initialize?.(), staleBrowser.initialize?.()]);

    const writerLibrary = await writer.getLibrary();
    await writer.putLibrary({
      ...writerLibrary,
      data: {
        ...writerLibrary.data,
        suites: writerLibrary.data.suites.map((suite) => ({ ...suite, name: 'Server suite' })),
      },
      datasets: writerLibrary.datasets.map((dataset) => ({ ...dataset, name: 'Server dataset' })),
    });

    let issue: EvaluationLibrarySyncIssue | undefined;
    staleBrowser.subscribeLibrarySyncIssue?.((next) => {
      issue = next;
    });
    const staleLibrary = await staleBrowser.getLibrary();
    blockNextMutation = true;
    const firstWrite = staleBrowser.putLibrary({
      ...staleLibrary,
      data: {
        ...staleLibrary.data,
        suites: staleLibrary.data.suites.map((suite) => ({ ...suite, name: 'Local suite' })),
      },
    });
    const firstRejection = assert.rejects(firstWrite, /changed in another browser/u);
    await blockedMutationStarted;

    const locallyUpdated = await staleBrowser.getLibrary();
    const secondWrite = staleBrowser.putLibrary({
      ...locallyUpdated,
      datasets: locallyUpdated.datasets.map((dataset) => ({ ...dataset, name: 'Local dataset' })),
    });
    const secondRejection = assert.rejects(secondWrite, /changed in another browser/u);
    releaseBlockedMutation!();
    await firstRejection;

    assert.equal(issue?.kind, 'conflict');
    assert.equal(issue?.kind === 'conflict' ? issue.conflicts[0]?.kind : undefined, 'suite');
    const suiteIssue = issue!;
    await staleBrowser.resolveLibraryConflict!({
      issueId: suiteIssue.id,
      kind: 'suite',
      id: 'library-suite',
      action: 'use-server',
    });
    await secondRejection;

    assert.equal(issue?.kind, 'conflict');
    assert.equal(issue?.kind === 'conflict' ? issue.conflicts[0]?.kind : undefined, 'dataset');
    await staleBrowser.resolveLibraryConflict!({
      issueId: issue!.id,
      kind: 'dataset',
      id: 'library-dataset',
      action: 'use-server',
    });
    assert.equal(issue, undefined);
    assert.equal(currentLibrary.data.suites[0]?.name, 'Server suite');
    assert.equal(currentLibrary.datasets[0]?.name, 'Server dataset');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation store copies only the newest queued edit for one conflicting resource', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  let blockNextMutation = false;
  let releaseBlockedMutation: (() => void) | undefined;
  let signalBlockedMutation: (() => void) | undefined;
  const blockedMutationStarted = new Promise<void>((resolve) => {
    signalBlockedMutation = resolve;
  });
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') return Response.json(snapshot());
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      if (blockNextMutation) {
        blockNextMutation = false;
        signalBlockedMutation!();
        await new Promise<void>((resolve) => {
          releaseBlockedMutation = resolve;
        });
      }
      try {
        const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
        if (result.changed) {
          currentLibrary = result.library;
          revision += 1;
        }
        return Response.json(snapshot());
      } catch (error) {
        if (!(error instanceof EvaluationLibraryResourceConflictError)) throw error;
        return Response.json(
          { error: error.message, conflicts: error.conflicts, snapshot: snapshot() },
          { status: 409 },
        );
      }
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const options = {
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    };
    const writer = createHttpEvaluationStore(options);
    const staleBrowser = createHttpEvaluationStore(options);
    await Promise.all([writer.initialize?.(), staleBrowser.initialize?.()]);
    const serverLibrary = await writer.getLibrary();
    await writer.putLibrary({
      ...serverLibrary,
      data: {
        ...serverLibrary.data,
        suites: serverLibrary.data.suites.map((suite) => ({ ...suite, name: 'Server suite' })),
      },
    });

    let issue: EvaluationLibrarySyncIssue | undefined;
    staleBrowser.subscribeLibrarySyncIssue?.((next) => {
      issue = next;
    });
    const staleLibrary = await staleBrowser.getLibrary();
    blockNextMutation = true;
    const firstWrite = staleBrowser.putLibrary({
      ...staleLibrary,
      data: {
        ...staleLibrary.data,
        suites: staleLibrary.data.suites.map((suite) => ({ ...suite, name: 'Intermediate local suite' })),
      },
    });
    const firstRejection = assert.rejects(firstWrite, /changed in another browser/u);
    await blockedMutationStarted;

    const locallyUpdated = await staleBrowser.getLibrary();
    const secondWrite = staleBrowser.putLibrary({
      ...locallyUpdated,
      data: {
        ...locallyUpdated.data,
        suites: locallyUpdated.data.suites.map((suite) => ({ ...suite, name: 'Newest local suite' })),
      },
    });
    const secondRejection = assert.rejects(secondWrite, /changed in another browser/u);
    releaseBlockedMutation!();
    await Promise.all([firstRejection, secondRejection]);

    assert.equal(issue?.kind, 'conflict');
    const latestConflict = issue?.kind === 'conflict' ? issue.conflicts[0] : undefined;
    assert.equal(latestConflict?.local.kind, 'suite');
    assert.equal(
      latestConflict?.local.kind === 'suite' ? latestConflict.local.value?.suite.name : undefined,
      'Newest local suite',
    );
    const copied = await staleBrowser.resolveLibraryConflict!({
      issueId: issue!.id,
      kind: 'suite',
      id: 'library-suite',
      action: 'keep-mine-as-copy',
    });
    assert.equal(issue, undefined);
    assert.equal(copied.data.suites.find((suite) => suite.id === 'library-suite')?.name, 'Server suite');
    assert.equal(copied.data.suites.find((suite) => suite.id === 'library-suite-copy')?.name, 'Newest local suite (copy)');
    assert.equal(currentLibrary.data.suites.find((suite) => suite.id === 'library-suite-copy')?.name, 'Newest local suite (copy)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation store retains retryable local edits without presenting them as conflicts', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let attempts = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') return Response.json(snapshot());
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: 'Temporary storage outage' }, { status: 503 });
      const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
      if (result.changed) {
        currentLibrary = result.library;
        revision += 1;
      }
      return Response.json(snapshot());
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    await store.initialize?.();
    let issue: EvaluationLibrarySyncIssue | undefined;
    store.subscribeLibrarySyncIssue?.((next) => {
      issue = next;
    });
    const before = await store.getLibrary();
    await assert.rejects(
      store.putLibrary({
        ...before,
        datasets: before.datasets.map((dataset) => ({ ...dataset, name: 'Locally retained during retry' })),
      }),
      /Temporary storage outage/u,
    );
    assert.equal(issue?.kind, 'retryable');
    assert.equal((await store.getLibrary()).datasets[0]?.name, 'Locally retained during retry');
    assert.equal(currentLibrary.datasets[0]?.name, 'Dataset library-dataset');

    const resolved = await store.retryLibrarySync!();
    assert.equal(resolved.datasets[0]?.name, 'Locally retained during retry');
    assert.equal(currentLibrary.datasets[0]?.name, 'Locally retained during retry');
    assert.equal(issue, undefined);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation store recovers from a bare conflict response without an unresolvable dialog', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let mutationAttempts = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') return Response.json(snapshot());
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      mutationAttempts += 1;
      if (mutationAttempts === 1) return Response.json({ error: 'Stale proxy conflict' }, { status: 409 });
      const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
      if (result.changed) {
        currentLibrary = result.library;
        revision += 1;
      }
      return Response.json(snapshot());
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    await store.initialize?.();
    let issue: EvaluationLibrarySyncIssue | undefined;
    store.subscribeLibrarySyncIssue?.((next) => {
      issue = next;
    });
    const before = await store.getLibrary();
    await assert.rejects(
      store.putLibrary({
        ...before,
        datasets: before.datasets.map((dataset) => ({ ...dataset, name: 'Saved after bare conflict' })),
      }),
      /Stale proxy conflict/u,
    );
    assert.equal(issue?.kind, 'failed');

    const resolved = await store.retryLibrarySync!();
    assert.equal(resolved.datasets[0]?.name, 'Saved after bare conflict');
    assert.equal(currentLibrary.datasets[0]?.name, 'Saved after bare conflict');
    assert.equal(issue, undefined);
    assert.equal(mutationAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation store never lets a delayed refresh roll back a newer mutation', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  let holdNextLibraryRead = false;
  let releaseRead: (() => void) | undefined;
  let signalRead: (() => void) | undefined;
  const delayedReadStarted = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') {
      const response = snapshot();
      if (holdNextLibraryRead) {
        holdNextLibraryRead = false;
        signalRead!();
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      return Response.json(response);
    }
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
      if (result.changed) {
        currentLibrary = result.library;
        revision += 1;
      }
      return Response.json(snapshot());
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    await store.initialize?.();
    const before = await store.getLibrary();
    holdNextLibraryRead = true;
    const delayedRefresh = store.getLibrarySyncSnapshot!();
    await delayedReadStarted;

    await store.putLibrary({
      ...before,
      datasets: before.datasets.map((dataset) => ({ ...dataset, name: 'Saved after refresh began' })),
    });
    releaseRead!();
    await delayedRefresh;

    assert.equal((await store.getLibrary()).datasets[0]?.name, 'Saved after refresh began');
    assert.equal(currentLibrary.datasets[0]?.name, 'Saved after refresh began');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted HTTP evaluation invalidations are external, revisioned, and never recurse through refreshes', async () => {
  const originalFetch = globalThis.fetch;
  const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let revision = 0;
  let currentLibrary = normalizeEvaluationLibrary(library());
  let clientId: string | null = null;
  let libraryReads = 0;

  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
    constructor(_url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      const callbacks = this.listeners.get(type) ?? [];
      callbacks.push(listener as unknown as (event: { data: string }) => void);
      this.listeners.set(type, callbacks);
    }
    close(): void {}
    emit(type: string, value: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) });
    }
  }

  const snapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: getEvaluationLibraryResourceVersions(currentLibrary),
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') {
      libraryReads += 1;
      return Response.json(snapshot());
    }
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      clientId = new Headers(init?.headers).get('x-rivet-evaluation-library-client-id');
      const result = applyCheckedEvaluationLibraryMutation(currentLibrary, JSON.parse(String(init?.body)));
      if (result.changed) {
        currentLibrary = result.library;
        revision += 1;
      }
      return Response.json(snapshot());
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    value: FakeEventSource,
  });

  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    await store.initialize?.();
    const invalidations: Array<{ epoch: string; revision: number }> = [];
    const unsubscribe = store.subscribeLibraryInvalidation?.((event) => invalidations.push(event));
    const stream = FakeEventSource.instances[0];
    assert.ok(stream);

    stream.emit('library-state', { epoch: 'epoch-a', revision });
    assert.deepEqual(invalidations, []);

    await store.getLibrarySyncSnapshot!();
    assert.deepEqual(invalidations, []);

    const before = await store.getLibrary();
    await store.putLibrary({
      ...before,
      datasets: before.datasets.map((dataset) => ({ ...dataset, name: 'Saved locally' })),
    });
    assert.ok(clientId);
    assert.deepEqual(invalidations, []);

    stream.emit('library-changed', { epoch: 'epoch-a', revision, sourceClientId: clientId });
    assert.deepEqual(invalidations, []);

    currentLibrary = normalizeEvaluationLibrary({
      ...currentLibrary,
      data: {
        ...currentLibrary.data,
        suites: currentLibrary.data.suites.map((suite) => ({ ...suite, name: 'Renamed remotely' })),
      },
    });
    revision += 1;
    stream.emit('library-changed', { epoch: 'epoch-a', revision, sourceClientId: 'another-browser' });
    assert.deepEqual(invalidations, [{ epoch: 'epoch-a', revision }]);

    await store.getLibrarySyncSnapshot!();
    stream.emit('library-changed', { epoch: 'epoch-a', revision, sourceClientId: 'another-browser' });
    stream.emit('library-changed', { epoch: 'epoch-a', revision: revision - 1, sourceClientId: 'another-browser' });
    assert.deepEqual(invalidations, [{ epoch: 'epoch-a', revision }]);
    assert.equal(libraryReads, 3);
    unsubscribe?.();
  } finally {
    globalThis.fetch = originalFetch;
    if (eventSourceDescriptor) Object.defineProperty(globalThis, 'EventSource', eventSourceDescriptor);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('hosted HTTP evaluation store uses the guarded replacement route for incomplete resource versions', async () => {
  const originalFetch = globalThis.fetch;
  let revision = 7;
  let currentLibrary = normalizeEvaluationLibrary(library());
  let replacementWrites = 0;
  let resourceMutationWrites = 0;
  const incompleteSnapshot = () => ({
    revision,
    library: currentLibrary,
    resourceVersions: {
      suites: {},
      datasets: { 'dataset-b': 'present-but-incomplete' },
    },
  });
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), 'https://rivet.example');
    const method = init?.method ?? 'GET';
    if (requestUrl.pathname.endsWith('/library') && method === 'GET') return Response.json(incompleteSnapshot());
    if (requestUrl.pathname.endsWith('/library') && method === 'PUT') {
      replacementWrites += 1;
      const body = JSON.parse(String(init?.body)) as { expectedRevision: number; library: EvaluationLibrary };
      assert.equal(body.expectedRevision, revision);
      currentLibrary = normalizeEvaluationLibrary(body.library);
      revision += 1;
      return Response.json(incompleteSnapshot());
    }
    if (requestUrl.pathname.endsWith('/library/mutations') && method === 'POST') {
      resourceMutationWrites += 1;
      throw new Error('The incomplete token map must never use the resource mutation route.');
    }
    throw new Error(`Unexpected evaluation HTTP request: ${method} ${requestUrl.pathname}`);
  };

  try {
    const store = createHttpEvaluationStore({
      baseUrl: '/api/workflows/evaluation-runs',
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
    });
    const before = await store.getLibrary();
    await store.putLibrary({
      ...before,
      datasets: before.datasets.map((dataset) => ({ ...dataset, name: 'Compatible guarded replacement' })),
    });

    assert.equal(replacementWrites, 1);
    assert.equal(resourceMutationWrites, 0);
    assert.equal((await store.getLibrary()).datasets[0]?.name, 'Compatible guarded replacement');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted HTTP evaluation store does not hide failed legacy imports", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(String(input), "https://rivet.example");
    if (
      requestUrl.pathname.endsWith("/library/import") &&
      init?.method === "POST"
    ) {
      return Response.json({ error: "Storage unavailable" }, { status: 503 });
    }
    throw new Error(
      `Unexpected evaluation HTTP request: ${requestUrl.pathname}`,
    );
  };

  try {
    const store = createHttpEvaluationStore({
      baseUrl: "/api/workflows/evaluation-runs",
      normalizeRun: normalizeEvaluationRun,
      normalizeLibrary: normalizeEvaluationLibrary,
      legacyLibrarySource: {
        async getLibrary() {
          return library();
        },
      },
    });
    assert.ok(store.initialize);
    await assert.rejects(store.initialize(), /Storage unavailable/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("filesystem evaluation store preserves user-assigned names across snapshots", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-names-"),
  );
  const store = new FilesystemRivetEvaluationStore(
    path.join(root, "evaluations.sqlite"),
  );
  try {
    const initial = run(projectA, "named-filesystem-run");
    await store.put(initial);
    assert.equal(
      (
        await store.updateRunName({
          projectId: projectA,
          runId: initial.id,
          name: "  Baseline  ",
        })
      )?.name,
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
  const store = new FilesystemRivetEvaluationStore(
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

async function assertRecordingRetentionUpdateOutcomes(
  store: Pick<RivetStudioEvaluationStore, 'putRecording' | 'getRecording' | 'updateRecordingRetention'>,
): Promise<void> {
  const artifact = recording(projectA, 'retention-outcome', 'temporary', '2099-01-01T00:00:00.000Z');
  await store.putRecording(artifact);
  assert.equal(
    await store.updateRecordingRetention({
      projectId: projectA,
      recordingId: artifact.reference.id,
      retention: 'retained',
    }),
    true,
  );
  assert.equal(
    (await store.getRecording({ projectId: projectA, recordingId: artifact.reference.id }))?.reference.retention,
    'retained',
  );
  assert.equal(
    await store.updateRecordingRetention({
      projectId: projectA,
      recordingId: 'missing-recording',
      retention: 'retained',
    }),
    false,
  );
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
  const store = new FilesystemRivetEvaluationStore(
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
  const store = new FilesystemRivetEvaluationStore(databasePath);
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
  const store = new FilesystemRivetEvaluationStore(databasePath);
  let reopenedStore: FilesystemRivetEvaluationStore | undefined;
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
    reopenedStore = new FilesystemRivetEvaluationStore(databasePath);
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

test("filesystem evaluation store persists the complete upstream contract", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-complete-filesystem-"),
  );
  const databasePath = path.join(root, "evaluations.sqlite");
  const store = new FilesystemRivetEvaluationStore(databasePath);
  try {
    await assertCompleteEvaluationStoreContract(store);
    await assertRecordingRetentionUpdateOutcomes(store);
    await store.dispose();
    const reopened = new FilesystemRivetEvaluationStore(databasePath);
    try {
      const snapshot = await reopened.getLibrarySnapshot();
      assert.equal(snapshot.revision, 5);
      assert.deepEqual(snapshot.library.migratedLegacyProjectIds, [projectA]);
      assert.equal(
        (await reopened.get({ projectId: projectA, runId: "checkpoint-run" }))
          ?.name,
        "Checkpoint baseline",
      );
    } finally {
      await reopened.dispose();
    }
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("disposed filesystem evaluation stores cannot silently reopen their database", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rivet-evaluations-dispose-"),
  );
  const store = new FilesystemRivetEvaluationStore(
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
  readonly queries: string[] = [];
  readonly hostedStatuses = new Map<string, string>();
  readonly jobStatuses = new Map<string, string[]>();
  readonly recordings = new Map<string, ManagedRecordingRow>();
  readonly activeRecordingIds = new Set<string>();
  readonly runs = new Map<string, EvaluationRun>();
  readonly datasetSnapshots = new Set<string>();
  library: { revision: number; library: EvaluationLibrary } | undefined;
  readonly libraryImports = new Set<string>();

  private key(projectId: unknown, recordingId: unknown): string {
    return `${String(projectId)}:${String(recordingId)}`;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push(sql);
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
    if (normalized.startsWith('select status from evaluation_hosted_trial_jobs')) {
      const rows = (this.jobStatuses.get(this.key(values[0], values[1])) ?? []).map((status) => ({ status }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (normalized.startsWith('select status from evaluation_hosted_runs')) {
      const status = this.hostedStatuses.get(this.key(values[0], values[1]));
      return { rows: (status === undefined ? [] : [{ status }]) as T[], rowCount: status === undefined ? 0 : 1 };
    }
    if (
      normalized ===
      "select revision, library_json from evaluation_library where singleton_key = true"
    ) {
      return {
        rows:
          this.library === undefined
            ? []
            : [
                {
                  revision: this.library.revision,
                  library_json: this.library.library,
                } as T,
              ],
        rowCount: this.library === undefined ? 0 : 1,
      };
    }
    if (normalized.startsWith("insert into evaluation_library (")) {
      this.library = {
        revision: Number(values[0]),
        library: JSON.parse(String(values[1])) as EvaluationLibrary,
      };
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith(
        "select 1 from evaluation_library_imports where source_fingerprint = $1",
      )
    ) {
      const imported = this.libraryImports.has(String(values[0]));
      return {
        rows: imported ? ([{ "?column?": 1 }] as T[]) : [],
        rowCount: imported ? 1 : 0,
      };
    }
    if (normalized.startsWith("insert into evaluation_library_imports")) {
      this.libraryImports.add(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into evaluation_recordings")) {
      const projectId = String(values[0]);
      const recordingId = String(values[1]);
      const runId = String(values[2]);
      const incoming = JSON.parse(
        String(values[3]),
      ) as EvaluationRecordingArtifact;
      const key = this.key(projectId, recordingId);
      const existing = this.recordings.get(key);
      if (
        existing !== undefined &&
        (existing.runId !== runId ||
          existing.artifact.trialId !== incoming.trialId)
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
      normalized.startsWith("select recording.artifact_json") ||
      normalized.startsWith(
        "select artifact_json from evaluation_recordings where project_id = $1 and recording_id = $2",
      )
    ) {
      const key = this.key(values[0], values[1]);
      const row = this.recordings.get(key);
      return {
        rows:
          row === undefined
            ? []
            : [
                {
                  artifact_json: row.artifact,
                  protected_from_expiry: this.activeRecordingIds.has(key),
                } as T,
              ],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (
      normalized.startsWith(
        "select run_json from evaluation_runs where project_id = $1 and run_id = $2",
      ) || (normalized.startsWith('select case when') && normalized.endsWith('from evaluation_runs where project_id = $1 and run_id = $2'))
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
    if (normalized.startsWith('update evaluation_recordings set artifact_json = $1::jsonb')) {
      const key = this.key(values[1], values[2]);
      const existing = this.recordings.get(key);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.artifact = JSON.parse(String(values[0])) as EvaluationRecordingArtifact;
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
        if (row.projectId === projectId && (values[1] === undefined || row.runId === values[1])) this.recordings.delete(key);
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
        if (String(row.projectId) === projectId && (values[1] === undefined || row.id === values[1])) this.runs.delete(key);
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

test('generic managed Evaluation deletion protects scheduler-owned jobs and preserves neighboring runs', async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
  const initial = run(projectA, 'guarded-delete');
  const neighbor = run(projectA, 'neighbor');
  await store.put(initial);
  await store.put(neighbor);
  const input = { projectId: projectA, runId: initial.id };
  const key = `${projectA}:${initial.id}`;
  for (const status of ['queued', 'running']) {
    pool.hostedStatuses.set(key, status);
    await assert.rejects(store.delete(input), /queued or running/);
  }
  pool.hostedStatuses.set(key, 'completed');
  for (const status of ['queued', 'claimed', 'accepted']) {
    pool.jobStatuses.set(key, [status]);
    await assert.rejects(store.delete(input), /queued or running/, 'active jobs protect even an inconsistent parent');
  }
  assert.equal(
    pool.queries.some((sql) => sql.startsWith('delete from evaluation_runs')),
    false,
  );
  pool.jobStatuses.set(key, ['completed', 'interrupted', 'canceled']);
  const start = pool.queries.length;
  await store.delete(input);
  const commands = pool.queries.slice(start).map((sql) => sql.trim().replace(/\s+/g, ' ').toLowerCase());
  assert.ok(commands[1]!.includes('evaluation_hosted_trial_jobs') && commands[1]!.endsWith('for update'));
  assert.ok(commands[2]!.includes('evaluation_hosted_runs') && commands[2]!.endsWith('for update'));
  assert.equal(await store.get(input), undefined);
  assert.equal((await store.get({ projectId: projectA, runId: neighbor.id }))?.id, neighbor.id);
});

test('generic Evaluation snapshots cannot forge or expose the hosted projection marker', async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
  const initial = run(projectA, 'untrusted-projection-marker');
  await store.put({ ...initial, _hostedTrialsFromJobs: true } as EvaluationRun);
  const stored = pool.runs.get(`${projectA}:${initial.id}`)!;
  assert.ok(!('_hostedTrialsFromJobs' in stored));
  assert.equal((await store.get({ projectId: projectA, runId: initial.id }))?.trials.length, initial.trials.length);
  // Unknown/legacy marker values are never part of the public run contract.
  pool.runs.set(`${projectA}:${initial.id}`, { ...stored, _hostedTrialsFromJobs: false } as EvaluationRun);
  const renamed = await store.updateRunName({ projectId: projectA, runId: initial.id, name: 'Public run' });
  assert.ok(!('_hostedTrialsFromJobs' in renamed!));
  assert.ok(!('_hostedTrialsFromJobs' in pool.runs.get(`${projectA}:${initial.id}`)!));
});

test("managed evaluation store persists the complete upstream contract", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
  await assertCompleteEvaluationStoreContract(store);
  await assertRecordingRetentionUpdateOutcomes(store);
  assert.equal(pool.library?.revision, 5);
  assert.equal(pool.libraryImports.size, 2);
});
test('managed Evaluation terminal retention can join the caller transaction', async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
  const artifact = recording(projectA, 'terminal-retention', 'temporary', '2020-01-01T00:00:00.000Z');
  await store.putRecording(artifact);

  const client = await pool.connect();
  await client.query('BEGIN');
  assert.equal(
    await store.updateRecordingRetentionInTransaction(client as unknown as PoolClient, {
      projectId: projectA,
      recordingId: artifact.reference.id,
      retention: 'retained',
    }),
    true,
  );
  assert.equal(
    pool.queries.slice(pool.queries.lastIndexOf('BEGIN') + 1).some((query) => query === 'COMMIT'),
    false,
    'the helper must not create or commit an independent transaction',
  );
  assert.equal(pool.recordings.get(`${projectA}:terminal-retention`)?.artifact.reference.retention, 'retained');
  await client.query('COMMIT');
});
test("managed evaluation store hides expired artifacts without mutating shared retention state", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
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
  pool.activeRecordingIds.add(`${projectA}:expired-a`);
  assert.equal(
    (
      await store.getRecording({
        projectId: projectA,
        recordingId: "expired-a",
      })
    )?.serialized,
    "recording:expired-a",
    "a hosted parent or outstanding job keeps an expired provisional replay visible until terminal finalization",
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
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
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
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
  const initial = run(projectA, "named-managed-run");
  await store.put(initial);
  assert.equal(
    (
      await store.updateRunName({
        projectId: projectA,
        runId: initial.id,
        name: "  Candidate  ",
      })
    )?.name,
    "Candidate",
  );
  await store.put({ ...initial, revision: 1 });
  assert.equal(
    (await store.get({ projectId: projectA, runId: initial.id }))?.name,
    "Candidate",
  );
  assert.equal(
    await store.updateRunName({
      projectId: projectA,
      runId: "missing-managed-run",
      name: "Ignored",
    }),
    undefined,
  );
});
test("managed evaluation store normalizes legacy run history at its read boundary", async () => {
  const pool = new FakeManagedEvaluationPool();
  const store = new PostgresRivetEvaluationStore(pool as unknown as Pool);
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
