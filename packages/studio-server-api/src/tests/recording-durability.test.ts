import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { NodeCreatedProcessor } from '@valerypopoff/rivet2-node';
import { ExecutionSession } from '../routes/workflows/execution-session.js';
import type { RunEvidenceRepository, RunEvidenceOutcome } from '../../../studio-server-shared/workflow-run-evidence.js';
import {
  retryableRecordingStorageError,
  recordingDurabilityEnabled,
  validEvidenceHandle,
  evidenceSummary,
  type EvidenceRow,
} from '../routes/workflows/managed/recording-evidence.js';
import { createWorkflowRecordingStore } from '../routes/workflows/recordings-store.js';
import {
  deferEvidenceWork,
  flushEvidenceWork,
  pendingEvidenceWorkCount,
} from '../routes/workflows/recording-evidence-work.js';
import { completeRunEvidence, incompleteChildEvidence } from '../routes/workflows/execution-evidence-owner.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';

function fakeProcessor(calls: string[], run: () => Promise<unknown>) {
  return {
    processor: {
      isRunning: false,
      onAny: () => () => {},
      on: () => () => {},
      waitForRunCompletion: async () => ({}),
      getRunCostSnapshot: () => ({ status: 'unknown', knownCostUsd: null }),
    },
    run: async () => {
      calls.push('execute');
      await run();
      return {};
    },
    dispose: () => {
      calls.push('dispose');
    },
  } as unknown as NodeCreatedProcessor;
}
const metadata = {
  projectId: 'p',
  sourceProjectName: 'P',
  sourceProjectRelativePath: 'P.rivet-project',
  endpointName: 'p',
  runKind: 'published' as const,
};

test('durable recording defaults on and preserves explicit opt-out', async () => {
  const key = 'RIVET_RECORDING_DURABILITY_ENABLED';
  for (const [value, enabled] of [
    [undefined, true],
    ['', true],
    ['  ', true],
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [' false ', false],
  ] as const) {
    await withScopedEnv([key], { [key]: value }, () => {
      assert.equal(recordingDurabilityEnabled(), enabled);
    });
  }
  await withScopedEnv([key], { [key]: 'invalid' }, () => {
    assert.throws(recordingDurabilityEnabled, /must be true or false/);
  });
});

test('failed trace preparation holds its reservation until sibling compression settles', () => {
  const compiled = new URL(
    import.meta.url.endsWith('.ts') ? '../../dist/studio-server-api/src/' : '../',
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import zlib from 'node:zlib';
      import { syncBuiltinESMExports } from 'node:module';
      import { randomUUID } from 'node:crypto';
      import { setImmediate } from 'node:timers/promises';
      const finish = [];
      zlib.gzip = (_bytes, _options, callback) => finish.push(() => callback(null, Buffer.from('compressed')));
      syncBuiltinESMExports();
      const { ManagedRecordingEvidence } = await import(${JSON.stringify(new URL('routes/workflows/managed/recording-evidence.js', compiled).href)});
      const handle = { id: randomUUID(), token: randomUUID() };
      const row = { run_id: handle.id, workflow_id: 'project', state: 'succeeded', availability: 'pending',
        upload_until: new Date(Date.now() + 60000), input_json: { runKind: 'published' },
        manifest_json: { compression: true, artifacts: [{ key: 'trace', decodedBytes: 999 }], row: { recordingBlobKey: 'trace' } } };
      const repository = new ManagedRecordingEvidence({ initialize: async () => {}, pool: { query: async () => ({ rows: [row] }) } });
      const project = { metadata: { id: 'project', title: 'Test', description: '' }, graphs: {} };
      let settled = false;
      const work = repository.persist({ sourceProject: project, executedProject: project, executedDatasets: [],
        recordingSerialized: '{}', runKind: 'published', status: 'succeeded', durationMs: 1 }, handle)
        .then(() => null, error => { settled = true; return error; });
      await setImmediate();
      assert.equal(finish.length, 1, 'Sibling gzip preparation started');
      assert.equal(settled, false, 'A failed trace must not release ownership while gzip is still pending');
      finish[0]();
      assert.match((await work).message, /differs from its manifest/);
    `,
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('history distinguishes accepted execution, expired ownership and deleted replay readiness', () => {
  const row = {
    run_id: randomUUID(),
    created_at: new Date(),
    lease_until: new Date(Date.now() + 180_000),
    state: 'accepted',
    availability: 'pending',
    input_json: metadata,
    outcome_json: null,
    child_coverage: 'unknown',
    handoff_ready: false,
  } as EvidenceRow;
  assert.equal(evidenceSummary(row).state, 'accepted');
  assert.equal(evidenceSummary({ ...row, lease_until: new Date(0) }).state, 'unknown');
  assert.equal(evidenceSummary({ ...row, availability: 'deleted', handoff_ready: true }).handoffReady, false);
});

test('recording registration does not delay graph execution or completion', { timeout: 5_000 }, async (t) => {
  const calls: string[] = [],
    outcomes: RunEvidenceOutcome[] = [];
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  t.after(() => accept());
  const repository = {
    outcome: async (_handle: unknown, outcome: RunEvidenceOutcome) => {
      calls.push('outcome');
      outcomes.push(outcome);
    },
    release: () => {},
  } as unknown as RunEvidenceRepository;
  const handle = { id: randomUUID(), token: randomUUID() };
  const session = new ExecutionSession(
    fakeProcessor(calls, async () => {}),
    {
      recording: true,
      evidence: metadata,
      beginEvidence: () => ({ handle, repository, registration: accepted }),
    },
  );
  const snapshot = await session.run();
  assert.deepEqual(calls, ['execute', 'dispose']);
  assert.equal(outcomes.length, 0);
  accept();
  await snapshot.evidenceCompletion;
  assert.deepEqual(calls, ['execute', 'dispose', 'outcome']);
  assert.equal(snapshot.evidenceHandle?.id, handle.id);
  assert.equal(outcomes[0]?.state, 'succeeded');
});
test('recording registration failure cannot reject an otherwise successful graph', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls: string[] = [];
  const session = new ExecutionSession(
    fakeProcessor(calls, async () => {}),
    {
      recording: true,
      evidence: metadata,
      beginEvidence: () => {
        throw new Error('unconfirmed');
      },
    },
  );
  const result = await session.run();
  assert.deepEqual(calls, ['execute', 'dispose']);
  assert.equal(result.invoked, true);
  assert.notEqual(result.recorder, null);
  assert.equal(result.failure, undefined);
});
test('a recording outcome-write failure cannot replace successful graph results', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls: string[] = [],
    handle = { id: randomUUID(), token: randomUUID() };
  const repository = {
    outcome: async () => {
      throw new Error('offline');
    },
    release: () => {},
  } as unknown as RunEvidenceRepository;
  const session = new ExecutionSession(
    fakeProcessor(calls, async () => {}),
    { recording: true, evidence: metadata, beginEvidence: () => ({ handle, repository }) },
  );
  const result = await session.run();
  assert.equal(result.status, 'succeeded');
  await result.evidenceCompletion;
  assert.deepEqual(calls, ['execute', 'dispose']);
});

test('a failed child-coverage write does not suppress the known root outcome', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls: string[] = [];
  let savedOutcome: RunEvidenceOutcome | undefined;
  let savedIncompleteChildren: boolean | undefined;
  const repository = {
    childIncomplete: async () => {
      calls.push('child');
      throw new Error('coverage update failed');
    },
    outcome: async (_handle: unknown, outcome: RunEvidenceOutcome, incompleteChildren: boolean) => {
      calls.push('outcome');
      savedOutcome = outcome;
      savedIncompleteChildren = incompleteChildren;
    },
    release: () => {
      calls.push('release');
    },
  } as unknown as RunEvidenceRepository;
  const owner = { handle: { id: randomUUID(), token: randomUUID() }, repository };
  await incompleteChildEvidence(owner);
  await completeRunEvidence(owner, { state: 'failed' });
  assert.deepEqual(calls, ['child', 'outcome', 'release']);
  assert.equal(savedOutcome?.state, 'failed');
  assert.equal(savedIncompleteChildren, true);
});
test('durable upload retries classify transient storage errors without retrying bad content or permissions', () => {
  assert.equal(retryableRecordingStorageError({ $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(retryableRecordingStorageError({ code: 'ECONNRESET' }), true);
  assert.equal(retryableRecordingStorageError({ $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(retryableRecordingStorageError(new Error('bad checksum')), false);
  assert.equal(validEvidenceHandle({ id: randomUUID(), token: randomUUID() }), true);
  assert.equal(validEvidenceHandle({ id: 'not-a-run', token: randomUUID() }), false);
});

test('a still-running processor never receives a fabricated terminal outcome', async () => {
  const outcomes: RunEvidenceOutcome[] = [];
  const unavailableReasons: string[] = [];
  const processor = fakeProcessor([], async () => {
    throw new Error('observation lost');
  });
  Object.defineProperty(processor.processor, 'isRunning', { value: true });
  const repository = {
    outcome: async (_handle: unknown, outcome: RunEvidenceOutcome) => {
      outcomes.push(outcome);
    },
    unavailable: async (_handle: unknown, reason: string) => {
      unavailableReasons.push(reason);
    },
    release: () => {},
  } as unknown as RunEvidenceRepository;
  const session = new ExecutionSession(processor, {
    recording: true,
    evidence: metadata,
    beginEvidence: () => ({ handle: { id: randomUUID(), token: randomUUID() }, repository }),
  });
  const result = await session.run();
  await result.evidenceCompletion;
  assert.equal(outcomes[0]?.state, 'unknown');
  assert.equal(result.recorder, null);
  assert.deepEqual(unavailableReasons, ['capture_incomplete']);
});

test('unfinished capture is withheld even when durable metadata is disabled', async () => {
  const processor = fakeProcessor([], async () => {
    throw new Error('observation lost');
  });
  Object.defineProperty(processor.processor, 'isRunning', { value: true });
  const result = await new ExecutionSession(processor, { recording: true }).run();
  assert.equal(result.status, 'failed');
  assert.equal(result.recorder, null);
  assert.equal(result.evidenceHandle, undefined);
});

test('slow or failing asynchronous metadata never holds the execution result', { timeout: 5_000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  t.after(() => release());
  const repository = {
    outcome: async () => {
      entered();
      await gate;
    },
    release: () => {},
  } as unknown as RunEvidenceRepository;
  const session = new ExecutionSession(
    fakeProcessor([], async () => {}),
    {
      recording: true,
      evidence: metadata,
      beginEvidence: () => ({ handle: { id: randomUUID(), token: randomUUID() }, repository }),
    },
  );
  const result = await session.run();
  assert.equal(result.status, 'succeeded');
  await started;
  release();
  await result.evidenceCompletion;
  const rejected = new ExecutionSession(
    fakeProcessor([], async () => {}),
    {
      recording: true,
      evidence: metadata,
      beginEvidence: () => ({
        handle: { id: randomUUID(), token: randomUUID() },
        registration: deferEvidenceWork(async () => {
          throw new Error('offline');
        }),
      }),
    },
  );
  const success = await rejected.run();
  assert.equal(success.status, 'succeeded');
  await success.evidenceCompletion;
});

test('repeated missing child captures enqueue one update after registration', { timeout: 5_000 }, async (t) => {
  let register!: () => void;
  const registration = new Promise<void>((resolve) => {
    register = resolve;
  });
  t.after(() => register());
  let updates = 0;
  const owner = {
    handle: { id: randomUUID(), token: randomUUID() },
    registration,
    repository: {
      childIncomplete: async () => {
        updates++;
      },
    } as unknown as RunEvidenceRepository,
  };
  const pending = Array.from({ length: 100 }, () => incompleteChildEvidence(owner));
  assert.equal(updates, 0);
  register();
  await Promise.all(pending);
  assert.equal(updates, 1);
});

test('background metadata drain includes follow-up work and survives a failed job', async () => {
  const calls: string[] = [];
  const failure = deferEvidenceWork(async () => {
    throw new Error('expected failure');
  });
  const rejected = assert.rejects(failure, /expected failure/);
  void deferEvidenceWork(async () => {
    calls.push('parent');
    void deferEvidenceWork(async () => {
      calls.push('child');
    });
  });
  await flushEvidenceWork();
  await rejected;
  assert.deepEqual(calls, ['parent', 'child']);
  assert.equal(pendingEvidenceWorkCount(), 0);
});

test('deferred raw captures stay count-bounded without serializing in admission', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const store = createWorkflowRecordingStore({
    maxPendingWrites: 0,
    rebuildIndex: async () => {},
    cleanupStorage: async () => {},
    setSchemaVersion: async () => {},
    resetDatabaseForTests: async () => {},
  });
  let accepted = 0,
    serialized = 0;
  for (let i = 0; i < 100; i++)
    if (
      store.enqueuePersistence(
        async () => {
          serialized++;
        },
        undefined,
        0,
        { deferredCapture: true },
      )
    )
      accepted++;
  assert.equal(serialized, 0);
  assert.ok(accepted > 0 && accepted <= 65);
  await store.flush();
  assert.equal(serialized, accepted);
});
test('accepted recording captures survive disabling recording without bypassing queue limits', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  await withScopedEnv(['RIVET_RECORDINGS_ENABLED'], { RIVET_RECORDINGS_ENABLED: 'false' }, async () => {
    const store = createWorkflowRecordingStore({
      maxPendingWrites: 1,
      rebuildIndex: async () => {},
      cleanupStorage: async () => {},
      setSchemaVersion: async () => {},
      resetDatabaseForTests: async () => {},
    });
    let saved = 0;
    const persist = async () => {
      saved++;
    };
    assert.equal(store.enqueuePersistence(persist), false);
    const accepted = { deferredCapture: true, acceptedEvidence: true };
    assert.equal(store.enqueuePersistence(persist, undefined, 0, accepted), true);
    assert.equal(store.enqueuePersistence(persist, undefined, 0, accepted), true);
    assert.equal(store.enqueuePersistence(persist, undefined, 0, accepted), false);
    assert.equal(saved, 0);
    await store.flush();
    assert.equal(saved, 2);
  });
});

test('retained-payload budget bounds queued memory even when the count limit is unlimited', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const store = createWorkflowRecordingStore({
    maxPendingWrites: 0,
    rebuildIndex: async () => {},
    cleanupStorage: async () => {},
    setSchemaVersion: async () => {},
    resetDatabaseForTests: async () => {},
  });
  assert.equal(
    store.enqueuePersistence(async () => {}, undefined, 200 * 1024 * 1024),
    true,
  );
  assert.equal(
    store.enqueuePersistence(async () => {}, undefined, 100 * 1024 * 1024),
    false,
  );
  await store.flush();
  assert.equal(
    store.enqueuePersistence(async () => {}, undefined, 200 * 1024 * 1024),
    true,
  );
  await store.flush();
});
