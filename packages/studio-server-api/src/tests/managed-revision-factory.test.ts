import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';

import { createManagedWorkflowRevisionFactory } from '../routes/workflows/managed/revision-factory.js';
import type { RecordingInsertRowData } from '../routes/workflows/managed/types.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';

function createRevisionForCleanupTest() {
  return {
    project_blob_key: 'blob-a',
    dataset_blob_key: 'blob-b',
  };
}

test('managed pre-commit blob cleanup queues known objects instead of directly deleting them', async () => {
  const queued: Array<{ domain: string; keys: Array<string | null | undefined> }> = [];
  const deleted: string[] = [];
  const factory = createManagedWorkflowRevisionFactory({
    blobStore: {
      delete: async (key: string | null | undefined) => {
        if (key) deleted.push(key);
      },
    } as never,
    queueObjectDeletions: async (domain, keys) => {
      queued.push({ domain, keys });
      return keys.filter((key): key is string => Boolean(key)).length;
    },
  });
  let onRollback: (() => Promise<void>) | undefined;

  factory.scheduleRevisionBlobCleanup(
    {
      onCommit: () => {},
      onRollback: (callback) => {
        onRollback = callback;
      },
    },
    createRevisionForCleanupTest(),
  );
  await onRollback?.();

  assert.deepEqual(queued, [
    {
      domain: 'workflow-precommit-blob-cleanup',
      keys: ['blob-a', 'blob-b'],
    },
  ]);
  assert.deepEqual(deleted, []);
});

test('managed pre-commit cleanup never falls back to an unchecked delete when outbox persistence fails', async () => {
  const deleted: string[] = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const factory = createManagedWorkflowRevisionFactory({
      blobStore: {
        delete: async (key: string | null | undefined) => {
          if (key) deleted.push(key);
        },
      } as never,
      queueObjectDeletions: async () => {
        throw new Error('PostgreSQL unavailable');
      },
    });
    let onRollback: (() => Promise<void>) | undefined;

    factory.scheduleRevisionBlobCleanup(
      {
        onCommit: () => {},
        onRollback: (callback) => {
          onRollback = callback;
        },
      },
      createRevisionForCleanupTest(),
    );
    await onRollback?.();
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(deleted, []);
});

test('partial revision upload preserves its original error when cleanup and logging also fail', async (t) => {
  t.mock.method(console, 'error', () => {
    throw new Error('logger unavailable');
  });
  const uploadFailure = new Error('dataset upload failed');
  const attempted: string[] = [];
  let queued: Array<string | null | undefined> = [];
  const factory = createManagedWorkflowRevisionFactory({
    blobStore: {
      putText: async (key: string) => {
        attempted.push(key);
        if (key.endsWith('dataset.rivet-data')) throw uploadFailure;
      },
    } as never,
    queueObjectDeletions: async (_reason, keys) => {
      queued = keys;
      throw new Error('outbox unavailable');
    },
  });
  await assert.rejects(
    factory.createRevision('owner', createBlankProjectFile('Project'), 'dataset'),
    (error) => error === uploadFailure,
  );
  assert.equal(attempted.length, 2);
  assert.deepEqual(queued, attempted, 'Factory owns exactly the two partial-upload keys');
});

test('recording insert failures are not replayed and never queue possibly shared artifacts', async (t) => {
  t.mock.method(console, 'warn', () => {
    throw new Error('logger unavailable');
  });
  for (const code of ['ECONNRESET', '23505']) {
    let calls = 0;
    const queued: unknown[] = [];
    const failure = Object.assign(new Error('insert acknowledgement unavailable'), { code });
    const pool = new Pool();
    t.mock.method(pool, 'query', async () => {
      calls++;
      throw failure;
    });
    const factory = createManagedWorkflowRevisionFactory({
      blobStore: {} as never,
      queueObjectDeletions: async (_reason, keys) => {
        queued.push(...keys);
        return keys.length;
      },
    });
    const row = {
      recordingId: 'run',
      workflowId: 'project',
      sourceProjectName: 'Project',
      sourceProjectRelativePath: 'Project',
      runKind: 'latest',
      status: 'succeeded',
      durationMs: 1,
      endpointNameAtExecution: '',
      errorMessage: null,
      recordingBlobKey: 'recording',
      replayProjectBlobKey: 'project',
      replayDatasetBlobKey: 'dataset',
      hasReplayDataset: true,
      recordingCompressedBytes: 1,
      recordingUncompressedBytes: 1,
      projectCompressedBytes: 1,
      projectUncompressedBytes: 1,
      datasetCompressedBytes: 1,
      datasetUncompressedBytes: 1,
    } satisfies RecordingInsertRowData;
    try {
      await assert.rejects(
        factory.insertRecordingRow(pool, row, {
          timestampMode: 'now',
          onConflict: 'fail',
          cleanupContext: 'recording insert failure',
        }),
        (error) => error === failure,
      );
      assert.equal(calls, 1, `${code}: an uncertain write is not repeated`);
      assert.deepEqual(queued, [], `${code}: artifacts remain for reconciliation`);
    } finally {
      await pool.end();
    }
  }
});

test('failed recording uploads settle all writers but do not queue keys a concurrent import may share', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('one upload failed');
  const queued: unknown[] = [];
  const factory = createManagedWorkflowRevisionFactory({
    blobStore: {
      putText: async (key: string) => {
        if (key.endsWith('recording.rivet-recording')) throw failure;
        await slow;
      },
    } as never,
    queueObjectDeletions: async (_reason, keys) => {
      queued.push(...keys);
      return keys.length;
    },
  });
  let settled = false;
  const operation = factory
    .uploadRecordingBlobs(
      'project',
      'shared-id',
      {
        recording: 'recording',
        replayProject: 'project',
        replayDataset: null,
      },
      'recording import upload failure',
    )
    .finally(() => {
      settled = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'Every accepted upload must settle before reporting failure');
  finish();
  await assert.rejects(operation, (error) => error === failure);
  assert.deepEqual(queued, []);
});

test('a synchronous recording adapter failure still waits for an already-started sibling', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('synchronous adapter failure');
  let queued = 0;
  const factory = createManagedWorkflowRevisionFactory({
    blobStore: {
      putText(key: string) {
        if (key.endsWith('recording.rivet-recording')) return slow;
        throw failure;
      },
    } as never,
    queueObjectDeletions: async () => {
      queued++;
      return 0;
    },
  });
  let settled = false;
  const result = factory
    .uploadRecordingBlobs(
      'project',
      'shared-id',
      {
        recording: 'recording',
        replayProject: 'project',
        replayDataset: null,
      },
      'recording upload failure',
    )
    .then(
      () => undefined,
      (error) => {
        settled = true;
        return error;
      },
    );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.equal(await result, failure);
  assert.equal(queued, 0);
});
