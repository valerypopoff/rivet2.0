import http from 'node:http';
import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectId } from "@valerypopoff/rivet2-node";
import type {
  EvaluationLibrary,
  EvaluationLibraryMutation,
  EvaluationLibrarySyncSnapshot,
  EvaluationRecordingArtifact,
  EvaluationRun,
} from "@valerypopoff/rivet2-evaluations";

import { createFilesystemWorkflowSuiteHarness } from "./helpers/workflow-filesystem-suite-harness.js";
import { createApiApp } from '../app.js';
import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { getEvaluationStore } from '../routes/workflows/storage-backend.js';
import { listenTestServer } from './helpers/http-server-harness.js';
import { AcceptedWork } from '../../../studio-server-shared/process-retirement.js';

const projectId = "scoring-project" as ProjectId;
const {
  withWorkflowApiServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

function readLibraryEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (event && data)
          return { event, data: JSON.parse(data) as { epoch: string; revision: number; sourceClientId?: string | null } };
      } else {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'stream ended before the expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  };
}

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
    const removed = await fetch(runUrl, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, runId: run.id }),
    });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(`${runUrl}?projectId=${projectId}`)).status, 404);
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

test("evaluation API persists incremental run events through finalization", async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const evaluationBaseUrl = `${baseUrl}/evaluation-runs`;
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
    const completed = { ...finalized, revision: 3 };
    const finishResponse = await fetch(`${evaluationBaseUrl}/events/${started.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'run-finalized', revision: 3, run: completed }),
    });
    assert.equal(finishResponse.status, 204);
    const finished = await fetch(`${evaluationBaseUrl}/${started.id}?projectId=${projectId}`);
    assert.equal(finished.status, 200);
    const saved = (await finished.json()) as EvaluationRun;
    assert.equal(saved.revision, 3);
    assert.equal(saved.executionStatus, 'completed');
    assert.deepEqual(saved.trials, completed.trials);
  });
});

test('Evaluation library HTTP preserves conflicts, ordered notifications and accepted work after disconnect', async (t) => {
  const previousMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  const previousKey = process.env.RIVET_KEY;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
  process.env.RIVET_KEY = 'evaluation-library-http-fixture';
  const work = new AcceptedWork();
  let listener: Awaited<ReturnType<typeof listenTestServer>> | undefined;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finishMutation: (() => void) | undefined;
  let request: http.ClientRequest | undefined;
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Library HTTP fixture did not settle.')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const server = http.createServer(createApiApp('control', { requestWork: work }));
    listener = await listenTestServer(server);
    const evaluationBase = `${listener.baseUrl}/api/workflows/evaluation-runs`;
    const base = `${evaluationBase}/library`;
    const headers = {
      'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
      cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
      'content-type': 'application/json',
      'x-rivet-evaluation-library-client-id': 'library-http-fixture',
    };
    const read = async () => {
      const response = await fetch(base, { headers, signal: controller.signal });
      assert.equal(response.status, 200);
      return (await response.json()) as EvaluationLibrarySyncSnapshot;
    };
    const send = (route: string, method: string, body: unknown) =>
      fetch(base + route, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    const initial = await read();
    const capability = await fetch(`${evaluationBase}/hosted/capability`, {
      headers,
      signal: controller.signal,
    });
    assert.equal(capability.status, 200);
    assert.deepEqual(await capability.json(), { enabled: false, workerEnabled: false, workerConcurrency: 0 });
    const unsupported = await fetch(`${evaluationBase}/hosted`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        projectContents: 'fixture',
        projectPath: '/Fixture.rivet-project',
        evaluationData: {},
        dataset: {},
        suiteId: 'suite',
        purpose: 'evaluation',
      }),
    });
    assert.equal(unsupported.status, 409);
    assert.deepEqual(await unsupported.json(), { error: 'Hosted Evaluations require managed workflow storage.' });
    const stream = await fetch(`${base}/events`, { headers, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    reader = stream.body!.getReader();
    const nextEvent = readLibraryEvents(reader);
    const opened = await nextEvent();
    assert.equal(opened.event, 'library-state');
    assert.equal(opened.data.revision, initial.revision);
    const expectChange = async (snapshot: EvaluationLibrarySyncSnapshot) => {
      const event = await nextEvent();
      assert.deepEqual(event, {
        event: 'library-changed',
        data: {
          epoch: opened.data.epoch,
          revision: snapshot.revision,
          sourceClientId: 'library-http-fixture',
        },
      });
    };
    const unchanged = await send('', 'PUT', { expectedRevision: initial.revision, library: initial.library });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), initial);
    const trailingSlash = await fetch(base + '/', { headers, signal: controller.signal });
    assert.equal(trailingSlash.status, 200);
    assert.match(trailingSlash.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(await trailingSlash.json(), initial);
    const head = await fetch(base, { method: 'HEAD', headers, signal: controller.signal });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const rejected = await send('', 'PUT', { expectedRevision: initial.revision + 1, library: initial.library });
    assert.equal(rejected.status, 409);
    await rejected.arrayBuffer();
    const suite: EvaluationLibrary['data']['suites'][number] = {
      id: 'suite',
      name: 'Suite',
      targetGraphId: 'target-graph' as EvaluationLibrary['data']['suites'][number]['targetGraphId'],
      datasetId: 'b',
      inputBindings: [],
      assertions: [],
      evaluators: [],
    };
    const library = {
      ...initial.library,
      data: { ...initial.library.data, suites: [suite] },
      datasets: [
        { id: 'a', name: 'A', fields: [], cases: [] },
        { id: 'b', name: 'B', fields: [], cases: [] },
      ],
    };
    const imported = await send('/import', 'POST', { library });
    assert.equal(imported.status, 200);
    const importedSnapshot = (await imported.json()) as EvaluationLibrarySyncSnapshot;
    assert.deepEqual(
      {
        ...importedSnapshot.library,
        datasets: importedSnapshot.library.datasets.map(({ contentFingerprint: _fingerprint, ...dataset }) => dataset),
      },
      library,
    );
    assert.equal(importedSnapshot.revision, initial.revision + 1);
    await expectChange(importedSnapshot); // No no-op/rejection event may precede this event.
    const replacement = { ...importedSnapshot.library, migratedLegacyProjectIds: [projectId] };
    const installed = await send('', 'PUT', { expectedRevision: importedSnapshot.revision, library: replacement });
    assert.equal(installed.status, 200);
    const start = (await installed.json()) as EvaluationLibrarySyncSnapshot;
    assert.equal(start.revision, importedSnapshot.revision + 1);
    assert.deepEqual(start.library, replacement);
    await expectChange(start);
    const again = await send('/import', 'POST', { library });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), start);
    let current = start;
    const independentChanges: EvaluationLibraryMutation['changes'] = [
      {
        kind: 'put-dataset',
        id: 'a',
        expectedVersion: start.resourceVersions.datasets.a!,
        dataset: { id: 'a', name: 'a changed', fields: [], cases: [] },
      },
      {
        kind: 'put-suite',
        id: suite.id,
        expectedVersion: start.resourceVersions.suites[suite.id]!,
        suite: { ...suite, name: 'Suite changed' },
        baselines: [],
      },
    ];
    for (const change of independentChanges) {
      const result = await send('/mutations', 'POST', { changes: [change] });
      assert.equal(result.status, 200);
      current = (await result.json()) as EvaluationLibrarySyncSnapshot;
      await expectChange(current);
    }
    assert.equal(current.library.datasets.find((dataset) => dataset.id === 'a')?.name, 'a changed');
    assert.equal(current.library.data.suites[0]?.name, 'Suite changed');
    const conflict = await send('/mutations', 'POST', {
      changes: [
        {
          kind: 'put-dataset',
          id: 'a',
          expectedVersion: start.resourceVersions.datasets.a,
          dataset: { id: 'a', name: 'stale', fields: [], cases: [] },
        },
      ],
    });
    assert.equal(conflict.status, 409);
    const failure = await conflict.json();
    assert.equal(failure.code, 'evaluation_library_resource_conflict');
    assert.deepEqual(failure.conflicts, [
      {
        kind: 'dataset',
        id: 'a',
        expectedVersion: start.resourceVersions.datasets.a,
        currentVersion: current.resourceVersions.datasets.a,
      },
    ]);
    assert.deepEqual(failure.snapshot, current);
    assert.deepEqual(await read(), current);
    const mismatch = await send('/mutations', 'POST', {
      changes: [
        {
          kind: 'put-dataset',
          id: 'a',
          expectedVersion: current.resourceVersions.datasets.a,
          dataset: { id: 'b', name: 'mismatch', fields: [], cases: [] },
        },
      ],
    });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), {
      error: 'Evaluation dataset mutation payload does not match its resource ID.',
    });
    const suiteMismatch = await send('/mutations', 'POST', {
      changes: [{ ...independentChanges[1], id: 'wrong' }],
    });
    assert.equal(suiteMismatch.status, 400);
    assert.deepEqual(await suiteMismatch.json(), {
      error: 'Evaluation suite mutation payload does not match its resource ID.',
    });
    const deleteDataset = {
      kind: 'delete-dataset' as const,
      id: 'b',
      expectedVersion: current.resourceVersions.datasets.b!,
    };
    const stillReferenced = await send('/mutations', 'POST', { changes: [deleteDataset] });
    assert.equal(stillReferenced.status, 400);
    assert.deepEqual(await stillReferenced.json(), {
      error: 'Cannot delete dataset "b" while an evaluation suite still references it.',
    });
    assert.deepEqual(await read(), current);
    const removed = await send('/mutations', 'POST', {
      changes: [
        deleteDataset,
        { kind: 'delete-suite', id: suite.id, expectedVersion: current.resourceVersions.suites[suite.id] },
      ],
    });
    assert.equal(removed.status, 200);
    current = (await removed.json()) as EvaluationLibrarySyncSnapshot;
    assert.equal(current.library.data.suites.length, 0);
    assert.deepEqual(current.library.datasets.map((dataset) => dataset.id), ['a']);
    await expectChange(current); // Rejected changes must not have emitted an event.
    const store = await getEvaluationStore();
    const mutate = store.mutateLibrary.bind(store);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    let writes = 0;
    t.mock.method(store, 'mutateLibrary', async (...args: Parameters<typeof mutate>) => {
      writes++;
      entered();
      await gate;
      return mutate(...args);
    });
    let closed!: () => void;
    const closedOnServer = new Promise<void>((resolve) => {
      closed = resolve;
    });
    // Observe the actual accepted request, not only the client's timeout.
    server.once('request', (_req, res) => {
      res.once('close', closed);
    });
    request = http.request(`${base}/mutations`, { method: 'POST', headers, signal: controller.signal });
    request.on('error', () => {}); // Deliberate client reset is observed below.
    request.end(
      JSON.stringify({
        changes: [
          {
            kind: 'put-dataset',
            id: 'a',
            expectedVersion: current.resourceVersions.datasets.a,
            dataset: { id: 'a', name: 'accepted after disconnect', fields: [], cases: [] },
          },
        ],
      }),
    );
    await bounded(started);
    request.destroy();
    await bounded(closedOnServer);
    assert.equal(work.count, 2, 'SSE plus the disconnected accepted mutation remain held');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    reader = undefined;
    const drained = work.drain();
    assert.ok(finishMutation);
    finishMutation();
    await bounded(drained);
    assert.equal(work.count, 0);
    assert.equal(writes, 1);
    assert.equal(
      (await store.getLibrarySnapshot()).library.datasets.find((dataset) => dataset.id === 'a')?.name,
      'accepted after disconnect',
    );
  } finally {
    clearTimeout(deadline);
    controller.abort();
    finishMutation?.();
    request?.destroy();
    await reader?.cancel().catch(() => undefined);
    try {
      await listener?.close();
    } finally {
      if (previousMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
      else process.env.RIVET_SERVER_UI_AUTH_MODE = previousMode;
      if (previousKey === undefined) delete process.env.RIVET_KEY;
      else process.env.RIVET_KEY = previousKey;
    }
  }
});

test('Evaluation library stream does not miss a change during its initial snapshot read', async (t) => {
  const previousMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'none';
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let enteredRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    await withWorkflowApiServer(async (baseUrl) => {
      const store = await getEvaluationStore();
      const read = store.getLibrarySyncSnapshot.bind(store);
      const initial = await read();
      let pause = true;
      t.mock.method(store, 'getLibrarySyncSnapshot', async () => {
        const snapshot = await read();
        if (pause) {
          pause = false;
          enteredRead();
          await readGate;
        }
        return snapshot;
      });
      const pending = fetch(`${baseUrl}/evaluation-runs/library/events`, { signal: controller.signal });
      void pending.catch(() => {});
      await Promise.race([
        readStarted,
        pending.then(() => {
          throw new Error('Stream opened before its snapshot was read.');
        }),
      ]);
      const changed = await fetch(`${baseUrl}/evaluation-runs/library`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          expectedRevision: initial.revision,
          library: { ...initial.library, datasets: [{ id: 'new', name: 'New', fields: [], cases: [] }] },
        }),
      });
      assert.equal(changed.status, 200);
      const current = (await changed.json()) as EvaluationLibrarySyncSnapshot;
      releaseRead();
      const response = await pending;
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      try {
        const nextEvent = readLibraryEvents(reader);
        const opened = await nextEvent();
        assert.equal(opened.event, 'library-state');
        const latest = opened.data.revision === current.revision ? opened : await nextEvent();
        assert.equal(latest.event, 'library-state');
        assert.equal(latest.data.revision, current.revision);
        assert.equal(latest.data.epoch, opened.data.epoch);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    });
  } finally {
    clearTimeout(deadline);
    releaseRead();
    controller.abort();
    if (previousMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = previousMode;
  }
});
