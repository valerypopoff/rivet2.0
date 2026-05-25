import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowRecordingStore } from '../routes/workflows/recordings-store.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';

const recordingEnvKeys = [
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_RECORDINGS_MAX_PENDING_WRITES',
] as const;

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
    'cleanup',
    'schema:2',
    'rebuild:/tmp/workflows-b',
    'cleanup',
    'schema:2',
  ]);
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
  await withScopedEnv(recordingEnvKeys, {
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDINGS_MAX_PENDING_WRITES: '0',
  }, async () => {
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

test('recordings store drops persistence tasks once the configured queue limit is exceeded', async () => {
  await withScopedEnv(recordingEnvKeys, {
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDINGS_MAX_PENDING_WRITES: '1',
  }, async () => {
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
  await withScopedEnv(recordingEnvKeys, {
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDINGS_MAX_PENDING_WRITES: '1',
  }, async () => {
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

    assert.equal(store.enqueuePersistence(async () => {
      persisted.push('first');
      await firstTask;
    }), true);

    await waitForImmediate();

    assert.deepEqual(persisted, ['first']);
    assert.equal(store.enqueuePersistence(async () => {
      persisted.push('second');
    }), true);
    assert.equal(store.enqueuePersistence(async () => {
      persisted.push('third');
    }), false);

    releaseFirstTask();
    await waitForImmediate();
    await waitForImmediate();

    assert.deepEqual(persisted, ['first', 'second']);
  });
});

test('recordings store reset cancels a pending persistence worker start', async () => {
  await withScopedEnv(recordingEnvKeys, {
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDINGS_MAX_PENDING_WRITES: '0',
  }, async () => {
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

    assert.equal(store.enqueuePersistence(async () => {
      taskRan = true;
    }), true);

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

  assert.deepEqual(initializedRoots, [
    'rebuild:/tmp/workflows-a',
    'cleanup:1',
    'schema:2',
  ]);
});
