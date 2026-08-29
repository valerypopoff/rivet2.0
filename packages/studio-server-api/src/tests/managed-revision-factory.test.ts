import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedWorkflowRevisionFactory } from '../routes/workflows/managed/revision-factory.js';

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
