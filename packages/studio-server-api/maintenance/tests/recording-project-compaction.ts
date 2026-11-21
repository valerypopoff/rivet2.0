import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { deserializeProject, serializeProject } from '@valerypopoff/rivet2-core/serialization';
import type { DataId, GraphId, Project } from '@valerypopoff/rivet2-core';
import { createPostgresAppSettingsBackendFromEnv } from '../../src/app-settings/managed-settings-store.js';
import { getDeploymentStorageSettingsPath } from '../../src/deployment-storage-settings.js';
import { captureRestoreObjects, type RestoreObject } from '../../src/legacy-restore/scope.js';
import { ManagedArtifactIntegrityError } from '../../src/routes/workflows/managed/artifact-descriptor.js';
import { isRecordingProjectSnapshotKey } from '../../src/routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowContext } from '../../src/routes/workflows/managed/context.js';
import { compactRecordingProjectSnapshots } from '../recording-project-compaction.js';
import { createManagedWorkflowRecordingService } from '../../src/routes/workflows/managed/recordings.js';
import type { ManagedWorkflowStorageConfig } from '../../src/routes/workflows/storage-config.js';
import { withAsyncDeadline } from '../../src/tests/helpers/workflow-async-process.js';

const runChild = promisify(execFile);
type Batch = Awaited<ReturnType<typeof compactRecordingProjectSnapshots>>;

export async function verifyHistoricalRecordingCompaction(
  context: ManagedWorkflowContext,
  config: {
    baseUrl: string;
    headers: Record<string, string>;
    storage: object;
    storageConfig: ManagedWorkflowStorageConfig;
    count: number;
    compiledCommand?: boolean;
    copyBackup: (objects: RestoreObject[]) => Promise<ManagedWorkflowContext>;
    traffic?: { run: () => Promise<number>; settle: () => Promise<void> };
  },
) {
  const { pool, blobStore, maintenance } = context;
  const recordings = createManagedWorkflowRecordingService({ context });
  const workflowId = 'historical-replay-fixture' as Project['metadata']['id'];
  const graphId = 'main' as GraphId;
  const project: Project = {
    metadata: { id: workflowId, title: 'Historical fixture', description: '', mainGraphId: graphId },
    graphs: { [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes: [], connections: [] } },
    data: { ['fixture' as DataId]: 'snapshot data '.repeat(2048) },
  };
  const files = getDeploymentStorageSettingsPath();
  await fs.mkdir(path.dirname(files), { recursive: true });
  await fs.writeFile(files, JSON.stringify(config.storage), { mode: 0o600 });
  const prefix = '000-history-';
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_'))),
    RIVET_APP_DATA_ROOT: process.env.RIVET_APP_DATA_ROOT,
  };
  const postgresEnv = {
    ...env,
    RIVET_APP_DATA_ROOT: path.join(path.dirname(files), 'without-projected-settings'),
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_APP_SETTINGS_DATABASE_URL: pool.options.connectionString,
    RIVET_DEPLOYMENT_DATABASE_SSL_MODE: 'disable',
    RIVET_APP_SETTINGS_ENCRYPTION_KEY: 'historical-replay-fixture-key-123456',
  };
  const settings = createPostgresAppSettingsBackendFromEnv(postgresEnv);
  try {
    assert.ok(
      await settings.write({
        key: 'deployment storage',
        expectedRevision: null,
        schemaVersion: 1,
        value: { ...config.storage },
      }),
    );
  } finally {
    await settings.dispose();
  }
  const command = config.compiledCommand
    ? [
        fileURLToPath(
          new URL('../../dist/studio-server-api/maintenance/compact-recording-projects.js', import.meta.url),
        ),
      ]
    : [...process.execArgv, fileURLToPath(new URL('../compact-recording-projects.ts', import.meta.url))];
  const startBatch = (limit: number, after: string, childEnv: NodeJS.ProcessEnv = env) =>
    runChild(process.execPath, [...command, '--limit', String(limit), '--after', after, '--workflow-id', workflowId], {
      env: childEnv,
      timeout: 45_000,
      windowsHide: true,
    });
  const readBatch = ({ stdout }: { stdout: string }): Batch => JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  const runBatch = (limit: number, after: string, childEnv?: NodeJS.ProcessEnv) =>
    startBatch(limit, after, childEnv).then(readBatch);
  const replayKey = async (id: string) =>
    (
      await pool.query<{ replay_project_blob_key: string }>(
        'SELECT replay_project_blob_key FROM workflow_recordings WHERE recording_id=$1',
        [id],
      )
    ).rows[0]!.replay_project_blob_key;
  const fetchArtifact = async (id: string, kind: 'replay-project' | 'replay-dataset' | 'recording') => {
    const response = await fetch(`${config.baseUrl}/api/workflows/recordings/${id}/${kind}`, {
      headers: config.headers,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  };
  const inventory = async () => {
    const keys = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const page = await blobStore.listPage!({ cursor, pageSize: 1000 });
      for (const object of page.objects) if (object.key.startsWith(workflowId + '/')) keys.set(object.key, object.size);
      cursor = page.nextCursor;
    } while (cursor);
    return keys;
  };
  const ids = Array.from({ length: config.count }, (_, index) => prefix + String(index).padStart(4, '0'));
  const seed = async (id: string, contents?: string) => {
    await recordings.importWorkflowRecording({
      recordingId: id,
      workflowId,
      sourceProjectName: project.metadata.title,
      sourceProjectRelativePath: 'Historical fixture.rivet-project',
      createdAt: new Date().toISOString(),
      endpointName: 'fixture',
      durationMs: 12,
      runKind: 'published',
      status: 'succeeded',
      recordingContents: JSON.stringify({ captured: id }),
      replayProjectContents:
        contents ??
        (serializeProject(
          { ...project, metadata: { ...project.metadata, id: randomUUID() as Project['metadata']['id'] } },
          { fixture: 'attached' },
        ) as string),
      replayDatasetContents: id === ids[0] ? '[{"fixture":"dataset bytes"}]' : null,
    });
  };
  // The replacement is first built from a gzip replay. The next recording
  // exercises the original, descriptor-less S3 format.
  await seed(ids[0]!);
  const putArtifact = blobStore.putArtifact;
  blobStore.putArtifact = undefined;
  try {
    await seed(ids[1]!);
  } finally {
    blobStore.putArtifact = putArtifact;
  }
  for (const id of ids.slice(2)) await seed(id);
  const held = prefix + 'held';
  const unreadable = prefix + 'unreadable';
  await seed(held);
  await seed(unreadable, 'not a replay project');
  await pool.query(
    `INSERT INTO workflow_run_evidence (run_id,workflow_id,token,created_at,lease_until,upload_until,state,availability,input_json)
     VALUES ($1,$2,'fixture',NOW(),NOW(),NOW()+INTERVAL '1 hour','succeeded','available','{}'::jsonb)`,
    [held, workflowId],
  );
  const before = await inventory();
  const first = ids[0]!;
  const originalKey = await replayKey(first);
  const original = deserializeProject(await fetchArtifact(first, 'replay-project'));
  const dataset = await fetchArtifact(first, 'replay-dataset');
  const trace = await fetchArtifact(first, 'recording');
  const expected = [{ ...original[0], metadata: { ...original[0].metadata, id: first } }, original[1]];

  // Hold the recording row after upload. A second command waits for either
  // the same row or the first publisher's catalog insert.
  type RunningBatch = ReturnType<typeof startBatch>;
  const startBlockedBatches = async (
    limit: number,
    names: string[],
    beforeUnlock?: (batches: RunningBatch[]) => Promise<void>,
  ) => {
    const rowLock = await pool.connect();
    const batches: RunningBatch[] = [];
    try {
      await rowLock.query('BEGIN');
      await rowLock.query('SELECT 1 FROM workflow_recordings WHERE recording_id=$1 FOR UPDATE', [first]);
      for (const name of names) {
        const batch = startBatch(limit, prefix, { ...env, PGAPPNAME: name });
        void batch.catch(() => undefined);
        batches.push(batch);
      }
      const deadline = Date.now() + 10_000;
      for (;;) {
        const blocked = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND wait_event_type='Lock'
           AND (query LIKE 'UPDATE workflow_recordings r SET replay_project_blob_key%'
             OR query LIKE 'INSERT INTO workflow_recording_project_snapshots%')`,
          [names],
        );
        if (blocked.rowCount === batches.length) break;
        for (const batch of batches) {
          if (batch.child.exitCode !== null || batch.child.signalCode !== null) await batch;
        }
        assert.ok(Date.now() < deadline, 'Compaction did not reach the expected publication locks.');
        await delay(20);
      }
      await beforeUnlock?.(batches);
      return batches;
    } catch (error) {
      for (const batch of batches) batch.child.kill('SIGKILL');
      await Promise.allSettled(batches);
      throw error;
    } finally {
      await rowLock.query('ROLLBACK').finally(() => rowLock.release());
    }
  };
  const expireCandidate = async (key: string) => {
    const expired = await pool.query(
      "UPDATE managed_object_deletion_outbox SET next_attempt_at=NOW() WHERE object_key=$1 AND status='pending'",
      [key],
    );
    assert.equal(expired.rowCount, 1, 'An unused upload must have a durable cleanup entry.');
  };
  void (await startBlockedBatches(1, ['rivet-compaction-crash'], async ([batch]) => {
    assert.equal(batch.child.kill('SIGKILL'), true);
    await assert.rejects(batch, { signal: 'SIGKILL' });
  }));
  const orphan = [...(await inventory()).keys()].filter(isRecordingProjectSnapshotKey);
  assert.equal(orphan.length, 1, 'The interrupted upload reached object storage.');
  assert.equal(await replayKey(first), originalKey);
  assert.deepEqual(deserializeProject(await fetchArtifact(first, 'replay-project')), original);
  await maintenance.runNow();
  assert.equal(await blobStore.exists!(orphan[0]!), true, 'Cleanup must give a live uploader time to finish.');
  await expireCandidate(orphan[0]!);
  await maintenance.runNow();
  assert.equal(await blobStore.exists!(orphan[0]!), false);
  const getText = blobStore.getText.bind(blobStore);
  const compactInProcess = (after: string) =>
    compactRecordingProjectSnapshots(context, {
      workflowId,
      after,
      limit: 1,
      signal: AbortSignal.timeout(5000),
    });
  let expiredKey: string | undefined;
  blobStore.getText = async (key, options) => {
    const contents = await getText(key, options);
    if (isRecordingProjectSnapshotKey(key)) {
      expiredKey = key;
      await expireCandidate(key);
      await maintenance.runNow();
      assert.equal(await blobStore.exists!(key), false, 'The outbox retired the verified but unpublished candidate.');
    }
    return contents;
  };
  try {
    assert.equal((await compactInProcess(prefix)).compacted, 0);
  } finally {
    blobStore.getText = getText;
  }
  assert.ok(expiredKey);
  assert.equal(await replayKey(first), originalKey, 'A claimed upload must never become a replay pointer.');

  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waitForDeletion = new Promise<void>((resolve) => {
    release = resolve;
  });
  blobStore.getText = async (key, options) => {
    if (key === originalKey) {
      entered();
      await waitForDeletion;
    }
    return getText(key, options);
  };
  const racingReplay = recordings.readWorkflowRecordingArtifact(first, 'replay-project');
  void racingReplay.catch(() => undefined);
  let initial: Batch;
  try {
    await withAsyncDeadline(Promise.race([reading, racingReplay]), 'replay reads original pointer');
    const pending = await startBlockedBatches(2, ['rivet-compaction-first', 'rivet-compaction-peer']);
    const batches = (await Promise.all(pending)).map(readBatch);
    initial = {
      ...batches[0],
      compacted: batches[0].compacted + batches[1].compacted,
      bytesQueuedForDeletion: batches[0].bytesQueuedForDeletion + batches[1].bytesQueuedForDeletion,
      newSnapshotBytes: batches[0].newSnapshotBytes + batches[1].newSnapshotBytes,
    };
    assert.equal(initial.compacted, 2, 'Overlapping commands compact both recordings exactly once.');
    assert.equal(initial.nextAfter, ids[1]);
    const shared = await replayKey(first);
    const unused = [...(await inventory()).keys()].filter(
      (key) => isRecordingProjectSnapshotKey(key) && key !== shared,
    );
    assert.equal(unused.length, 1, 'Exactly one of the two cold uploads lost the race.');
    await expireCandidate(unused[0]!);
    await maintenance.runNow();
    assert.equal(await blobStore.exists!(originalKey), false);
    assert.equal(await blobStore.exists!(unused[0]!), false);
    assert.equal(await blobStore.exists!(shared), true);
  } finally {
    blobStore.getText = getText;
    release();
  }
  assert.deepEqual(deserializeProject(await racingReplay), expected);
  const traffic = config.traffic;
  const sampleTraffic = async (running = () => true) => {
    const measurements: number[] = [];
    for (let batch = 0; traffic && batch < 32 && running(); batch++) {
      measurements.push(...(await Promise.all(Array.from({ length: 4 }, traffic.run))));
      await traffic.settle();
    }
    return measurements;
  };
  const summarizeLatency = (times: number[]) => ({
    samples: times.length,
    p95: [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1],
  });
  const baseline = await sampleTraffic();
  let batchComplete = false;
  const runningBatch = runBatch(config.count, initial.nextAfter!, postgresEnv).finally(() => {
    batchComplete = true;
  });
  void runningBatch.catch(() => undefined);
  if (traffic) {
    while (!batchComplete && !isRecordingProjectSnapshotKey(await replayKey(ids[2]!))) await delay(10);
    const during = await sampleTraffic(() => !batchComplete);
    assert.ok(during.length > 0, 'Endpoint samples must overlap historical compaction.');
    console.log(
      `LOCAL_COMPACTION_ENDPOINT_LATENCY ${JSON.stringify({ idle: summarizeLatency(baseline), during: summarizeLatency(during) })}`,
    );
  }
  const rest = await runningBatch;
  assert.equal(rest.compacted, config.count - 2);
  assert.equal(isRecordingProjectSnapshotKey(await replayKey(held)), false);
  assert.equal(isRecordingProjectSnapshotKey(await replayKey(unreadable)), false);
  for (let remaining = rest.compacted; remaining > 0; remaining -= maintenance.config.batchSize)
    await maintenance.runNow();
  const after = await inventory();
  const sum = (entries: Map<string, number>) => [...entries.values()].reduce((a, b) => a + b, 0);
  assert.equal([...after.keys()].filter(isRecordingProjectSnapshotKey).length, 1);
  assert.equal(before.size - after.size, config.count - 1);
  assert.equal(
    sum(before) - sum(after),
    initial.bytesQueuedForDeletion + rest.bytesQueuedForDeletion - initial.newSnapshotBytes - rest.newSnapshotBytes,
  );
  assert.ok(sum(after) < sum(before));
  assert.equal(await fetchArtifact(first, 'replay-dataset'), dataset);
  assert.equal(await fetchArtifact(first, 'recording'), trace);
  const sharedContents = await fetchArtifact(first, 'replay-project');
  assert.deepEqual(deserializeProject(sharedContents), expected);
  assert.equal((await runBatch(config.count, prefix)).compacted, 0, 'Committed rows are skipped when resuming.');
  const heldKey = await replayKey(held);
  const sharedKey = await replayKey(first);
  await pool.query("UPDATE workflow_run_evidence SET upload_until=NOW()-INTERVAL '1 second' WHERE run_id=$1", [held]);
  let failedRead = new Error('Fixture storage request timed out.');
  blobStore.getText = async (key, options) => {
    if (key === sharedKey) throw failedRead;
    return getText(key, options);
  };
  try {
    const compactHeld = () => compactInProcess(ids.at(-1)!);
    await assert.rejects(compactHeld(), /storage request timed out/);
    assert.equal(await replayKey(held), heldKey);
    failedRead = new ManagedArtifactIntegrityError('Fixture detected corrupt shared bytes.');
    const unusable = await compactHeld();
    assert.equal(unusable.scanned, 1);
    assert.equal(unusable.compacted, 0);
    assert.equal(await replayKey(held), heldKey);
    assert.equal(await blobStore.exists!(heldKey), true);
    assert.equal(
      (await pool.query('SELECT state FROM workflow_recording_project_snapshots WHERE object_key=$1', [sharedKey]))
        .rows[0]?.state,
      'unusable',
    );
  } finally {
    blobStore.getText = getText;
  }
  console.log(
    `LOCAL_HISTORICAL_REPLAY_COMPACTION ${JSON.stringify({
      recordings: config.count,
      beforeBytes: sum(before),
      afterBytes: sum(after),
      beforeObjects: before.size,
      afterObjects: after.size,
    })}`,
  );

  // This tool uses the same persisted format as new shared recordings. Verify
  // its result and the retained, inert checkpoint through the real backup path.
  const restoreObjects = await captureRestoreObjects(pool, config.storageConfig);
  assert.equal(
    restoreObjects.filter((object) => object.key === config.storageConfig.objectStoragePrefix + sharedKey).length,
    1,
  );
  assert.ok(!restoreObjects.some((object) => object.key === config.storageConfig.objectStoragePrefix + originalKey));
  const checkpointSql = 'SELECT next_after,resume_at FROM workflow_recording_project_compaction WHERE singleton';
  const checkpoint = (await pool.query(checkpointSql)).rows;
  const restored = await config.copyBackup(restoreObjects);
  try {
    const reader = createManagedWorkflowRecordingService({ context: restored });
    assert.equal(await reader.readWorkflowRecordingArtifact(first, 'replay-project'), sharedContents);
    assert.equal(await reader.readWorkflowRecordingArtifact(first, 'replay-dataset'), dataset);
    assert.equal(await reader.readWorkflowRecordingArtifact(first, 'recording'), trace);
    assert.deepEqual((await restored.pool.query(checkpointSql)).rows, checkpoint);
  } finally {
    await restored.dispose();
  }
}
