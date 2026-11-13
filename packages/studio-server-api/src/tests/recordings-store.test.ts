import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkflowRecordingStore as createStore } from '../routes/workflows/recordings-store.js';
import {
  RUN_RECORDINGS_SETTINGS_RELATIVE_PATH,
  readWorkflowRecordingLimitSettings,
} from '../routes/workflows/recordings-config.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';
import { reportRecordingFailure } from '../routes/workflows/recording-diagnostics.js';

const recordingEnvKeys = [
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_RECORDINGS_MAX_PENDING_WRITES',
  'RIVET_APP_DATA_ROOT',
] as const;

function createWorkflowRecordingStore(options: Parameters<typeof createStore>[0]) {
  return createStore({ ...options, maxPendingWrites: readWorkflowRecordingLimitSettings().maxPendingWrites });
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withRunRecordingsAppSettings(settings: { maxPendingWrites: number }, run: () => Promise<void> | void) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-recording-settings-'));
  const settingsPath = path.join(tempRoot, RUN_RECORDINGS_SETTINGS_RELATIVE_PATH);

  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        maxPendingWrites: settings.maxPendingWrites,
        maxRunsPerEndpoint: 100,
        retentionDays: 14,
      }),
    );

    await withScopedEnv(
      recordingEnvKeys,
      {
        RIVET_RECORDINGS_ENABLED: 'true',
        RIVET_RECORDINGS_MAX_PENDING_WRITES: '1',
        RIVET_APP_DATA_ROOT: tempRoot,
      },
      run,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('recordings store reuses storage initialization for the same root and resets on root changes', async () => {
  const initializedRoots: string[] = [];
  const store = createWorkflowRecordingStore({
    async rebuildIndex(root) {
      initializedRoots.push(`rebuild:${root}`);
    },
    async cleanupStorage() {
      initializedRoots.push('cleanup');
    },
    async setSchemaVersion(version) {
      initializedRoots.push(`schema:${version}`);
    },
    async resetDatabaseForTests() {},
  });

  await store.ensureStorage('/tmp/workflows-a');
  await store.ensureStorage('/tmp/workflows-a');
  await store.ensureStorage('/tmp/workflows-b');

  assert.deepEqual(initializedRoots, [
    'rebuild:/tmp/workflows-a',
    'schema:2',
    'cleanup',
    'rebuild:/tmp/workflows-b',
    'schema:2',
    'cleanup',
  ]);
});

test('offline migration can rebuild a recording index without applying retention cleanup', async () => {
  const calls: string[] = [];
  const store = createWorkflowRecordingStore({
    async rebuildIndex() {
      calls.push('rebuild');
    },
    async cleanupStorage() {
      calls.push('cleanup');
    },
    async setSchemaVersion() {
      calls.push('schema');
    },
    async resetDatabaseForTests() {},
  });
  await store.ensureStorage('/frozen-recordings', { skipCleanup: true });
  assert.deepEqual(calls, ['rebuild', 'schema']);
});

test('recordings store reruns cleanup when a second cleanup request arrives mid-flight', async () => {
  let cleanupCount = 0;
  let releaseFirstCleanup: () => void = () => {};
  const firstCleanup = new Promise<void>((resolve) => {
    releaseFirstCleanup = resolve;
  });

  const store = createWorkflowRecordingStore({
    async rebuildIndex() {},
    async cleanupStorage() {
      cleanupCount += 1;
      if (cleanupCount === 1) {
        await firstCleanup;
      }
    },
    async setSchemaVersion() {},
    async resetDatabaseForTests() {},
  });

  store.scheduleCleanup();
  store.scheduleCleanup();
  releaseFirstCleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cleanupCount, 2);
});

test('recordings store runs persistence tasks asynchronously and drains them in FIFO order', async () => {
  await withRunRecordingsAppSettings({ maxPendingWrites: 0 }, async () => {
    const persisted: string[] = [];
    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {},
      async setSchemaVersion() {},
      async resetDatabaseForTests() {},
    });

    const firstAccepted = store.enqueuePersistence(async () => {
      persisted.push('first');
    });
    const secondAccepted = store.enqueuePersistence(async () => {
      persisted.push('second');
    });

    assert.equal(firstAccepted, true);
    assert.equal(secondAccepted, true);
    assert.deepEqual(persisted, []);

    await waitForImmediate();

    assert.deepEqual(persisted, ['first', 'second']);
  });
});

test('recordings store flush starts scheduled work and waits for persistence and cleanup', async () => {
  await withRunRecordingsAppSettings({ maxPendingWrites: 0 }, async () => {
    let releasePersistence: () => void = () => {};
    let releaseCleanup: () => void = () => {};
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const events: string[] = [];
    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {
        events.push('cleanup-started');
        await cleanupGate;
        events.push('cleanup-finished');
      },
      async setSchemaVersion() {},
      async resetDatabaseForTests() {},
    });

    assert.equal(
      store.enqueuePersistence(async () => {
        events.push('persistence-started');
        await persistenceGate;
        events.push('persistence-finished');
        store.scheduleCleanup();
      }),
      true,
    );

    let flushed = false;
    const flushPromise = store.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    assert.deepEqual(events, ['persistence-started']);
    assert.equal(flushed, false);

    releasePersistence();
    await waitForImmediate();
    assert.deepEqual(events, ['persistence-started', 'persistence-finished', 'cleanup-started']);
    assert.equal(flushed, false);

    releaseCleanup();
    await flushPromise;
    assert.deepEqual(events, ['persistence-started', 'persistence-finished', 'cleanup-started', 'cleanup-finished']);
    assert.equal(flushed, true);
  });
});

test('recordings store drops persistence tasks once the configured queue limit is exceeded', async () => {
  await withRunRecordingsAppSettings({ maxPendingWrites: 1 }, async () => {
    let releaseFirstTask: () => void = () => {};
    const firstTask = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
    const persisted: string[] = [];

    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {},
      async setSchemaVersion() {},
      async resetDatabaseForTests() {},
    });

    const firstAccepted = store.enqueuePersistence(async () => {
      persisted.push('first');
      await firstTask;
    });
    const secondAccepted = store.enqueuePersistence(async () => {
      persisted.push('second');
    });
    const thirdAccepted = store.enqueuePersistence(async () => {
      persisted.push('third');
    });

    assert.equal(firstAccepted, true);
    assert.equal(secondAccepted, true);
    assert.equal(thirdAccepted, false);

    releaseFirstTask();
    await waitForImmediate();
    await waitForImmediate();

    assert.deepEqual(persisted, ['first', 'second']);
  });
});

test('recordings store enforces pending write limits while a persistence task is active', async () => {
  await withRunRecordingsAppSettings({ maxPendingWrites: 1 }, async () => {
    let releaseFirstTask: () => void = () => {};
    const firstTask = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
    const persisted: string[] = [];

    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {},
      async setSchemaVersion() {},
      async resetDatabaseForTests() {},
    });

    assert.equal(
      store.enqueuePersistence(async () => {
        persisted.push('first');
        await firstTask;
      }),
      true,
    );

    await waitForImmediate();

    assert.deepEqual(persisted, ['first']);
    assert.equal(
      store.enqueuePersistence(async () => {
        persisted.push('second');
      }),
      true,
    );
    assert.equal(
      store.enqueuePersistence(async () => {
        persisted.push('third');
      }),
      false,
    );

    releaseFirstTask();
    await waitForImmediate();
    await waitForImmediate();

    assert.deepEqual(persisted, ['first', 'second']);
  });
});

test('recordings store reset cancels a pending persistence worker start', async () => {
  await withRunRecordingsAppSettings({ maxPendingWrites: 0 }, async () => {
    let taskRan = false;
    let resetCount = 0;
    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {},
      async setSchemaVersion() {},
      async resetDatabaseForTests() {
        resetCount += 1;
      },
    });

    assert.equal(
      store.enqueuePersistence(async () => {
        taskRan = true;
      }),
      true,
    );

    await store.resetForTests();
    await waitForImmediate();

    assert.equal(taskRan, false);
    assert.equal(resetCount, 1);
  });
});

test('recordings store startup does not fail permanently when cleanup logs a non-fatal error', async () => {
  const initializedRoots: string[] = [];
  let cleanupAttempts = 0;

  const store = createWorkflowRecordingStore({
    async rebuildIndex(root) {
      initializedRoots.push(`rebuild:${root}`);
    },
    async cleanupStorage() {
      cleanupAttempts += 1;
      initializedRoots.push(`cleanup:${cleanupAttempts}`);
      if (cleanupAttempts === 1) {
        return;
      }
    },
    async setSchemaVersion(version) {
      initializedRoots.push(`schema:${version}`);
    },
    async resetDatabaseForTests() {},
  });

  await store.ensureStorage('/tmp/workflows-a');
  await store.ensureStorage('/tmp/workflows-a');

  assert.deepEqual(initializedRoots, ['rebuild:/tmp/workflows-a', 'schema:2', 'cleanup:1']);
});

const storageCallbacks = {
  async rebuildIndex() {},
  async cleanupStorage() {},
  async setSchemaVersion() {},
  async resetDatabaseForTests() {},
};

test('queue observations remain readable without a serving policy while admission stays closed', async () => {
  const store = createStore(storageCallbacks);
  assert.deepEqual(store.getPersistenceMetrics(), { activeWrites: 0, pendingWrites: 0, maxPendingWrites: null });
  assert.throws(() => store.enqueuePersistence(async () => {}), /not initialized/);
  const path = '/observation/settings.json';
  await store.initializeQueuePolicy({
    descriptor: { getPath: () => path },
    read: async () => ({ path, value: { maxPendingWrites: 2 } }),
    subscribe: () => () => {},
  });
  let saved = 0;
  assert.equal(
    store.enqueuePersistence(async () => {
      saved++;
    }),
    true,
  );
  assert.equal(store.getPersistenceMetrics().maxPendingWrites, 2);
  store.disposeQueuePolicy();
  assert.deepEqual(store.getPersistenceMetrics(), { activeWrites: 0, pendingWrites: 1, maxPendingWrites: null });
  assert.throws(() => store.enqueuePersistence(async () => {}), /not initialized/);
  await store.flush();
  assert.equal(saved, 1);
  assert.equal(store.getPersistenceMetrics().pendingWrites, 0);
});

test('queue policy seeds unchanged settings, follows newer notifications and ignores disposed generations', async () => {
  const store = createStore(storageCallbacks);
  assert.throws(() => store.enqueuePersistence(async () => {}), /not initialized/);
  type Snapshot = { path: string; value: { maxPendingWrites: number } };
  const listeners: Array<(snapshot: Snapshot) => void> = [];
  let resolve!: (snapshot: Snapshot) => void;
  let unsubscribed = 0;
  let currentPath = '/first/settings.json';
  const source = {
    descriptor: { getPath: () => currentPath },
    read: () =>
      new Promise<Snapshot>((done) => {
        resolve = done;
      }),
    subscribe: (listener: (snapshot: Snapshot) => void) => {
      listeners.push(listener);
      return () => {
        unsubscribed++;
      };
    },
  };
  const first = store.initializeQueuePolicy(source);
  listeners[0]!({ path: currentPath, value: { maxPendingWrites: 2 } });
  resolve({ path: currentPath, value: { maxPendingWrites: 9 } });
  await first;
  assert.equal(store.getPersistenceMetrics().maxPendingWrites, 2, 'a late initial read cannot undo a newer update');
  listeners[0]!({ path: '/other/settings.json', value: { maxPendingWrites: 50 } });
  assert.equal(store.getPersistenceMetrics().maxPendingWrites, 2);
  listeners[0]!({ path: currentPath, value: { maxPendingWrites: 1 } });
  assert.equal(store.getPersistenceMetrics().maxPendingWrites, 1);
  store.disposeQueuePolicy();
  currentPath = '/second/settings.json';
  const second = store.initializeQueuePolicy(source);
  resolve({ path: currentPath, value: { maxPendingWrites: 0 } });
  await second;
  listeners[0]!({ path: '/first/settings.json', value: { maxPendingWrites: 10 } });
  assert.equal(
    store.getPersistenceMetrics().maxPendingWrites,
    0,
    'an unchanged initial read still seeds the new owner',
  );
  store.disposeQueuePolicy();
  assert.equal(unsubscribed, 2);
});

test('failed or disposed policy initialization cannot reopen admission or replace a newer owner', async () => {
  const store = createStore(storageCallbacks);
  const path = '/settings.json';
  let resolve!: (value: { path: string; value: { maxPendingWrites: number } }) => void;
  let fail = true;
  const source = {
    descriptor: { getPath: () => path },
    read: async () => {
      if (fail) throw new Error('read failed');
      return { path, value: { maxPendingWrites: 4 } };
    },
    subscribe: () => () => {},
  };
  await assert.rejects(store.initializeQueuePolicy(source), /read failed/);
  assert.throws(() => store.enqueuePersistence(async () => {}), /not initialized/);
  const pendingSource = {
    ...source,
    read: () =>
      new Promise<{ path: string; value: { maxPendingWrites: number } }>((done) => {
        resolve = done;
      }),
  };
  const pending = store.initializeQueuePolicy(pendingSource);
  store.disposeQueuePolicy();
  fail = false;
  await store.initializeQueuePolicy(source);
  resolve({ path, value: { maxPendingWrites: 100 } });
  await assert.rejects(pending, /disposed/);
  assert.equal(store.getPersistenceMetrics().maxPendingWrites, 4);
  store.disposeQueuePolicy();
});

test('a temporary retention failure cannot discard the first recording or invalidate its index', async (t) => {
  let rebuilds = 0;
  let fail = true;
  let saved = 0;
  const reports: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    reports.push(args);
    throw new Error('logging failed');
  });
  const store = createStore({
    ...storageCallbacks,
    maxPendingWrites: 2,
    async rebuildIndex() {
      rebuilds++;
    },
    async cleanupStorage() {
      if (fail) throw new Error('cleanup policy unavailable');
    },
  });
  await store.ensureStorage('/recordings');
  assert.equal(
    store.enqueuePersistence(async () => {
      saved++;
    }),
    true,
  );
  await store.flush();
  assert.equal(saved, 1);
  assert.equal(reports.length, 1);
  store.scheduleCleanup();
  await store.flush();
  assert.equal(reports.length, 2);
  fail = false;
  await store.ensureStorage('/recordings');
  store.scheduleCleanup();
  await store.flush();
  assert.equal(rebuilds, 1);
});

test('concurrent first writers wait for initial cleanup before publishing retention holds', async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const store = createStore({ ...storageCallbacks, maxPendingWrites: 1, cleanupStorage: () => cleanup });
  let ready = 0;
  const first = store.ensureStorage('/ordered-recordings').then(() => {
    ready++;
  });
  const second = store.ensureStorage('/ordered-recordings').then(() => {
    ready++;
  });
  await waitForImmediate();
  assert.equal(ready, 0);
  finish();
  await Promise.all([first, second]);
  assert.equal(ready, 2);
});

test('recording diagnostics retain bounded identifiers without arbitrary error or context contents', (t) => {
  const reports: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    reports.push(args);
  });
  reportRecordingFailure(new Error('sensitive prompt and API key'), {
    projectId: 'p'.repeat(300),
    correlationId: 'correlation\nforged',
    phase: 'persistence',
    ...{ unexpected: 'secret' },
  });
  const text = JSON.stringify(reports);
  assert.doesNotMatch(text, /sensitive|API key|secret|unexpected|\\n/);
  assert.equal((reports[0]![1] as { projectId: string }).projectId.length, 160);
  assert.match(text, /correlationforged/);
});

for (const field of ['name', 'message'] as const) {
  test(`recording diagnostics cannot throw when an error ${field} accessor fails`, () => {
    const error = new Error('notification failed');
    Object.defineProperty(error, field, {
      get() {
        throw new Error('error inspection failed');
      },
    });
    assert.doesNotThrow(() => reportRecordingFailure(error, { phase: 'notification' }));
  });
}

test('recording diagnostics cannot throw when the logger fails', (t) => {
  t.mock.method(console, 'error', () => {
    throw new Error('logging failed');
  });
  assert.doesNotThrow(() => reportRecordingFailure(new Error('notification failed')));
});

test('failed error reporting cannot interrupt the next accepted recording', async (t) => {
  const store = createStore({ ...storageCallbacks, maxPendingWrites: 2 });
  t.mock.method(console, 'error', () => {
    throw new Error('logging failed');
  });
  let saved = 0;
  assert.equal(
    store.enqueuePersistence(async () => {
      throw new Error('write failed');
    }),
    true,
  );
  assert.equal(
    store.enqueuePersistence(async () => {
      saved++;
    }),
    true,
  );
  await store.flush();
  assert.equal(saved, 1);
  assert.equal(store.getPersistenceMetrics().pendingWrites, 0);
});

test('a full recording queue returns rejection even when warning output fails', async (t) => {
  const store = createStore({ ...storageCallbacks, maxPendingWrites: 1 });
  t.mock.method(console, 'warn', () => {
    throw new Error('logging failed');
  });
  t.mock.method(console, 'error', () => {
    throw new Error('logging failed');
  });
  let saved = 0;
  assert.equal(
    store.enqueuePersistence(async () => {
      saved++;
    }),
    true,
  );
  assert.equal(
    store.enqueuePersistence(async () => {
      saved++;
    }),
    true,
  );
  try {
    assert.equal(
      store.enqueuePersistence(async () => {
        saved++;
      }),
      false,
    );
  } finally {
    await store.flush();
  }
  assert.equal(saved, 2);
});
