import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  fingerprintEvaluationDataset,
  createEmptyEvaluationProjectData,
  type EvaluationDatasetSnapshot,
  type EvaluationRecordingArtifact,
  type EvaluationRun,
  type EvaluationTrial,
} from '@valerypopoff/rivet2-evaluations';

import { LocalEvaluationRunStore } from './EvaluationRunStore.js';
import type { EvaluationKeyValueBackend } from './EvaluationRunStore.js';
import { IndexedDBStorage } from '../state/storage/indexedDB.js';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory(), writable: true });
});

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

function makeBackend(values = new Map<string, string>()): EvaluationKeyValueBackend & { values: Map<string, string> } {
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    entries: async () => [...values].map(([key, value]) => ({ key, value })),
  };
}

test('persists the evaluation library through the same injectable backend as run evidence', async () => {
  const backend = makeBackend();
  const first = new LocalEvaluationRunStore({ backend });
  await first.putLibrary({
    version: 1,
    data: createEmptyEvaluationProjectData(),
    datasets: [],
    migratedLegacyProjectIds: ['project-library' as ProjectId],
  });
  await first.put(makeRun('run-library', 'project-library' as ProjectId));

  const reopened = new LocalEvaluationRunStore({ backend });
  assert.deepEqual((await reopened.getLibrary()).migratedLegacyProjectIds, ['project-library']);
  assert.equal((await reopened.list({ projectId: 'project-library' as ProjectId })).length, 1);
});

test('preserves an unreadable library instead of silently replacing it with defaults', async () => {
  const backend = makeBackend(new Map([['rivet-evaluation-library:v1', '{not-json']]));
  const store = new LocalEvaluationRunStore({ backend });

  await assert.rejects(store.getLibrary(), /unreadable evaluation library/);
  assert.equal(backend.values.get('rivet-evaluation-library:v1'), '{not-json');
});

test('exports only evaluation-owned keys for desktop migration', async () => {
  const backend = makeBackend(
    new Map([
      ['rivet-evaluation-runs:project', '[]'],
      ['unrelated-application-setting', 'keep-out'],
    ]),
  );

  assert.deepEqual(await new LocalEvaluationRunStore({ backend }).exportEntries(), [
    { key: 'rivet-evaluation-runs:project', value: '[]' },
  ]);
});

test('preserves corrupt run, recording, and snapshot evidence instead of overwriting it', async () => {
  const projectId = 'corrupt-project' as ProjectId;
  const corrupt = '{not-json';
  const runKey = `rivet-evaluation-runs:${projectId}`;
  const recordingKey = `rivet-evaluation-recordings:${projectId}`;
  const snapshotKey = `rivet-evaluation-dataset-snapshots:${projectId}`;
  const runBackend = makeBackend(new Map([[runKey, corrupt]]));
  const recordingBackend = makeBackend(new Map([[recordingKey, corrupt]]));
  const snapshotBackend = makeBackend(new Map([[snapshotKey, corrupt]]));

  await assert.rejects(
    new LocalEvaluationRunStore({ backend: runBackend }).list({ projectId }),
    /unreadable evaluation run history/,
  );
  await assert.rejects(
    new LocalEvaluationRunStore({ backend: recordingBackend }).putRecording(makeRecording(projectId)),
    /unreadable evaluation recordings/,
  );
  await assert.rejects(
    new LocalEvaluationRunStore({ backend: snapshotBackend }).getDatasetSnapshot({ projectId, fingerprint: 'x' }),
    /unreadable evaluation dataset snapshots/,
  );
  assert.equal(runBackend.values.get(runKey), corrupt);
  assert.equal(recordingBackend.values.get(recordingKey), corrupt);
  assert.equal(snapshotBackend.values.get(snapshotKey), corrupt);
});

test('preserves a corrupt individually stored recording artifact', async () => {
  const projectId = 'corrupt-recording-project' as ProjectId;
  const recordingId = 'recording-1';
  const manifestKey = `rivet-evaluation-recordings:${projectId}`;
  const artifactKey = `rivet-evaluation-recording:${encodeURIComponent(projectId)}:${encodeURIComponent(recordingId)}`;
  const backend = makeBackend(
    new Map([
      [manifestKey, JSON.stringify({ version: 1, recordingIds: [recordingId] })],
      [artifactKey, '{not-json'],
    ]),
  );
  const store = new LocalEvaluationRunStore({ backend });

  await assert.rejects(store.getRecording({ projectId, recordingId }), /unreadable evaluation recording/);
  assert.equal(backend.values.get(manifestKey), JSON.stringify({ version: 1, recordingIds: [recordingId] }));
  assert.equal(backend.values.get(artifactKey), '{not-json');
});

test('adopts the legacy Jotai evaluation library without deleting the source copy', async () => {
  const legacyStorage = new IndexedDBStorage();
  const legacyLibrary = {
    version: 1 as const,
    data: createEmptyEvaluationProjectData(),
    datasets: [],
    migratedLegacyProjectIds: ['legacy-project' as ProjectId],
  };
  await legacyStorage.setItem('evaluation-library', JSON.stringify({ library: legacyLibrary }));

  const store = new LocalEvaluationRunStore();
  assert.deepEqual(await store.getLibrary(), legacyLibrary);
  assert.notEqual(await legacyStorage.getItem('evaluation-library'), null);

  const reopened = new LocalEvaluationRunStore();
  assert.deepEqual(await reopened.getLibrary(), legacyLibrary);
});

test('desktop migration fails closed when the legacy Jotai library cannot be verified', async () => {
  const store = new LocalEvaluationRunStore({
    legacyLibraryStorage: {
      getItem: async () => {
        throw new Error('Jotai IndexedDB is temporarily blocked');
      },
    },
  });

  await store.initialize();
  await assert.rejects(
    store.exportEntries({ requireIndexedDb: true }),
    /could not verify the legacy evaluation library.*temporarily blocked/,
  );
});

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

function makeRecording(projectId: ProjectId, recordingId = 'recording-1'): EvaluationRecordingArtifact {
  return {
    projectId,
    runId: 'run-1',
    trialId: 'trial-1',
    reference: { id: recordingId, retention: 'temporary' },
    serialized: '{}',
    createdAt: '2026-08-23T00:00:00.000Z',
  };
}

function makeTrial(id = 'trial-1'): EvaluationTrial {
  return {
    id,
    caseId: 'case-1',
    caseName: 'Case 1',
    caseIndex: 0,
    trialIndex: 0,
    executionStatus: 'completed',
    qualityStatus: 'passed',
    qualityReason: { code: 'checks-passed', message: 'All checks passed.' },
    inputs: { input: 'value' },
    expected: {},
    outputs: { output: 'value' },
    observations: [],
    targetMetrics: { durationMs: 1 },
    evaluatorMetrics: { durationMs: 0 },
    totalMetrics: { durationMs: 1 },
  };
}

test('does not let an equal-revision local progress write demote a completed run', async () => {
  const store = new LocalEvaluationRunStore();
  const projectId = 'equal-revision-project' as ProjectId;
  const completed = makeRun('run-1', projectId, 7);
  const running = { ...completed, executionStatus: 'running' as const, completedAt: undefined };

  await store.put(completed);
  await store.put(running);

  const stored = await store.get({ projectId, runId: completed.id });
  assert.equal(stored?.revision, 7);
  assert.equal(stored?.executionStatus, 'completed');
});

test('persists a user-assigned run name across newer execution snapshots', async () => {
  const store = new LocalEvaluationRunStore();
  const projectId = 'named-run-project' as ProjectId;
  const running = { ...makeRun('run-1', projectId, 1), executionStatus: 'running' as const, completedAt: undefined };
  await store.put(running);
  await store.updateRunName({ projectId, runId: running.id, name: '  Regression check  ' });
  await store.put(makeRun('run-1', projectId, 2));

  assert.equal((await store.get({ projectId, runId: running.id }))?.name, 'Regression check');
});

test('persists incremental run events idempotently across store instances', async () => {
  const projectId = 'checkpoint-project' as ProjectId;
  const store = new LocalEvaluationRunStore();
  const running = {
    ...makeRun('run-1', projectId, 1),
    completedAt: undefined,
    executionStatus: 'running' as const,
    qualityStatus: 'not-evaluated' as const,
    qualityReason: { code: 'in-progress' as const, message: 'Evaluation is running.' },
    requestedTrialCount: 1,
    trials: [],
  };
  const trial = makeTrial();

  await store.applyRunEvent({ type: 'run-started', revision: 1, run: running });
  const settledEvent = {
    type: 'trial-settled' as const,
    revision: 2,
    runId: running.id,
    projectId,
    suiteId: running.suiteId,
    requestedTrialCount: 1,
    settledTrialCount: 1,
    trial,
  };
  await store.applyRunEvent(settledEvent);
  await store.applyRunEvent(settledEvent);

  const reopened = new LocalEvaluationRunStore();
  const checkpoint = await reopened.get({ projectId, runId: running.id });
  assert.equal(checkpoint?.revision, 2);
  assert.deepEqual(checkpoint?.trials, [trial]);
});

test('deleting a run removes only that run and its retained recordings', async () => {
  const store = new LocalEvaluationRunStore();
  const projectId = 'delete-run-project' as ProjectId;
  const deletedRun = makeRun('run-delete', projectId);
  const retainedRun = makeRun('run-retain', projectId);
  const deletedRecording: EvaluationRecordingArtifact = {
    projectId,
    runId: deletedRun.id,
    trialId: 'trial-delete',
    reference: { id: 'recording-delete', retention: 'temporary' },
    serialized: '{}',
    createdAt: new Date().toISOString(),
  };
  const retainedRecording: EvaluationRecordingArtifact = {
    projectId,
    runId: retainedRun.id,
    trialId: 'trial-retain',
    reference: { id: 'recording-retain', retention: 'temporary' },
    serialized: '{}',
    createdAt: new Date().toISOString(),
  };

  await store.put(deletedRun);
  await store.put(retainedRun);
  await store.putRecording(deletedRecording);
  await store.putRecording(retainedRecording);
  await store.delete({ projectId, runId: deletedRun.id });

  assert.equal(await store.get({ projectId, runId: deletedRun.id }), undefined);
  assert.equal(await store.getRecording({ projectId, recordingId: deletedRecording.reference.id }), undefined);
  assert.equal((await store.get({ projectId, runId: retainedRun.id }))?.id, retainedRun.id);
  assert.equal(
    (await store.getRecording({ projectId, recordingId: retainedRecording.reference.id }))?.runId,
    retainedRun.id,
  );
});

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

test('lazily imports a legacy aggregate dataset snapshot into its V2 artifact record', async () => {
  const projectId = 'legacy-snapshot-project' as ProjectId;
  const dataset = {
    id: 'dataset',
    projectId,
    name: 'Dataset',
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input' as const }],
    cases: [{ id: 'case', name: 'Case', values: { input: 'legacy value' } }],
  };
  const fingerprint = fingerprintEvaluationDataset(dataset);
  const snapshot: EvaluationDatasetSnapshot = {
    projectId,
    fingerprint,
    createdAt: '2026-08-15T00:00:00.000Z',
    dataset,
  };
  const legacyKey = `rivet-evaluation-dataset-snapshots:${projectId}`;
  const backend = makeBackend(new Map([[legacyKey, JSON.stringify({ [fingerprint]: snapshot })]]));

  const restored = await new LocalEvaluationRunStore({ backend }).getDatasetSnapshot({ projectId, fingerprint });

  assert.equal(restored?.dataset.cases[0]?.values.input, 'legacy value');
  const artifactKey = `rivet-evaluation-dataset-snapshot:v2:${encodeURIComponent(projectId)}:${encodeURIComponent(fingerprint)}`;
  assert.deepEqual(JSON.parse(backend.values.get(artifactKey) ?? 'null'), snapshot);
  assert.ok(backend.values.has(legacyKey));
});

test('reports local-storage failures instead of claiming an evaluation run was saved', async () => {
  const originalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  const storage = makeStorage();
  const unavailableStorage: Storage = {
    ...storage,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: unavailableStorage });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined, writable: true });
  try {
    const store = new LocalEvaluationRunStore();
    await assert.rejects(store.put(makeRun('run-1', 'evaluation-project' as ProjectId)), /could not retain/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb, writable: true });
  }
});

test('uses legacy localStorage only when IndexedDB cannot initialize', async () => {
  const originalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  const storage = makeStorage();
  const projectId = 'legacy-fallback-project' as ProjectId;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        throw new Error('IndexedDB is blocked');
      },
    } as unknown as IDBFactory,
    writable: true,
  });
  try {
    const store = new LocalEvaluationRunStore();
    await store.put(makeRun('run-1', projectId));

    assert.deepEqual(
      (await store.list({ projectId })).map((run) => run.id),
      ['run-1'],
    );
    assert.ok(storage.getItem(`rivet-evaluation-run-index:v2:${encodeURIComponent(projectId)}`));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb, writable: true });
  }
});

test('desktop migration retries instead of treating a temporary IndexedDB outage as an empty source', async () => {
  const originalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  const storage = makeStorage();
  const projectId = 'blocked-migration-project' as ProjectId;
  const key = `rivet-evaluation-runs:${projectId}`;
  storage.setItem(key, JSON.stringify([makeRun('run-1', projectId)]));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        throw new Error('IndexedDB is temporarily blocked');
      },
    } as unknown as IDBFactory,
    writable: true,
  });
  try {
    const store = new LocalEvaluationRunStore();
    await assert.rejects(
      store.exportEntries({ requireIndexedDb: true }),
      /could not verify the legacy evaluation library/,
    );
    assert.ok(storage.getItem(key));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb, writable: true });
  }
});

test('uses IndexedDB for run history and migrates legacy localStorage records', async () => {
  const originalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  const storage = makeStorage();
  const projectId = 'indexed-history-project' as ProjectId;
  const legacyRun = makeRun('legacy-run', projectId);
  storage.setItem(`rivet-evaluation-runs:${projectId}`, JSON.stringify([legacyRun]));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory(), writable: true });
  try {
    const store = new LocalEvaluationRunStore();
    assert.equal((await store.list({ projectId }))[0]?.id, legacyRun.id);
    assert.equal(storage.getItem(`rivet-evaluation-runs:${projectId}`), null);

    await store.put(makeRun('run-2', projectId));
    assert.deepEqual(
      (await store.list({ projectId })).map((run) => run.id),
      ['run-2', 'legacy-run'],
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb, writable: true });
  }
});

test('migrates aggregate legacy recordings into individually addressable IndexedDB artifacts', async () => {
  const originalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  const storage = makeStorage();
  const projectId = 'indexed-recording-project' as ProjectId;
  const artifact: EvaluationRecordingArtifact = {
    projectId,
    runId: 'run-1',
    trialId: 'trial-1',
    reference: { id: 'recording-1', retention: 'temporary' },
    serialized: '{"events":[]}',
    createdAt: '2026-08-22T00:00:00.000Z',
  };
  storage.setItem(`rivet-evaluation-recordings:${projectId}`, JSON.stringify([artifact]));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory(), writable: true });
  try {
    const store = new LocalEvaluationRunStore();
    assert.equal((await store.getRecording({ projectId, recordingId: artifact.reference.id }))?.runId, artifact.runId);
    assert.equal(storage.getItem(`rivet-evaluation-recordings:${projectId}`), null);

    const reopenedStore = new LocalEvaluationRunStore();
    assert.equal(
      (await reopenedStore.getRecording({ projectId, recordingId: artifact.reference.id }))?.serialized,
      artifact.serialized,
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb, writable: true });
  }
});

test('keeps legacy history readable and retries when an IndexedDB migration write fails', async () => {
  const originalStorage = globalThis.localStorage;
  const storage = makeStorage();
  const projectId = 'retry-migration-project' as ProjectId;
  const legacyRun = makeRun('legacy-run', projectId);
  const originalTransaction = IDBDatabase.prototype.transaction;
  storage.setItem(`rivet-evaluation-runs:${projectId}`, JSON.stringify([legacyRun]));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    Object.defineProperty(IDBDatabase.prototype, 'transaction', {
      configurable: true,
      value: function (this: IDBDatabase, storeNames: string | string[], mode?: IDBTransactionMode): IDBTransaction {
        if (mode === 'readwrite') throw new Error('IndexedDB quota exceeded');
        return Reflect.apply(originalTransaction, this, [storeNames, mode]) as IDBTransaction;
      },
      writable: true,
    });
    try {
      const store = new LocalEvaluationRunStore();
      assert.equal((await store.list({ projectId }))[0]?.id, legacyRun.id);
      assert.ok(storage.getItem(`rivet-evaluation-runs:${projectId}`));

      Object.defineProperty(IDBDatabase.prototype, 'transaction', {
        configurable: true,
        value: originalTransaction,
        writable: true,
      });
      assert.equal((await store.list({ projectId }))[0]?.id, legacyRun.id);
      assert.equal(storage.getItem(`rivet-evaluation-runs:${projectId}`), null);
    } finally {
      Object.defineProperty(IDBDatabase.prototype, 'transaction', {
        configurable: true,
        value: originalTransaction,
        writable: true,
      });
    }
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('retains multiple large recordings independently instead of evicting earlier trials at a fixed project cap', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const store = new LocalEvaluationRunStore();
    const projectId = 'evaluation-project' as ProjectId;
    const firstLargeRecording: EvaluationRecordingArtifact = {
      projectId,
      runId: 'run-large',
      trialId: 'trial-first',
      reference: { id: 'recording-first', retention: 'temporary' },
      serialized: 'a'.repeat(11 * 1024 * 1024),
      createdAt: new Date().toISOString(),
    };
    const secondLargeRecording: EvaluationRecordingArtifact = {
      ...firstLargeRecording,
      trialId: 'trial-second',
      reference: { id: 'recording-second', retention: 'temporary' },
      serialized: 'b'.repeat(11 * 1024 * 1024),
    };

    await store.putRecording(firstLargeRecording);
    await store.putRecording(secondLargeRecording);

    assert.equal(
      (await store.getRecording({ projectId, recordingId: 'recording-first' }))?.serialized.length,
      11 * 1024 * 1024,
    );
    assert.equal(
      (await store.getRecording({ projectId, recordingId: 'recording-second' }))?.serialized.length,
      11 * 1024 * 1024,
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

test('two IndexedDB store instances retain concurrent run inserts without losing either run', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const projectId = 'concurrent-project' as ProjectId;
    const first = new LocalEvaluationRunStore();
    const second = new LocalEvaluationRunStore();

    await Promise.all([first.put(makeRun('run-1', projectId)), second.put(makeRun('run-2', projectId))]);

    assert.deepEqual(new Set((await first.list({ projectId })).map((run) => run.id)), new Set(['run-1', 'run-2']));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('two IndexedDB store instances retain concurrent recording inserts without losing either artifact', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const projectId = 'concurrent-recordings-project' as ProjectId;
    const first = new LocalEvaluationRunStore();
    const second = new LocalEvaluationRunStore();

    await Promise.all([
      first.putRecording(makeRecording(projectId, 'recording-1')),
      second.putRecording(makeRecording(projectId, 'recording-2')),
    ]);

    assert.equal((await first.getRecording({ projectId, recordingId: 'recording-1' }))?.reference.id, 'recording-1');
    assert.equal((await first.getRecording({ projectId, recordingId: 'recording-2' }))?.reference.id, 'recording-2');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('does not fall back to stale legacy history when a committed V2 run index is corrupt', async () => {
  const projectId = 'corrupt-v2-index-project' as ProjectId;
  const legacyKey = `rivet-evaluation-runs:${projectId}`;
  const indexKey = `rivet-evaluation-run-index:v2:${encodeURIComponent(projectId)}`;
  const backend = makeBackend(
    new Map([
      [legacyKey, JSON.stringify([makeRun('legacy-run', projectId)])],
      [indexKey, '{not-json'],
    ]),
  );

  await assert.rejects(
    new LocalEvaluationRunStore({ backend }).list({ projectId }),
    /unreadable evaluation run index/u,
  );
  assert.equal(backend.values.get(indexKey), '{not-json');
  assert.ok(backend.values.has(legacyKey));
});

test('does not silently omit a run when the committed V2 index references a missing record', async () => {
  const projectId = 'missing-v2-run-project' as ProjectId;
  const legacyKey = `rivet-evaluation-runs:${projectId}`;
  const indexKey = `rivet-evaluation-run-index:v2:${encodeURIComponent(projectId)}`;
  const backend = makeBackend(
    new Map([
      [legacyKey, JSON.stringify([makeRun('legacy-run', projectId)])],
      [indexKey, JSON.stringify({ version: 2, runIds: ['missing-run'] })],
    ]),
  );

  await assert.rejects(
    new LocalEvaluationRunStore({ backend }).list({ projectId }),
    /references missing run "missing-run"/u,
  );
  assert.ok(backend.values.has(legacyKey));
  assert.ok(backend.values.has(indexKey));
});

test('revisioned evaluation libraries reject a stale cross-instance replacement', async () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  try {
    const first = new LocalEvaluationRunStore();
    const second = new LocalEvaluationRunStore();
    const initialFirst = await first.getLibrary();
    const initialSecond = await second.getLibrary();

    await first.putLibrary({
      ...initialFirst,
      migratedLegacyProjectIds: ['first' as ProjectId],
    });
    await assert.rejects(
      second.putLibrary({
        ...initialSecond,
        migratedLegacyProjectIds: ['second' as ProjectId],
      }),
      /changed in another window/u,
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});
