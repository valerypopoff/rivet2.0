import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectId } from "@valerypopoff/rivet2-node";
import type {
  EvaluationLibrary,
  EvaluationRecordingArtifact,
  EvaluationRun,
} from "@valerypopoff/rivet2-evaluations";

import { createFilesystemWorkflowSuiteHarness } from "./helpers/workflow-filesystem-suite-harness.js";

const projectId = "scoring-project" as ProjectId;
const {
  withWorkflowApiServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

function scoringRun(): EvaluationRun {
  return {
    version: 2,
    id: "scored-run",
    projectId,
    suiteId: "scoring-suite",
    suiteName: "Scoring suite",
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
    purpose: "evaluation",
    evaluationMode: "scoring",
    executionStatus: "completed",
    qualityStatus: "scored",
    qualityReason: {
      code: "scores-complete",
      message: "Every requested trial produced a score.",
    },
    accountingStatus: "complete",
    provenance: {
      projectFingerprint: "project",
      suiteFingerprint: "suite",
      datasetFingerprint: "dataset",
      targetFingerprint: "target",
      evaluatorFingerprints: { evaluator: "evaluator" },
      executionMode: "test",
      accountingComplete: true,
    },
    aggregate: {
      trialCount: 1,
      evaluatedTrialCount: 1,
      notEvaluatedTrialCount: 0,
      unableToEvaluateTrialCount: 0,
      passedTrialCount: 0,
      failedTrialCount: 0,
      erroredTrialCount: 0,
      canceledTrialCount: 0,
      passRate: 0,
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
        id: "scored-trial",
        caseId: "case",
        caseName: "Case",
        caseIndex: 0,
        trialIndex: 0,
        executionStatus: "completed",
        qualityStatus: "scored",
        qualityReason: {
          code: "scores-complete",
          message: "The evaluator graph returned a score.",
        },
        inputs: {},
        expected: {},
        outputs: {},
        observations: [
          {
            id: "evaluator",
            kind: "graph",
            name: "Evaluator",
            required: true,
            status: "scored",
            score: 0.85,
          },
        ],
        targetMetrics: { durationMs: 1 },
        evaluatorMetrics: { durationMs: 1 },
        totalMetrics: { durationMs: 2 },
      },
    ],
    warnings: [],
  };
}

test("evaluation history API persists and renames completed scoring runs", async () => {
  const run = scoringRun();

  await withWorkflowApiServer(async (baseUrl) => {
    const runUrl = `${baseUrl}/evaluation-runs/${run.id}`;
    const writeResponse = await fetch(runUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, run }),
    });
    assert.equal(writeResponse.status, 204);

    const listResponse = await fetch(
      `${baseUrl}/evaluation-runs?projectId=${projectId}`,
    );
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as EvaluationRun[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.qualityStatus, "scored");
    assert.equal(listed[0]?.qualityReason.code, "scores-complete");

    const getResponse = await fetch(`${runUrl}?projectId=${projectId}`);
    assert.equal(getResponse.status, 200);
    const stored = (await getResponse.json()) as EvaluationRun;
    assert.equal(stored.qualityStatus, "scored");
    assert.equal(stored.qualityReason.code, "scores-complete");

    const renameResponse = await fetch(runUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: "  Scoring baseline  " }),
    });
    assert.equal(renameResponse.status, 200);
    const renamed = (await renameResponse.json()) as EvaluationRun;
    assert.equal(renamed.name, "Scoring baseline");

    const renamedGetResponse = await fetch(`${runUrl}?projectId=${projectId}`);
    assert.equal(renamedGetResponse.status, 200);
    const renamedStored = (await renamedGetResponse.json()) as EvaluationRun;
    assert.equal(renamedStored.name, "Scoring baseline");
  });
});

test("evaluation API confirms whether a recording-retention update found an artifact", async () => {
  const artifact: EvaluationRecordingArtifact = {
    projectId,
    runId: "scored-run",
    trialId: "scored-trial",
    reference: {
      id: "retention-recording",
      retention: "temporary",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    serialized: "{}",
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  await withWorkflowApiServer(async (baseUrl) => {
    const evaluationBaseUrl = `${baseUrl}/evaluation-runs`;
    const writeResponse = await fetch(`${evaluationBaseUrl}/recordings/${artifact.reference.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifact),
    });
    assert.equal(writeResponse.status, 204);

    const updatedResponse = await fetch(`${evaluationBaseUrl}/recordings/${artifact.reference.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, recordingId: artifact.reference.id, retention: "retained" }),
    });
    assert.equal(updatedResponse.status, 200);
    assert.deepEqual(await updatedResponse.json(), { updated: true });

    const missingResponse = await fetch(`${evaluationBaseUrl}/recordings/missing-recording`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, recordingId: "missing-recording", retention: "retained" }),
    });
    assert.equal(missingResponse.status, 200);
    assert.deepEqual(await missingResponse.json(), { updated: false });
  });
});

test("evaluation API persists the full library and incremental run events", async () => {
  const evaluationLibrary: EvaluationLibrary = {
    version: 1,
    data: {
      version: 1,
      suites: [
        {
          id: "hosted-suite",
          name: "Hosted suite",
          targetGraphId:
            "target-graph" as EvaluationLibrary["data"]["suites"][number]["targetGraphId"],
          datasetId: "hosted-dataset",
          inputBindings: [],
          assertions: [],
          evaluators: [],
        },
      ],
      baselines: [],
    },
    datasets: [
      {
        id: "hosted-dataset",
        name: "Hosted dataset",
        fields: [],
        cases: [],
      },
    ],
    migratedLegacyProjectIds: [],
  };

  await withWorkflowApiServer(async (baseUrl) => {
    const evaluationBaseUrl = `${baseUrl}/evaluation-runs`;
    const initialResponse = await fetch(`${evaluationBaseUrl}/library`);
    assert.equal(initialResponse.status, 200);
    assert.equal(
      ((await initialResponse.json()) as { revision: number }).revision,
      0,
    );

    const importResponse = await fetch(`${evaluationBaseUrl}/library/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ library: evaluationLibrary }),
    });
    assert.equal(importResponse.status, 200);
    const imported = (await importResponse.json()) as {
      revision: number;
      library: EvaluationLibrary;
    };
    assert.equal(imported.revision, 1);
    assert.equal(imported.library.data.suites[0]?.id, "hosted-suite");

    const duplicateImportResponse = await fetch(
      `${evaluationBaseUrl}/library/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ library: evaluationLibrary }),
      },
    );
    assert.equal(duplicateImportResponse.status, 200);
    assert.equal(
      ((await duplicateImportResponse.json()) as { revision: number }).revision,
      1,
    );

    const staleWriteResponse = await fetch(`${evaluationBaseUrl}/library`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, library: evaluationLibrary }),
    });
    assert.equal(staleWriteResponse.status, 409);

    const finalized = scoringRun();
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
    const startResponse = await fetch(
      `${evaluationBaseUrl}/events/${started.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "run-started",
          revision: 1,
          run: started,
        }),
      },
    );
    assert.equal(startResponse.status, 204);

    const trialResponse = await fetch(
      `${evaluationBaseUrl}/events/${started.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "trial-settled",
          revision: 2,
          runId: started.id,
          projectId,
          suiteId: started.suiteId,
          requestedTrialCount: 1,
          settledTrialCount: 1,
          trial: finalized.trials[0],
        }),
      },
    );
    assert.equal(trialResponse.status, 204);

    const checkpointResponse = await fetch(
      `${evaluationBaseUrl}/${started.id}?projectId=${projectId}`,
    );
    assert.equal(checkpointResponse.status, 200);
    const checkpoint = (await checkpointResponse.json()) as EvaluationRun;
    assert.equal(checkpoint.revision, 2);
    assert.equal(checkpoint.trials.length, 1);
  });
});
