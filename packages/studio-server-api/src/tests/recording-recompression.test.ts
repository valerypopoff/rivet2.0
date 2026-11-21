import assert from 'node:assert/strict';
import test from 'node:test';
import { recompressRecordingBatch } from '../../maintenance/recording-recompression.js';
import { createRecordingBlobKey } from '../routes/workflows/managed/blob-store.js';
import {
  MAX_MANAGED_ARTIFACT_BYTES,
  prepareManagedTextArtifact,
} from '../routes/workflows/managed/artifact-descriptor.js';
import type { TransactionHooks } from '../routes/workflows/managed/types.js';

const installation = { deployment: 'fixture', epoch: '1' };
const options = {
  cutoff: '2026-02-01T00:00:00.000000Z',
  restoreIdentity: JSON.stringify(installation),
  assertReaders: async () => {},
  signal: new AbortController().signal,
};
const row = (id: string, key = createRecordingBlobKey('fixture', id, 'recording')) => ({
  recording_id: id,
  workflow_id: 'fixture',
  recording_blob_key: key,
  created_at: '2026-01-01T00:00:00.000123Z',
});

function context(rows: ReturnType<typeof row>[], read: (key: string) => Promise<Uint8Array>) {
  return {
    pool: {
      async query(sql: string) {
        if (sql.includes('rivet_restore_control.installation')) return { rows: [installation] };
        if (sql.startsWith('SELECT r.recording_id')) return { rows };
        assert.ok(sql.startsWith('INSERT INTO managed_object_deletion_outbox'), sql);
        return { rows: [], rowCount: 1 };
      },
    },
    blobStore: {
      getBytes: read,
      putArtifact: async () => {
        throw new Error('Unexpected upload');
      },
    },
    maintenance: {
      enqueueObjectDeletions: async () => {
        throw new Error('Unexpected deletion');
      },
    },
    withTransaction: async () => {
      throw new Error('Unexpected publication');
    },
  } as unknown as Parameters<typeof recompressRecordingBatch>[0];
}

test('failed COMMIT readback preserves an unpublished row for retry and recognizes a winner or deletion', async () => {
  const artifact = await prepareManagedTextArtifact(
    createRecordingBlobKey('fixture', 'commit', 'recording'),
    'sample '.repeat(1000),
    'gzip',
  );
  for (const outcome of ['old', 'new', 'other', 'deleted'] as const) {
    const commitError = new Error('lost COMMIT response');
    let attempts = 0,
      replacement = '';
    const objects = new Map([[artifact.descriptor.key, artifact.bytes]]);
    const deps = context([row('commit', artifact.descriptor.key)], async (key) => objects.get(key)!);
    deps.blobStore.putArtifact = async (descriptor, bytes) => {
      objects.set(descriptor.key, Buffer.from(bytes));
    };
    deps.maintenance.enqueueObjectDeletions = async () => 1;
    deps.withTransaction = async (run) => {
      attempts++;
      const client = {
        async query(sql: string, args: unknown[] = []) {
          if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('rivet_restore_control.installation')) return { rows: [installation] };
          if (sql.includes('SELECT recording_blob_key')) {
            const key = { old: artifact.descriptor.key, new: replacement, other: 'another-generation', deleted: null }[
              outcome
            ];
            return { rows: key === null ? [] : [{ recording_blob_key: key }] };
          }
          if (sql.startsWith('UPDATE workflow_recordings')) replacement = args[3] as string;
          else assert.match(sql, /^(SELECT 1 FROM|DELETE FROM) managed_object_deletion_outbox/);
          return { rows: [], rowCount: 1 };
        },
      };
      let settled: ((outcome: 'committed' | 'rolled-back' | 'unknown') => void) | undefined;
      const result = await run(client as never, {
        onCommit() {},
        onRollback() {},
        onSettled(task) {
          settled = task;
        },
      } satisfies TransactionHooks);
      if (attempts === 1) {
        settled?.('unknown');
        throw commitError;
      }
      return result;
    };
    if (outcome === 'old')
      await assert.rejects(recompressRecordingBatch(deps, options), (error) => error === commitError);
    else {
      const result = await recompressRecordingBatch(deps, options);
      assert.equal(result.converted, outcome === 'new' ? 1 : 0);
      assert.equal(result.skippedOrCompeting, outcome === 'new' ? 0 : 1);
    }
    assert.equal(attempts, 2, 'read back once; never replay the uncertain publication');
  }
});

for (const kind of ['corrupt', 'oversized legacy'] as const)
  test(`${kind} reads consume the work budget before another download starts`, async () => {
    const corrupt = kind === 'corrupt';
    const rows = await Promise.all(
      ['one', 'two', 'three'].map(async (id) => {
        const key = createRecordingBlobKey('fixture', id, 'recording');
        return row(id, corrupt ? (await prepareManagedTextArtifact(key, '12345678')).descriptor.key : key);
      }),
    );
    let reads = 0;
    const result = await recompressRecordingBatch(
      context(rows, async () => {
        reads++;
        return Buffer.alloc(corrupt ? 8 : 12);
      }),
      { ...options, maxDecodedBytes: 8, maxBatchDecodedBytes: corrupt ? 16 : MAX_MANAGED_ARTIFACT_BYTES },
    );
    assert.equal(reads, corrupt ? 2 : 1);
    assert.equal(result[corrupt ? 'corruptOrMissing' : 'oversized'], reads);
    assert.equal(result.budgetBytes, corrupt ? 16 : 12);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.after?.recordingId, corrupt ? 'two' : 'one');
  });

test('malformed resume cursors fail before reading storage', async () => {
  const deps = context([], async () => {
    throw new Error('Unexpected object read');
  });
  deps.pool.query = (() => {
    throw new Error('Unexpected database read');
  }) as typeof deps.pool.query;
  for (const override of [
    { cutoff: 1 },
    { after: null },
    { after: { createdAt: 1, recordingId: 'one' } },
    { after: { createdAt: options.cutoff, recordingId: 1 } },
    { after: { createdAt: options.cutoff, recordingId: '' } },
  ]) {
    await assert.rejects(recompressRecordingBatch(deps, { ...options, ...override } as never), /cursor/);
  }
});
