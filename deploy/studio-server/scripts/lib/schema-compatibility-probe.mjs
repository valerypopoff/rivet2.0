import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Only the reviewed 17 -> 18 expand currently has a behavioral probe.
 * A future schema change must extend this matrix, not inherit a generic green flag. */
export function assertProbedSchemaTransition(from, to) {
  assert.equal(from, 17, 'Schema transition has no reviewed mixed-writer probe');
  assert.equal(to, 18, 'Schema transition has no reviewed mixed-writer probe');
}

export function assertSchemaCompatibilityEvidence(value, release, from) {
  const to = release.database.managedWorkflowSchema.version;
  if (from === to) return;
  assertProbedSchemaTransition(from, to);
  const expected = release.lineage?.predecessor?.images?.api;
  assert.ok(value?.protocol === 1 && value.from === from && value.to === to, 'Missing schema compatibility evidence');
  assert.deepEqual(value.predecessorApi, expected, 'Schema predecessor image changed');
  assert.deepEqual(value.candidateApi, release.images.api, 'Schema candidate image changed');
  assert.match(value.runId ?? '', /^[a-f0-9]{32}$/);
  assert.equal(value.lockContention, true, 'Missing bounded DDL contention proof');
  assert.equal(value.repositories?.length, 2, 'Missing mixed repository proof');
  for (const [role, version] of [
    ['previous', from],
    ['candidate', to],
  ]) {
    const rows = value.repositories.filter((r) => r.role === role);
    assert.equal(rows.length, 1, 'Duplicate or missing schema participant');
    assert.deepEqual(rows[0], { role, version, runId: value.runId, rounds: 2, peerRowsRead: 2 });
  }
  return structuredClone(value);
}

/** Both local and Kubernetes runners apply the same per-worker receipt contract. */
export function readSchemaRepositoryReceipt(output, { role, version, runId }) {
  const rows = output.split('\n').filter((line) => line.startsWith('RIVET_SCHEMA_PROBE_RESULT '));
  assert.equal(rows.length, 1, 'Missing or duplicate schema repository receipt');
  const value = JSON.parse(rows[0].slice('RIVET_SCHEMA_PROBE_RESULT '.length));
  assert.deepEqual(
    value,
    { role, version, runId, rounds: 2, peerRowsRead: 2, ...(role === 'candidate' ? { lockContention: true } : {}) },
    'Schema receipt does not match its observed worker',
  );
  return value;
}

/** Real PostgreSQL lock-queue check in a newly created private fixture schema.
 * The actual migration SQL and actual rolling budgets come from the candidate. */
export async function probeSchemaLockContention(pool, schema, migration) {
  assert.match(schema, /^rivet_schema_probe_[a-f0-9]{32}$/);
  assert.equal(migration.version, 18);
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) clients.push(await pool.connect());
    const [blocker, ddl, reader] = clients;
    await blocker.query(`CREATE TABLE ${schema}.workflow_recordings(recording_id TEXT PRIMARY KEY)`);
    await blocker.query(`INSERT INTO ${schema}.workflow_recordings VALUES ('preserved')`);
    await blocker.query(
      `INSERT INTO ${schema}.workflow_recordings SELECT 'retained-'||n FROM generate_series(1,10000) n`,
    );
    const fileNode = (
      await blocker.query('SELECT pg_relation_filenode($1::regclass) AS id', [`${schema}.workflow_recordings`])
    ).rows[0].id;
    await blocker.query('BEGIN');
    await blocker.query(`SELECT * FROM ${schema}.workflow_recordings`);
    await ddl.query('BEGIN');
    await ddl.query(
      `SET LOCAL search_path TO ${schema}; SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='5000ms'`,
    );
    const blocked = ddl.query(migration.sql);
    // Attach rejection immediately; observing pg_locks must not create an
    // unhandled rejection if PostgreSQL returns the lock timeout first.
    const settled = blocked.then(
      () => null,
      (error) => error,
    );
    const deadline = Date.now() + 3000;
    for (;;) {
      const waiting = await reader.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [ddl.processID]);
      if (waiting.rowCount) break;
      assert.ok(Date.now() < deadline, 'DDL never entered the expected lock queue');
      await delay(10);
    }
    const started = Date.now();
    await reader.query("BEGIN; SET LOCAL statement_timeout='2500ms'");
    // The reader may lose its connection before the DDL timeout is observed.
    // Attach both handlers now; still settle the DDL before releasing leases.
    const ordinaryRead = reader
      .query(`SELECT * FROM ${schema}.workflow_recordings WHERE recording_id='preserved'`)
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    assert.equal((await settled)?.code, '55P03', 'Contended rolling DDL must time out, not commit');
    await ddl.query('ROLLBACK');
    const observedRead = await ordinaryRead;
    if ('error' in observedRead) throw observedRead.error;
    assert.deepEqual(observedRead.result.rows, [{ recording_id: 'preserved' }]);
    await reader.query('COMMIT');
    assert.ok(Date.now() - started < 2500, 'Queued application read exceeded its bound');
    await blocker.query('COMMIT');
    await ddl.query('BEGIN');
    await ddl.query(
      `SET LOCAL search_path TO ${schema}; SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='5000ms'`,
    );
    await ddl.query(migration.sql);
    await ddl.query('COMMIT');
    assert.deepEqual(
      (await reader.query(`SELECT * FROM ${schema}.workflow_recordings WHERE recording_id='preserved'`)).rows,
      [{ recording_id: 'preserved', cost_json: null }],
    );
    assert.equal((await reader.query(`SELECT count(*)::int AS n FROM ${schema}.workflow_recordings`)).rows[0].n, 10001);
    assert.equal(
      (await reader.query('SELECT pg_relation_filenode($1::regclass) AS id', [`${schema}.workflow_recordings`])).rows[0]
        .id,
      fileNode,
      'Reviewed expand must not rewrite retained recording rows',
    );
  } finally {
    const outcomes = await Promise.allSettled(clients.map((client) => client.query('ROLLBACK')));
    clients.forEach((client, index) =>
      client.release(outcomes[index].status === 'rejected' ? outcomes[index].reason : undefined),
    );
  }
}

/** Exercise image-owned insertion and listing code; no reimplemented SQL writer.
 * Both participants read the other's committed rows before either advances. */
export async function probeSchemaRepositories({ pool, modules, role, runId, version, timeoutMs = 20000 }) {
  assert.ok(['previous', 'candidate'].includes(role));
  assert.match(runId, /^[a-f0-9]{32}$/);
  const schema = `rivet_schema_probe_${runId}`,
    workflowId = `schema-probe-${runId}`;
  const peer = role === 'previous' ? 'candidate' : 'previous';
  const wait = async (check) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, 'Mixed-schema peer did not complete its bounded barrier');
      await delay(25);
    }
  };
  let lockContention = false;
  if (role === 'candidate') {
    await pool.query(`CREATE SCHEMA ${schema}`); // No IF NOT EXISTS: never adopt another attempt.
    await pool.query(`CREATE TABLE ${schema}.participants(role TEXT PRIMARY KEY, round INTEGER NOT NULL)`);
    await probeSchemaLockContention(
      pool,
      schema,
      modules.migrations.MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.find((m) => m.version === 18),
    );
    lockContention = true;
  } else
    await wait(
      async () => (await pool.query('SELECT to_regclass($1) AS name', [`${schema}.participants`])).rows[0].name,
    );
  const factory = modules.factory.createManagedWorkflowRevisionFactory({
    blobStore: {},
    queueObjectDeletions: async () => {
      throw Error('Schema probe must not delete artifacts');
    },
  });
  const service = modules.recordings.createManagedWorkflowRecordingService({
    context: {
      pool,
      initialize: async () => {},
      db: modules.db,
      mappers: modules.mappers,
      revisions: factory,
      maintenance: {},
      blobStore: {},
    },
  });
  const cost = { status: 'complete', knownCostUsd: 0.125 };
  for (let round = 1; round <= 2; round++) {
    await factory.insertRecordingRow(
      pool,
      {
        recordingId: `${workflowId}-${role}-${round}`,
        workflowId,
        sourceProjectName: 'Schema compatibility fixture',
        sourceProjectRelativePath: `${workflowId}.rivet-project`,
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        endpointNameAtExecution: workflowId,
        executionIdentity: { surface: 'workflow_endpoint' },
        cost: role === 'candidate' ? cost : undefined,
        errorMessage: null,
        recordingBlobKey: `fixture/${runId}/${role}/${round}`,
        replayProjectBlobKey: `fixture/${runId}/project`,
        replayDatasetBlobKey: null,
        hasReplayDataset: false,
        recordingCompressedBytes: 0,
        recordingUncompressedBytes: 0,
        projectCompressedBytes: 0,
        projectUncompressedBytes: 0,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      },
      { timestampMode: 'now', onConflict: 'fail', cleanupContext: 'schema compatibility' },
    );
    await pool.query(
      `INSERT INTO ${schema}.participants VALUES($1,$2) ON CONFLICT(role) DO UPDATE SET round=excluded.round`,
      [role, round],
    );
    await wait(
      async () =>
        (await pool.query(`SELECT round FROM ${schema}.participants WHERE role=$1`, [peer])).rows[0]?.round >= round,
    );
    const page = await service.listWorkflowRecordingRunsPage(workflowId, 1, 100, 'all');
    assert.ok(
      page.runs.some((r) => r.id === `${workflowId}-${peer}-${round}`),
      'Image could not read peer recording',
    );
    if (role === 'candidate') {
      for (const row of page.runs) assert.deepEqual(row.cost, row.id.includes('-candidate-') ? cost : undefined);
    }
  }
  // The old image must finish its reads before the candidate removes exact fixture rows.
  await pool.query(`UPDATE ${schema}.participants SET round=3 WHERE role=$1`, [role]);
  if (role === 'candidate') {
    await wait(
      async () =>
        (await pool.query(`SELECT round FROM ${schema}.participants WHERE role=$1`, [peer])).rows[0]?.round === 3,
    );
    const stored = (
      await pool.query('SELECT recording_id,cost_json FROM workflow_recordings WHERE workflow_id=$1', [workflowId])
    ).rows;
    assert.equal(stored.length, 4);
    for (const row of stored)
      assert.deepEqual(
        row.cost_json === null ? null : JSON.parse(row.cost_json),
        row.recording_id.includes('-candidate-') ? cost : null,
      );
    await pool.query('DELETE FROM workflow_recordings WHERE workflow_id=$1 AND recording_id=ANY($2::text[])', [
      workflowId,
      ['previous', 'candidate'].flatMap((r) => [1, 2].map((n) => `${workflowId}-${r}-${n}`)),
    ]);
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
  return { role, version, runId, rounds: 2, peerRowsRead: 2, ...(role === 'candidate' ? { lockContention } : {}) };
}
