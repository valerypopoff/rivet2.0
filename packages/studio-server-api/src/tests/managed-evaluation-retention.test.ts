import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  createManagedEvaluationRetentionTask,
  getManagedEvaluationRetentionConfig,
} from '../evaluation-runs/managed-retention.js';
import type { ManagedWorkflowMaintenanceLease } from '../routes/workflows/managed/maintenance.js';

type Query = { sql: string; parameters: readonly unknown[] };

class FakeRetentionPool {
  readonly queries: Query[] = [];
  readonly deletedRecordings: string[] = [];
  readonly deletedSnapshots: string[] = [];
  readonly attemptedRecordingDeletes: string[] = [];
  readonly attemptedSnapshotDeletes: string[] = [];
  recordingDeleteRowCount = 1;
  recordingDeleteRowCounts: number[] | undefined;
  snapshotDeleteRowCount = 1;
  expiredRecordings = [{ project_id: 'project-a', recording_id: 'recording-a', run_id: 'run-a' }];
  orphanedSnapshots = [{ project_id: 'project-a', dataset_fingerprint: 'dataset-a' }];

  async connect() {
    return {
      query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
        this.queries.push({ sql, parameters });
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (normalized.startsWith('select recording.project_id')) {
          const limit = Number(parameters[0]);
          const rows = limit === 1 ? this.expiredRecordings.splice(0, 1) : this.expiredRecordings.slice(0, limit);
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (normalized.startsWith('select snapshot.project_id')) {
          const limit = Number(parameters[0]);
          const rows = limit === 1 ? this.orphanedSnapshots.splice(0, 1) : this.orphanedSnapshots.slice(0, limit);
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (normalized.startsWith('delete from evaluation_recordings as recording')) {
          this.attemptedRecordingDeletes.push(String(parameters[1]));
          const rowCount = this.recordingDeleteRowCounts?.shift() ?? this.recordingDeleteRowCount;
          if (rowCount === 1) this.deletedRecordings.push(String(parameters[1]));
          return { rows: [] as T[], rowCount };
        }
        if (normalized.startsWith('delete from evaluation_dataset_snapshots as snapshot')) {
          this.attemptedSnapshotDeletes.push(String(parameters[1]));
          if (this.snapshotDeleteRowCount === 1) this.deletedSnapshots.push(String(parameters[1]));
          return { rows: [] as T[], rowCount: this.snapshotDeleteRowCount };
        }
        throw new Error(`Unexpected retention SQL: ${normalized}`);
      },
      release() {},
    };
  }
}

function createLease(assertions: { count: number }): ManagedWorkflowMaintenanceLease {
  return {
    holderId: 'test-holder',
    fencingToken: 1,
    assertCurrent: async () => {
      assertions.count += 1;
    },
  };
}

test('managed Evaluation retention validates an explicit lifecycle mode', () => {
  assert.deepEqual(getManagedEvaluationRetentionConfig({}, 5), { batchSize: 5, mode: 'enforce' });
  assert.deepEqual(getManagedEvaluationRetentionConfig({ RIVET_MANAGED_EVALUATION_RETENTION_MODE: 'audit' }, 5), {
    batchSize: 5,
    mode: 'audit',
  });
  assert.deepEqual(getManagedEvaluationRetentionConfig({ RIVET_MANAGED_EVALUATION_RETENTION_MODE: 'disabled' }, 5), {
    batchSize: 5,
    mode: 'disabled',
  });
  assert.throws(
    () => getManagedEvaluationRetentionConfig({ RIVET_MANAGED_EVALUATION_RETENTION_MODE: 'delete-everything' }),
    /must be disabled, audit, or enforce/,
  );
  assert.throws(() => getManagedEvaluationRetentionConfig({}, 0), /positive maintenance batch size/);
});

test('audit mode is read-only and its candidate queries exclude active hosted work', async () => {
  const pool = new FakeRetentionPool();
  const assertions = { count: 0 };
  const task = createManagedEvaluationRetentionTask({
    config: { batchSize: 10, mode: 'audit' },
    pool: pool as unknown as Pool,
  });

  await task(createLease(assertions));

  assert.deepEqual(pool.deletedRecordings, []);
  assert.deepEqual(pool.deletedSnapshots, []);
  assert.equal(assertions.count, 1);
  const recordingCandidateSql = pool.queries.find((query) =>
    query.sql.includes('FROM evaluation_recordings AS recording'),
  )?.sql;
  assert.match(recordingCandidateSql ?? '', /hosted\.status IN \('queued', 'running'\)/);
  assert.match(recordingCandidateSql ?? '', /job\.status IN \('queued', 'claimed', 'accepted'\)/);
  assert.doesNotMatch(recordingCandidateSql ?? '', /FOR UPDATE/);
  const snapshotCandidateSql = pool.queries.find((query) =>
    query.sql.includes('FROM evaluation_dataset_snapshots AS snapshot'),
  )?.sql;
  assert.match(snapshotCandidateSql ?? '', /run_json #>> '\{provenance,datasetFingerprint\}'/);
  assert.doesNotMatch(snapshotCandidateSql ?? '', /FOR UPDATE/);
});

test('enforcement is bounded, fenced, and deletes only candidates that still pass the SQL recheck', async () => {
  const pool = new FakeRetentionPool();
  const assertions = { count: 0 };
  const task = createManagedEvaluationRetentionTask({
    config: { batchSize: 2, mode: 'enforce' },
    pool: pool as unknown as Pool,
  });

  await task(createLease(assertions));

  assert.deepEqual(pool.deletedRecordings, ['recording-a']);
  assert.deepEqual(pool.deletedSnapshots, ['dataset-a']);
  assert.ok(assertions.count >= 3, 'the lease is checked before selection and before every destructive mutation');
  assert.equal(
    pool.queries.filter((query) => query.sql.includes('DELETE FROM evaluation_recordings AS recording')).length,
    1,
  );
  assert.equal(
    pool.queries.filter((query) => query.sql.includes('DELETE FROM evaluation_dataset_snapshots AS snapshot')).length,
    1,
  );
});
test('enforcement safely skips a candidate that no longer satisfies its delete predicate', async () => {
  const pool = new FakeRetentionPool();
  pool.recordingDeleteRowCount = 0;
  pool.snapshotDeleteRowCount = 0;
  const task = createManagedEvaluationRetentionTask({
    config: { batchSize: 1, mode: 'enforce' },
    pool: pool as unknown as Pool,
  });

  await task(createLease({ count: 0 }));

  assert.deepEqual(pool.attemptedRecordingDeletes, ['recording-a']);
  assert.deepEqual(pool.attemptedSnapshotDeletes, ['dataset-a']);
  assert.deepEqual(pool.deletedRecordings, []);
  assert.deepEqual(pool.deletedSnapshots, []);
});

test('enforcement locks a bounded page so a failed recheck cannot starve later Evaluation candidates', async () => {
  const pool = new FakeRetentionPool();
  pool.expiredRecordings = [
    { project_id: 'project-a', recording_id: 'recording-a', run_id: 'run-a' },
    { project_id: 'project-a', recording_id: 'recording-b', run_id: 'run-b' },
  ];
  pool.orphanedSnapshots = [];
  pool.recordingDeleteRowCounts = [0, 1];
  const task = createManagedEvaluationRetentionTask({
    config: { batchSize: 2, mode: 'enforce' },
    pool: pool as unknown as Pool,
  });

  await task(createLease({ count: 0 }));

  assert.deepEqual(pool.attemptedRecordingDeletes, ['recording-a', 'recording-b']);
  assert.deepEqual(pool.deletedRecordings, ['recording-b']);
  const lockedCandidateQueries = pool.queries.filter(
    (query) => query.sql.includes('FROM evaluation_recordings AS recording') && query.sql.includes('FOR UPDATE'),
  );
  assert.equal(lockedCandidateQueries.length, 1);
  assert.deepEqual(lockedCandidateQueries[0]?.parameters, [2]);
});
