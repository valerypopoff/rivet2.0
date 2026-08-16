import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  fingerprintEvaluationDataset,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
} from '@valerypopoff/rivet2-evaluations';

import { LocalEvaluationRunStore } from './EvaluationRunStore.js';

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function makeRun(id: string, projectId: ProjectId, revision = 1): EvaluationRun {
  return {
    version: 2,
    id,
    projectId,
    suiteId: 'suite',
    suiteName: 'Suite',
    revision,
    startedAt: new Date(Number(id.replace(/\D/gu, '') || 0) * 1000).toISOString(),
    completedAt: new Date().toISOString(),
    executionStatus: 'completed',
    purpose: 'evaluation',
    qualityStatus: 'passed',
    qualityReason: { code: 'checks-passed', message: 'All required quality criteria passed.' },
    accountingStatus: 'complete',
    provenance: {
      projectFingerprint: 'project',
      suiteFingerprint: 'suite',
      datasetFingerprint: 'dataset',
      targetFingerprint: 'target',
      evaluatorFingerprints: {},
      executionMode: 'test',
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
    trials: [],
    warnings: [],
  };
}

test('normalizes legacy local evaluation runs when reading persisted history', async () => {
  const originalStorage = globalThis.localStorage;
  const storage = makeStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const projectId = 'legacy-evaluation-project' as ProjectId;
    const legacy = structuredClone(makeRun('legacy-run', projectId)) as unknown as Record<string, unknown>;
    delete legacy.version;
    delete legacy.purpose;
    delete legacy.qualityStatus;
    delete legacy.qualityReason;
    delete legacy.accountingStatus;
    delete legacy.thresholdResults;
    legacy.trials = [];
    storage.setItem(`rivet-evaluation-runs:${projectId}`, JSON.stringify([legacy]));

    const [normalized] = await new LocalEvaluationRunStore().list({ projectId });

    assert.equal(normalized?.version, 2);
    assert.equal(normalized?.purpose, 'evaluation');
    assert.equal(normalized?.qualityStatus, 'not-evaluated');
    assert.deepEqual(normalized?.thresholdResults, []);
    assert.equal(normalized?.accountingStatus, 'complete');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('keeps pinned failed and baseline run history when compacting local evaluation history', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const store = new LocalEvaluationRunStore();
    const projectId = 'evaluation-project' as ProjectId;
    const baselineRun = makeRun('run-0', projectId);
    const artifact: EvaluationRecordingArtifact = {
      projectId,
      runId: baselineRun.id,
      trialId: 'trial-0',
      reference: { id: 'recording-0', retention: 'temporary' },
      serialized: '{}',
      createdAt: new Date().toISOString(),
    };
    await store.put(baselineRun);
    await store.putRecording(artifact);
    await store.promoteBaseline({ projectId, runId: baselineRun.id });

    for (let index = 1; index <= 101; index += 1) {
      await store.put(makeRun(`run-${index}`, projectId));
    }

    assert.equal((await store.get({ projectId, runId: baselineRun.id }))?.id, baselineRun.id);
    assert.equal(
      (await store.getRecording({ projectId, recordingId: artifact.reference.id }))?.reference.retention,
      'baseline',
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('keeps local evaluation dataset snapshots separate by project and fingerprint', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const store = new LocalEvaluationRunStore();
    const projectId = 'evaluation-project' as ProjectId;
    const dataset = {
      id: 'dataset',
      projectId,
      name: 'Dataset',
      fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input' as const }],
      cases: [{ id: 'case', name: 'Case', values: { input: 'original' } }],
    };
    const snapshot: EvaluationDatasetSnapshot = {
      projectId,
      fingerprint: fingerprintEvaluationDataset(dataset),
      createdAt: '2026-08-15T00:00:00.000Z',
      dataset,
    };
    await store.putDatasetSnapshot(snapshot);
    snapshot.dataset.cases[0]!.values.input = 'changed after write';

    assert.equal(
      (await store.getDatasetSnapshot({ projectId, fingerprint: snapshot.fingerprint }))?.dataset.cases[0]?.values
        .input,
      'original',
    );
    assert.equal(
      await store.getDatasetSnapshot({ projectId: 'other-project' as ProjectId, fingerprint: snapshot.fingerprint }),
      undefined,
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('reports local-storage failures instead of claiming an evaluation run was saved', async () => {
  const originalStorage = globalThis.localStorage;
  const storage = makeStorage();
  const unavailableStorage: Storage = {
    ...storage,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: unavailableStorage });
  try {
    const store = new LocalEvaluationRunStore();
    await assert.rejects(store.put(makeRun('run-1', 'evaluation-project' as ProjectId)), /could not retain/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('enforces the local recording budget using UTF-8 bytes rather than JavaScript string length', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const store = new LocalEvaluationRunStore();
    const projectId = 'evaluation-project' as ProjectId;
    const oversizedNonAsciiRecording: EvaluationRecordingArtifact = {
      projectId,
      runId: 'run-non-ascii',
      trialId: 'trial-non-ascii',
      reference: { id: 'recording-non-ascii', retention: 'temporary' },
      // One UTF-16 code unit per character, but three bytes per character in
      // UTF-8. The old string-length accounting incorrectly retained it.
      serialized: '€'.repeat(7 * 1024 * 1024),
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      store.putRecording(oversizedNonAsciiRecording),
      /exceeds the browser storage retention limit/u,
    );
    assert.equal(
      await store.getRecording({ projectId, recordingId: oversizedNonAsciiRecording.reference.id }),
      undefined,
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('does not let a delayed provisional write demote or reassign a local recording', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const store = new LocalEvaluationRunStore();
    const projectId = 'evaluation-project' as ProjectId;
    const provisional: EvaluationRecordingArtifact = {
      projectId,
      runId: 'run-1',
      trialId: 'trial-1',
      reference: {
        id: 'recording-1',
        retention: 'temporary',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      serialized: '{}',
      createdAt: '2026-08-15T00:00:00.000Z',
    };
    await store.putRecording(provisional);
    await store.updateRecordingRetention({ projectId, recordingId: 'recording-1', retention: 'failure' });

    await store.putRecording(provisional);
    assert.deepEqual((await store.getRecording({ projectId, recordingId: 'recording-1' }))?.reference, {
      id: 'recording-1',
      retention: 'failure',
    });
    await assert.rejects(store.putRecording({ ...provisional, runId: 'run-2' }), /cannot be reassigned/u);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});
