import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { configureStudioMetrics, getStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';
import { isManagedWorkflowArtifactObjectKey } from '../routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowMaintenanceLease } from '../routes/workflows/managed/maintenance.js';
import {
  createManagedStaleUploadRetentionTask,
  getManagedStaleUploadRetentionConfig,
} from '../routes/workflows/managed/stale-upload-retention.js';

type Query = { parameters: readonly unknown[]; sql: string };

class FakeRetentionPool {
  readonly queries: Query[] = [];
  candidates: string[] = [];
  references = new Set<string>();

  async connect() {
    return { query: this.query, release() {} };
  }

  readonly query = async <T>(sql: string, parameters: readonly unknown[] = []) => {
    this.queries.push({ parameters: parameters.map((value) => (Array.isArray(value) ? [...value] : value)), sql });
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rowCount: 0, rows: [] as T[] };
    }
    if (normalized.includes('select finding.subject_key')) {
      const limit = Number(parameters[2]);
      const rows = this.candidates.slice(0, limit);
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        for (const row of rows) this.candidates = this.candidates.filter((key) => key !== row);
      }
      return { rowCount: rows.length, rows: rows.map((subject_key) => ({ subject_key })) as T[] };
    }
    if (normalized.includes('with referenced_objects')) {
      const keys = parameters[0] as string[];
      const rows = keys.filter((key) => this.references.has(key)).map((object_key) => ({ object_key }));
      return { rowCount: rows.length, rows: rows as T[] };
    }
    throw new Error(`Unexpected stale-upload retention SQL: ${normalized}`);
  };
}

function createLease(assertions: { count: number }): ManagedWorkflowMaintenanceLease {
  return {
    assertCurrent: async () => {
      assertions.count += 1;
    },
    fencingToken: 1,
    holderId: 'test-holder',
  };
}

test('stale-upload retention starts audit-first and validates its quarantine proof requirements', () => {
  assert.deepEqual(getManagedStaleUploadRetentionConfig({}, 5), {
    batchSize: 5,
    minimumCandidateAgeHours: 24,
    mode: 'audit',
    requiredCompletedScans: 2,
  });
  assert.deepEqual(
    getManagedStaleUploadRetentionConfig(
      {
        RIVET_MANAGED_STALE_UPLOAD_RETENTION_MINIMUM_CANDIDATE_AGE_HOURS: '72',
        RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE: 'enforce',
        RIVET_MANAGED_STALE_UPLOAD_RETENTION_REQUIRED_COMPLETED_SCANS: '3',
      },
      7,
    ),
    { batchSize: 7, minimumCandidateAgeHours: 72, mode: 'enforce', requiredCompletedScans: 3 },
  );
  assert.throws(
    () => getManagedStaleUploadRetentionConfig({ RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE: 'delete-all' }),
    /must be disabled, audit, or enforce/,
  );
  assert.throws(
    () => getManagedStaleUploadRetentionConfig({ RIVET_MANAGED_STALE_UPLOAD_RETENTION_REQUIRED_COMPLETED_SCANS: '1' }),
    /between 2 and 10/,
  );
  assert.throws(
    () =>
      getManagedStaleUploadRetentionConfig({ RIVET_MANAGED_STALE_UPLOAD_RETENTION_MINIMUM_CANDIDATE_AGE_HOURS: '12' }),
    /between 24 and 720/,
  );
});

test('the artifact grammar accepts only revision and recording blobs created by Rivet', () => {
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/revisions/revision-a/project.rivet-project'), true);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/revisions/revision-a/dataset.rivet-data'), true);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/recordings/recording-a/recording.rivet-recording'), true);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/recordings/recording-a/replay.rivet-data'), true);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/unknown/object/payload.json'), false);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/revisions/object/not-rivet.txt'), false);
  assert.equal(isManagedWorkflowArtifactObjectKey('../revisions/object/project.rivet-project'), false);
  assert.equal(isManagedWorkflowArtifactObjectKey('workflow-a/revisions//project.rivet-project'), false);
});

test('audit mode reads only fully proven candidates and never creates an outbox intent', async () => {
  const pool = new FakeRetentionPool();
  pool.candidates = ['workflow-a/revisions/revision-a/project.rivet-project', 'unknown/prefix/item/payload.json'];
  const enqueued: string[] = [];
  const assertions = { count: 0 };
  const task = createManagedStaleUploadRetentionTask({
    config: { batchSize: 5, minimumCandidateAgeHours: 24, mode: 'audit', requiredCompletedScans: 2 },
    enqueueObjectDeletions: async (_client, _reason, keys) => {
      enqueued.push(...keys.filter((key): key is string => Boolean(key)));
      return keys.length;
    },
    pool: pool as unknown as Pool,
  });

  await task(createLease(assertions));

  assert.deepEqual(enqueued, []);
  assert.equal(assertions.count, 2);
  const candidateQuery = pool.queries.find((query) => query.sql.includes('SELECT finding.subject_key'));
  assert.match(candidateQuery?.sql ?? '', /last_completed_observed_generation = finding\.last_observed_generation/);
  assert.match(candidateQuery?.sql ?? '', /consecutive_complete_scans >= \$1/);
  assert.match(candidateQuery?.sql ?? '', /first_seen_at <= NOW\(\) - \(\$2::integer \* INTERVAL '1 hour'\)/);
  assert.doesNotMatch(candidateQuery?.sql ?? '', /FOR UPDATE/);
  assert.doesNotMatch(candidateQuery?.sql ?? '', /cardinality\(string_to_array\(finding\.subject_key/u);
});

test('enforcement queues only an unreferenced recognized artifact through the typed outbox reason', async () => {
  resetStudioMetricsForTests();
  configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  const pool = new FakeRetentionPool();
  const key = 'workflow-a/recordings/recording-a/recording.rivet-recording';
  pool.candidates = [key];
  const enqueued: Array<{ keys: Array<string | null | undefined>; reason: string }> = [];
  const assertions = { count: 0 };
  const task = createManagedStaleUploadRetentionTask({
    config: { batchSize: 2, minimumCandidateAgeHours: 24, mode: 'enforce', requiredCompletedScans: 2 },
    enqueueObjectDeletions: async (_client, reason, keys) => {
      enqueued.push({ keys, reason });
      return 1;
    },
    pool: pool as unknown as Pool,
  });

  try {
    await task(createLease(assertions));
    assert.deepEqual(enqueued, [{ keys: [key], reason: 'workflow-stale-upload-reconciliation' }]);
    assert.ok(assertions.count >= 3, 'the maintenance lease is checked before and after destructive intent');
    const candidateQuery = pool.queries.find((query) => query.sql.includes('FOR UPDATE SKIP LOCKED'));
    assert.match(candidateQuery?.sql ?? '', /cardinality\(string_to_array\(finding\.subject_key/u);
    assert.match(candidateQuery?.sql ?? '', /split_part\(finding\.subject_key, '\/', 2\) = 'revisions'/u);
    assert.ok(pool.queries.some((query) => query.sql.includes('WITH referenced_objects')));
    assert.match(
      getStudioMetrics().render(),
      /rivet_managed_stale_upload_retention_queued_total\{mode="enforce",profile="control"\} 1/,
    );
  } finally {
    resetStudioMetricsForTests();
  }
});

test('enforcement never queues a candidate which became referenced after reconciliation', async () => {
  const pool = new FakeRetentionPool();
  const key = 'workflow-a/revisions/revision-a/project.rivet-project';
  pool.candidates = [key];
  pool.references.add(key);
  const task = createManagedStaleUploadRetentionTask({
    config: { batchSize: 1, minimumCandidateAgeHours: 24, mode: 'enforce', requiredCompletedScans: 2 },
    enqueueObjectDeletions: async () => {
      throw new Error('a newly referenced candidate must not be queued');
    },
    pool: pool as unknown as Pool,
  });

  await task(createLease({ count: 0 }));
});

test('enforcement considers a newly referenced candidate once, then continues with later candidates', async () => {
  const pool = new FakeRetentionPool();
  const liveKey = 'workflow-a/revisions/revision-a/project.rivet-project';
  const staleKey = 'workflow-a/recordings/recording-a/recording.rivet-recording';
  pool.candidates = [liveKey, staleKey];
  pool.references.add(liveKey);
  const enqueued: string[] = [];
  const task = createManagedStaleUploadRetentionTask({
    config: { batchSize: 2, minimumCandidateAgeHours: 24, mode: 'enforce', requiredCompletedScans: 2 },
    enqueueObjectDeletions: async (_client, _reason, keys) => {
      enqueued.push(...keys.filter((key): key is string => Boolean(key)));
      return 1;
    },
    pool: pool as unknown as Pool,
  });

  await task(createLease({ count: 0 }));

  assert.deepEqual(enqueued, [staleKey]);
  const candidateQueries = pool.queries.filter((query) => query.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.equal(candidateQueries.length, 1);
  assert.deepEqual(candidateQueries[0]?.parameters, [2, 24, 2]);
});
