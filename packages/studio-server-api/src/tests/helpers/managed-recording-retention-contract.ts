import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import type { StoredLLMProfileHealthEntry } from '../../llm-profile-health/state.js';
import type { ManagedWorkflowBlobStore } from '../../routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowContext } from '../../routes/workflows/managed/context.js';
import { queryOne, queryRows } from '../../routes/workflows/managed/db.js';
import { createManagedWorkflowMaintenance } from '../../routes/workflows/managed/maintenance.js';
import * as mappers from '../../routes/workflows/managed/mappers.js';
import { createManagedWorkflowRecordingService } from '../../routes/workflows/managed/recordings.js';
import { createManagedWorkflowTransactionRunner } from '../../routes/workflows/managed/transactions.js';
import type { WorkflowRecordingConfig } from '../../routes/workflows/recordings-config.js';

// Called last, only with the statistics runner's disposable, migrated database.
export async function verifyManagedRecordingRetentionContract(pool: Pool): Promise<void> {
  await pool.query('RESET work_mem');
  const limits = { retentionDays: 0, maxRunsPerEndpoint: 0, maxTotalBytes: 0 };
  const config: WorkflowRecordingConfig = {
    ...limits,
    enabled: true,
    compression: 'gzip',
    gzipLevel: 4,
    maxPendingWrites: 100,
    includePartialOutputs: false,
    includeTrace: false,
    datasetMode: 'none',
  };
  const deletedKeys: string[] = [];
  const failures: unknown[][] = [];
  const blobStore: ManagedWorkflowBlobStore = {
    putText: async () => assert.fail('retention must not upload artifacts'),
    getText: async () => assert.fail('retention must not download artifacts'),
    delete: async (key) => {
      deletedKeys.push(String(key));
    },
  };
  const maintenance = createManagedWorkflowMaintenance({
    pool,
    blobStore,
    config: { enabled: true, intervalMs: 86_400_000, leaseMs: 60_000, batchSize: 2 },
    logger: {
      error: (...args) => {
        failures.push(args);
      },
      warn: (...args) => {
        failures.push(args);
      },
      info() {},
    },
  });
  const initialize = async () => {};
  const transaction = createManagedWorkflowTransactionRunner({ pool, initialize });
  let transactions = 0;
  const withTransaction: ManagedWorkflowContext['withTransaction'] = (run) => {
    transactions++;
    return transaction.withTransaction(run);
  };
  const context = {
    pool,
    blobStore,
    maintenance,
    initialize,
    withTransaction,
    db: { queryRows, queryOne },
    mappers,
    revisions: {},
  } as unknown as ManagedWorkflowContext;
  let configReads = 0;
  const rows = [
    { id: 'held-old', days: 40, workflow: 'a', endpoint: 'flow' },
    { id: 'expired', days: 30, workflow: 'a', endpoint: 'flow' },
    { id: 'a-old', days: 3, workflow: 'a', endpoint: ' FLOW ' },
    { id: 'a-tie', days: 3, workflow: 'a', endpoint: 'flow' },
    { id: 'b-only', days: 4, workflow: 'b', endpoint: 'flow' },
    { id: 'a-new', days: 1, workflow: 'a', endpoint: 'flow' },
  ];
  const keys = (id: string) => ['recording', 'project', 'dataset'].map((kind) => `${id}/${kind}`);
  const seed = async () => {
    await pool.query('TRUNCATE workflow_recordings, llm_profile_health, managed_object_deletion_outbox');
    const {
      rows: [{ now }],
    } = await pool.query<{ now: Date }>('SELECT NOW() AS now');
    deletedKeys.length = 0;
    for (const row of rows) {
      await pool.query(
        `INSERT INTO workflow_recordings (
        recording_id, workflow_id, source_project_name, source_project_relative_path,
        run_kind, status, duration_ms, endpoint_name_at_execution, created_at,
        recording_blob_key, replay_project_blob_key, replay_dataset_blob_key, has_replay_dataset,
        recording_compressed_bytes, project_compressed_bytes, dataset_compressed_bytes
      ) VALUES ($1,$2,'Fixture','fixture.rivet-project','published','succeeded',1,$3,
        $4,$5,$6,$7,true,$8,3,3)`,
        [
          row.id,
          row.workflow,
          row.endpoint,
          new Date(now.getTime() - row.days * 86_400_000),
          ...keys(row.id),
          row.id === 'held-old' ? 1000 : 4,
        ],
      );
    }
    const evidence: StoredLLMProfileHealthEntry = {
      identity: {
        key: 'fixture',
        projectId: 'a' as never,
        profileNodeId: 'profile' as never,
        profileName: 'Fixture',
        provider: 'custom',
        model: 'fixture',
        configurationFingerprint: 'fixture',
      },
      failureTimestamps: [1],
      closedPermits: {},
      updatedAt: 1,
      policy: { failureThreshold: 1, failureWindowMs: 1000, openDurationMs: 1000, halfOpenLeaseMs: 1000 },
      failureEvidence: [{ id: 'failure', occurredAt: 1, recordingId: 'held-old', recordingAvailability: 'available' }],
      activeSuspension: { id: 'suspension', contributorEventIds: ['failure'], triggerEventId: 'failure' },
    };
    await pool.query('INSERT INTO llm_profile_health (key, project_id, entry_json) VALUES ($1,$2,$3::jsonb)', [
      'fixture',
      'a',
      JSON.stringify(evidence),
    ]);
  };
  const remaining = async () =>
    new Set(
      (await pool.query<{ recording_id: string }>('SELECT recording_id FROM workflow_recordings')).rows.map(
        (row) => row.recording_id,
      ),
    );
  const queued = () =>
    pool.query<{ object_key: string; domain: string }>('SELECT object_key, domain FROM managed_object_deletion_outbox');
  const assertRemoved = async (removed: readonly string[], label: string) => {
    const selected = new Set(removed);
    const expectedKeys = new Set(removed.flatMap(keys));
    assert.deepEqual(
      await remaining(),
      new Set(rows.filter((row) => !selected.has(row.id)).map((row) => row.id)),
      label,
    );
    const outbox = (await queued()).rows;
    assert.deepEqual(new Set(outbox.map((row) => row.object_key)), expectedKeys, label);
    assert.ok(
      outbox.every((row) => row.domain === 'workflow-recording-retention'),
      label,
    );
    assert.ok(
      deletedKeys.every((key) => expectedKeys.has(key)),
      label,
    );
  };

  try {
    const service = createManagedWorkflowRecordingService({
      context,
      getRecordingConfig: () => {
        configReads++;
        return config;
      },
    });
    assert.equal(configReads, 0, 'constructing a service must not read retention settings');
    await seed();
    await service.initialize();
    assert.equal(transactions, 0, 'disabled retention does not open a selection/deletion transaction');
    for (const [name, policy, removed] of [
      ['age only', { retentionDays: 14 }, ['expired']],
      ['count only, tied batch boundary', { maxRunsPerEndpoint: 1 }, ['expired', 'a-old', 'a-tie']],
      ['bytes at equality', { maxTotalBytes: 20 }, ['expired', 'b-only', 'a-old']],
      ['bytes include all artifact columns', { maxTotalBytes: 19 }, ['expired', 'b-only', 'a-old', 'a-tie']],
      [
        'count exclusions free byte quota for an older different project',
        { retentionDays: 14, maxRunsPerEndpoint: 1, maxTotalBytes: 20 },
        ['expired', 'a-old', 'a-tie'],
      ],
      [
        'combined, oldest-first tie across batches',
        { retentionDays: 14, maxRunsPerEndpoint: 1, maxTotalBytes: 10 },
        ['expired', 'b-only', 'a-old', 'a-tie'],
      ],
      ['no deletion', { retentionDays: 60, maxRunsPerEndpoint: 10, maxTotalBytes: 100 }, []],
      ['all disabled', limits, []],
    ] as const) {
      await seed();
      Object.assign(config, limits, policy);
      const transactionsBefore: number = transactions;
      const passes = Math.max(1, Math.ceil(removed.length / maintenance.config.batchSize));
      for (let pass = 1; pass <= passes; pass++) {
        const readsBefore: number = configReads;
        await service.cleanupWorkflowRecordingStorage();
        assert.equal(configReads, readsBefore + 1, 'each pass reads the injected settings again');
        await assertRemoved(removed.slice(0, pass * maintenance.config.batchSize), name);
      }
      assert.equal(transactions - transactionsBefore, name === 'all disabled' ? 0 : passes, name);
    }
    // Reopening is a SQL behavior, not a check that the query contains an UPSERT.
    const blockedKey = 'outbox/reopen';
    await pool.query(
      `INSERT INTO managed_object_deletion_outbox (
      object_key,domain,status,attempt_count,next_attempt_at,last_error,
      claim_holder_id,claim_fencing_token,claim_expires_at
    ) VALUES ($1,'workflow-recording-retention','blocked',2,NOW()+INTERVAL '1 day',
      'previous reference','previous-owner',9,NOW()+INTERVAL '1 day')`,
      [blockedKey],
    );
    assert.equal(
      await maintenance.queueObjectDeletions('workflow-recording-deletion', [blockedKey, blockedKey, null]),
      1,
    );
    const reopened = await pool.query(
      `SELECT domain,status,attempt_count,last_error,
      claim_holder_id,claim_fencing_token,claim_expires_at,next_attempt_at<=NOW() AS ready
      FROM managed_object_deletion_outbox WHERE object_key=$1`,
      [blockedKey],
    );
    assert.deepEqual(reopened.rows, [
      {
        domain: 'workflow-recording-deletion',
        status: 'pending',
        attempt_count: 0,
        last_error: null,
        claim_holder_id: null,
        claim_fencing_token: null,
        claim_expires_at: null,
        ready: true,
      },
    ]);
    Object.assign(config, limits);
    await service.cleanupWorkflowRecordingStorage();
    assert.deepEqual(deletedKeys, [blockedKey], 'a reopened intent becomes claimable again');
    assert.equal(failures.length, 0, 'all ordinary passes must complete without logged failures');

    // Fail after both real SQL mutations, without bypassing the real transaction.
    await seed();
    Object.assign(config, limits, { retentionDays: 14 });
    const failure = new Error('fixture failure after enqueue');
    const enqueue = maintenance.enqueueObjectDeletions;
    maintenance.enqueueObjectDeletions = async (...args) => {
      await enqueue(...args);
      assert.equal(
        (await args[0].query("SELECT 1 FROM workflow_recordings WHERE recording_id = 'expired'")).rowCount,
        0,
      );
      assert.equal((await args[0].query('SELECT 1 FROM managed_object_deletion_outbox')).rowCount, 3);
      throw failure;
    };
    await service.cleanupWorkflowRecordingStorage();
    await assertRemoved([], 'rollback restores rows and leaves no deletion intent or object deletion');
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes(failure), 'runNow logs the injected task failure instead of rejecting');
    maintenance.enqueueObjectDeletions = enqueue;
    await service.cleanupWorkflowRecordingStorage();
    await assertRemoved(['expired'], 'retry after rollback');
    assert.equal(failures.length, 1, 'retry must complete without another logged failure');

    // A task may outlive its pass lease. A successor must own all new claims.
    await pool.query('TRUNCATE workflow_recordings, llm_profile_health, managed_object_deletion_outbox');
    Object.assign(config, limits);
    deletedKeys.length = 0;
    const successorDeletes: string[] = [];
    const successor = createManagedWorkflowMaintenance({
      pool,
      blobStore: {
        ...blobStore,
        delete: async (key) => {
          successorDeletes.push(String(key));
        },
      },
      config: maintenance.config,
      logger: {
        error: (...args) => {
          failures.push(args);
        },
        warn() {},
        info() {},
      },
    });
    try {
      for (const takeover of [false, true]) {
        deletedKeys.length = successorDeletes.length = 0;
        const orphan = `handoff/${takeover ? 'successor' : 'expired'}`;
        const unregister = maintenance.registerTask('zz-handoff', async (lease) => {
          const expired = await pool.query(
            `UPDATE managed_maintenance_leases SET expires_at=NOW() - INTERVAL '1 second'
             WHERE holder_id=$1 AND fencing_token=$2`,
            [lease.holderId, lease.fencingToken],
          );
          assert.equal(expired.rowCount, 1);
          if (takeover) {
            await successor.runNow();
            const owner = (
              await pool.query<{ holder_id: string; fencing_token: string }>(
                'SELECT holder_id, fencing_token FROM managed_maintenance_leases WHERE lease_name=$1',
                ['managed-workflow-maintenance'],
              )
            ).rows[0];
            assert.notEqual(owner.holder_id, lease.holderId);
            assert.ok(Number(owner.fencing_token) > Number(lease.fencingToken));
          }
          await maintenance.queueObjectDeletions('workflow-recording-deletion', [orphan]);
        });
        try {
          await service.cleanupWorkflowRecordingStorage();
          assert.deepEqual(deletedKeys, [], 'an expired owner must not claim newly queued work');
          assert.deepEqual(successorDeletes, []);
          const pending = await pool.query<{ status: string; claim_holder_id: string | null }>(
            'SELECT status, claim_holder_id FROM managed_object_deletion_outbox WHERE object_key=$1',
            [orphan],
          );
          assert.deepEqual(pending.rows, [{ status: 'pending', claim_holder_id: null }]);
        } finally {
          unregister();
        }
        await (takeover ? successor : maintenance).runNow();
        assert.deepEqual(
          takeover ? successorDeletes : deletedKeys,
          [orphan],
          'a current owner can finish the deletion',
        );
        assert.equal(failures.length, 1, 'expiry and takeover must not introduce a task failure');
      }
    } finally {
      await successor.dispose();
    }
  } finally {
    await maintenance.dispose();
  }
}
