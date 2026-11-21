import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serializeProject } from '@valerypopoff/rivet2-core/serialization';
import type { Project } from '@valerypopoff/rivet2-core';
import type { ManagedWorkflowContext } from '../../src/routes/workflows/managed/context.js';
import { createManagedWorkflowRecordingService } from '../../src/routes/workflows/managed/recordings.js';
import { createRecordingBlobKey } from '../../src/routes/workflows/managed/blob-store.js';
import {
  prepareManagedTextArtifact,
  parseManagedArtifactDescriptor,
} from '../../src/routes/workflows/managed/artifact-descriptor.js';
import {
  acquireRecordingStorageLock,
  assertRecordingTransactionLock,
} from '@valerypopoff/rivet-studio-server-bootstrap/recording-storage.mjs';
import { readRecordingRestoreIdentity, recompressRecordingBatch } from '../recording-recompression.js';
import { captureRestoreObjects, type RestoreObject } from '../../src/legacy-restore/scope.js';
import type { ManagedWorkflowStorageConfig } from '../../src/routes/workflows/storage-config.js';
import { LegacyRestoreControl } from '../../src/legacy-restore/control.js';
import { getManagedDbPoolConfig } from '../../src/routes/workflows/managed/db.js';
import { recordingOperatorTransaction, withRecordingOperatorLease } from '../recording-storage-operator.js';
import { PostgresAppSettingsBackend } from '../../src/app-settings/managed-settings-store.js';
import { deploymentStorageSettingsRepository } from '../../src/deployment-storage-settings.js';

export async function verifyRecordingRecompression(
  context: ManagedWorkflowContext,
  config: ManagedWorkflowStorageConfig,
  copyBackup: (objects: RestoreObject[]) => Promise<ManagedWorkflowContext>,
  runTraffic?: () => Promise<void>,
  readTrace?: (recordingId: string) => Promise<string>,
) {
  const { pool, blobStore } = context;
  const control = new LegacyRestoreControl(getManagedDbPoolConfig(config), 'brotli-test-encryption-key');
  try {
    await control.initialize('fixture/rivet');
  } finally {
    await control.pool.end();
  }
  const workflowId = 'brotli-recompression-fixture';
  const service = createManagedWorkflowRecordingService({ context });
  const project = { metadata: { id: workflowId, title: 'Brotli fixture', description: '' }, graphs: {} } as Project;
  const text = JSON.stringify({
    version: 1,
    recording: {
      events: [
        {
          type: 'start',
          data: {
            inputs: {
              input: { type: 'object', value: { request_id: 'needle', repeated: 'sample '.repeat(10000) } },
            },
          },
        },
      ],
    },
  });
  const seed = async (id: string, encoding: 'gzip' | 'identity' | 'br', contents = text, owner = workflowId) => {
    await service.importWorkflowRecording({
      recordingId: id,
      workflowId: owner,
      sourceProjectName: 'Brotli fixture',
      sourceProjectRelativePath: 'Brotli fixture.rivet-project',
      endpointName: 'fixture',
      durationMs: 1,
      createdAt: '2026-01-01T00:00:00.000123Z',
      runKind: 'published',
      status: 'succeeded',
      recordingContents: contents,
      replayProjectContents: serializeProject({
        ...project,
        metadata: { ...project.metadata, id: owner as Project['metadata']['id'] },
      }) as string,
      replayDatasetContents: null,
    });
    const artifact = await prepareManagedTextArtifact(
      createRecordingBlobKey(owner, id, 'recording'),
      contents,
      encoding,
    );
    await blobStore.putArtifact!(artifact.descriptor, artifact.bytes);
    await pool.query(
      `UPDATE workflow_recordings SET recording_blob_key=$2,recording_compressed_bytes=$3,
      recording_uncompressed_bytes=$4 WHERE recording_id=$1`,
      [id, artifact.descriptor.key, artifact.bytes.length, Buffer.byteLength(contents)],
    );
    return artifact.descriptor.key;
  };
  const old = await seed('br-01-gzip', 'gzip');
  await seed('br-02-identity', 'identity');
  const held = await seed('br-03-held', 'gzip');
  const small = await seed('br-04-small', 'identity', '0');
  const already = await seed('br-05-already', 'br');
  if (readTrace)
    for (const id of ['br-01-gzip', 'br-02-identity', 'br-05-already']) assert.equal(await readTrace(id), text);
  await pool.query(
    `INSERT INTO workflow_run_evidence (run_id,workflow_id,token,created_at,lease_until,upload_until,state,availability,input_json)
    VALUES ('br-03-held',$1,'fixture',NOW()-INTERVAL '3 days',NOW()-INTERVAL '3 days',NOW()-INTERVAL '3 days','succeeded','available','{}')`,
    [workflowId],
  );
  const before = (await pool.query('SELECT * FROM workflow_recordings WHERE recording_id=$1', ['br-01-gzip'])).rows[0];
  const options = {
    cutoff: '2026-02-01T00:00:00.000000Z',
    restoreIdentity: await readRecordingRestoreIdentity(pool),
    assertReaders: async () => {},
    workflowId,
    signal: AbortSignal.timeout(30000),
  };
  const expired = await recompressRecordingBatch(context, { ...options, deadline: 0 });
  assert.equal(expired.converted, 0);
  assert.equal(expired.exhausted, false);
  assert.equal(expired.budgetExhausted, true);
  assert.equal(expired.after, undefined);
  // A transition can nest another transition connection; neither permits a converter.
  const owner = await pool.connect(),
    nested = await pool.connect();
  const unlock = await acquireRecordingStorageLock(owner, 'shared');
  try {
    await nested.query('BEGIN');
    await assertRecordingTransactionLock(nested, 'shared');
    await assert.rejects(
      recompressRecordingBatch(context, options),
      /prevented recording publication|storage operation/,
    );
    await nested.query('ROLLBACK');
    assert.equal(
      (await pool.query('SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1', ['br-01-gzip']))
        .rows[0].recording_blob_key,
      old,
    );
  } finally {
    await unlock();
    owner.release();
    nested.release();
  }
  const originalPut = blobStore.putArtifact!.bind(blobStore);
  let concurrentTraffic = runTraffic;
  blobStore.putArtifact = async (...args) => {
    if (args[0].key.includes('/br-01-gzip/') && concurrentTraffic) {
      const traffic = concurrentTraffic;
      concurrentTraffic = undefined;
      await traffic();
    }
    return originalPut(...args);
  };
  const result = await withRecordingOperatorLease(config, 'converter', async (leasedPool, signal, check, client) => {
    await check();
    const other = await pool.connect();
    try {
      const locked = await other.query('SELECT pg_try_advisory_lock_shared(8072,24006) AS acquired');
      assert.equal(locked.rows[0].acquired, false, 'A transition cannot enter during conversion.');
    } finally {
      other.release();
    }
    return recompressRecordingBatch(
      { ...context, pool: leasedPool, withTransaction: recordingOperatorTransaction(client) },
      { ...options, signal },
    );
  }).finally(() => {
    blobStore.putArtifact = originalPut;
  });
  assert.equal(result.converted, 2);
  assert.equal(result.notSmaller, 1);
  assert.equal(result.exhausted, true);
  assert.equal(result.after?.createdAt, '2026-01-01T00:00:00.000123Z');
  const after = (await pool.query('SELECT * FROM workflow_recordings WHERE recording_id=$1', ['br-01-gzip'])).rows[0];
  assert.match(after.recording_blob_key, /recording\.[a-f0-9-]+\.rivet-recording.*\.br$/);
  assert.ok(after.recording_compressed_bytes < before.recording_compressed_bytes);
  assert.deepEqual(
    {
      ...after,
      recording_blob_key: before.recording_blob_key,
      recording_compressed_bytes: before.recording_compressed_bytes,
    },
    before,
  );
  assert.equal(await blobStore.getText(after.recording_blob_key), text);
  for (const [id, key] of [
    ['br-03-held', held],
    ['br-04-small', small],
    ['br-05-already', already],
  ])
    assert.equal(
      (await pool.query('SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1', [id])).rows[0]
        .recording_blob_key,
      key,
    );
  assert.ok((await pool.query('SELECT 1 FROM managed_object_deletion_outbox WHERE object_key=$1', [old])).rowCount);
  // Replaying a saved cursor cannot duplicate conversion, and epoch mismatch is fail-closed.
  assert.equal((await recompressRecordingBatch(context, { ...options, after: result.after })).converted, 0);
  await assert.rejects(
    recompressRecordingBatch(context, { ...options, restoreIdentity: 'other-installation' }),
    /identity changed/,
  );

  // Exact bytes survive the same real database/object copy used by the backup tests.
  const restored = await copyBackup(await captureRestoreObjects(pool, config));
  try {
    const restoredService = createManagedWorkflowRecordingService({ context: restored });
    assert.equal(await restoredService.readWorkflowRecordingArtifact('br-01-gzip', 'recording'), text);
  } finally {
    await restored.dispose();
  }
  // A reader already holding the retired pointer retries the new pointer once.
  await blobStore.delete(old);
  const readContext = { ...context, db: { ...context.db } };
  // First row lookup is stale; the reload must use the actual current pointer.
  let first = true;
  readContext.db.queryOne = (async (...args: Parameters<typeof context.db.queryOne>) => {
    const row = await context.db.queryOne(...args);
    if (first && row && 'recording_blob_key' in row) {
      first = false;
      return { ...row, recording_blob_key: old };
    }
    return row;
  }) as typeof context.db.queryOne;
  assert.equal(
    await createManagedWorkflowRecordingService({ context: readContext }).readWorkflowRecordingArtifact(
      'br-01-gzip',
      'recording',
    ),
    text,
  );
  // Interrupted uploads retain an orphan generation; a retry must get a new
  // key, so delayed cleanup cannot delete the winning trace.
  await seed('br-06-interrupted', 'gzip');
  const put = blobStore.putArtifact!.bind(blobStore);
  let abandoned = '';
  blobStore.putArtifact = async (descriptor, bytes, ...args) => {
    await put(descriptor, bytes, ...args);
    if (descriptor.key.includes('/br-06-interrupted/')) {
      abandoned = descriptor.key;
      throw new Error('lost upload acknowledgement');
    }
  };
  try {
    await assert.rejects(recompressRecordingBatch(context, options), /lost upload acknowledgement/);
  } finally {
    blobStore.putArtifact = put;
  }
  assert.ok(abandoned);
  assert.equal((await recompressRecordingBatch(context, options)).converted, 1);
  const winner = (
    await pool.query('SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1', ['br-06-interrupted'])
  ).rows[0].recording_blob_key;
  assert.notEqual(winner, abandoned);
  // A deleted recording between PUT and publication cannot be resurrected.
  await seed('br-07-deleted', 'gzip');
  blobStore.putArtifact = async (descriptor, bytes, ...args) => {
    await put(descriptor, bytes, ...args);
    if (descriptor.key.includes('/br-07-deleted/'))
      await pool.query('DELETE FROM workflow_recordings WHERE recording_id=$1', ['br-07-deleted']);
  };
  try {
    assert.equal((await recompressRecordingBatch(context, options)).converted, 0);
  } finally {
    blobStore.putArtifact = put;
  }
  const expiredOriginal = await seed('br-08-expired-intent', 'gzip');
  blobStore.putArtifact = async (descriptor, bytes, ...args) => {
    await put(descriptor, bytes, ...args);
    if (descriptor.key.includes('/br-08-expired-intent/'))
      await pool.query('UPDATE managed_object_deletion_outbox SET next_attempt_at=NOW() WHERE object_key=$1', [
        descriptor.key,
      ]);
  };
  try {
    assert.equal((await recompressRecordingBatch(context, options)).converted, 0);
    assert.equal(
      (
        await pool.query('SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1', [
          'br-08-expired-intent',
        ])
      ).rows[0].recording_blob_key,
      expiredOriginal,
    );
  } finally {
    blobStore.putArtifact = put;
  }
  await pool.query(`UPDATE managed_object_deletion_outbox SET next_attempt_at=NOW()
    WHERE domain='workflow-recording-recompression'`);
  await context.maintenance.runNow();
  assert.equal(await blobStore.exists!(abandoned), false);
  assert.equal(await blobStore.getText(winner), text);
  if (readTrace)
    for (const id of ['br-01-gzip', 'br-02-identity', 'br-06-interrupted']) assert.equal(await readTrace(id), text);
  for (const target of ['owner', 'idle']) {
    await assert.rejects(
      withRecordingOperatorLease(config, 'converter', async (leasePool, _signal, check, client) => {
        const connection = target === 'owner' ? client : await leasePool.connect();
        const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const failed = once(target === 'owner' ? connection : leasePool, 'error', {
          signal: AbortSignal.timeout(5000),
        });
        if (target === 'idle') connection.release();
        await pool.query('SELECT pg_terminate_backend($1)', [pid]);
        await failed;
        await check();
      }),
    );
  }
  const cliWorkflow = 'brotli-cli-fixture';
  await seed('br-cli-01', 'gzip', text, cliWorkflow);
  await seed('br-cli-02', 'identity', text, cliWorkflow);
  await verifyRecompressionCli(context, config, cliWorkflow);
  if (readTrace) for (const id of ['br-cli-01', 'br-cli-02']) assert.equal(await readTrace(id), text);
  console.log(
    'Brotli recompression: exact bytes, retained evidence, metadata, reader race, coordination and restored-copy playback passed.',
  );
}

async function verifyRecompressionCli(
  context: ManagedWorkflowContext,
  config: ManagedWorkflowStorageConfig,
  workflowId: string,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-recompression-cli-'));
  const key = deploymentStorageSettingsRepository.descriptor.key;
  const secret = 'recompression-cli-local-test-key';
  const settings = new PostgresAppSettingsBackend({
    poolConfig: getManagedDbPoolConfig(config),
    encryptionSecret: secret,
  });
  let settingsInserted = false;
  try {
    await settings.initialize();
    assert.equal((await context.pool.query('SELECT 1 FROM app_settings WHERE setting_key=$1', [key])).rowCount, 0);
    await settings.write({
      key,
      expectedRevision: null,
      schemaVersion: 1,
      value: {
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'disable',
        databaseConnectionString: config.databaseUrl,
        objectStorageBucket: config.objectStorageBucket,
        objectStorageEndpoint: config.objectStorageEndpoint,
        objectStorageRegion: config.objectStorageRegion,
        objectStoragePrefix: config.objectStoragePrefix,
        objectStorageForcePathStyle: config.objectStorageForcePathStyle,
        storageAccessKeyId: config.objectStorageAccessKeyId,
        storageAccessKey: config.objectStorageSecretAccessKey,
      },
    });
    settingsInserted = true;
    await settings.dispose();
    const receipt = path.join(directory, 'receipt.json');
    const fixture = new URL(
      '../../../../deploy/studio-server/scripts/fixtures/recording-recompression-cli.mjs',
      import.meta.url,
    );
    const args = ['--workflow-id', workflowId];
    const apply = [
      '--apply',
      '--receipt',
      receipt,
      '--reader-manifest',
      path.join(directory, 'manifest.json'),
      '--context',
      'fixture-context',
      '--namespace',
      'fixture',
      '--release',
      'rivet',
    ];
    const invoke = (extra: string[] = [], oldReader = false) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RIVET_')));
        Object.assign(env, {
          RIVET_APP_SETTINGS_BACKEND: 'postgres',
          RIVET_APP_SETTINGS_DATABASE_URL: config.databaseUrl,
          RIVET_DEPLOYMENT_DATABASE_SSL_MODE: 'disable',
          RIVET_APP_SETTINGS_ENCRYPTION_KEY: secret,
          RIVET_RECOMPRESSION_CLI_FIXTURE: directory,
          ...(oldReader ? { RIVET_RECOMPRESSION_CLI_OLD_READER: '1' } : {}),
        });
        const child = fork(new URL('../recompress-recordings.ts', import.meta.url), [...args, ...extra], {
          silent: true,
          env,
          execArgv: [
            '--import',
            pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
            '--import',
            fixture.href,
          ],
          timeout: 30000,
        });
        let stdout = '',
          stderr = '';
        child.stdout!.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr!.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
    const output = async (extra: string[] = []) => {
      const result = await invoke(extra);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    };
    const inventory = await output();
    assert.equal(inventory.mode, 'inventory');
    const denied = await invoke([...apply, '--limit', '1'], true);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /older, mutable or unknown recording reader/);
    await assert.rejects(fs.stat(receipt), { code: 'ENOENT' });
    const first = await output([...apply, '--limit', '1']);
    assert.equal(first.result.converted, 1);
    assert.equal(first.result.exhausted, false);
    const firstReceipt = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(firstReceipt.after.recordingId, 'br-cli-01');
    const second = await output(apply);
    assert.equal(second.result.converted, 1);
    assert.equal(second.result.exhausted, true);
    assert.equal((await output(apply)).result, null);
    const validReceipt = JSON.parse(await fs.readFile(receipt, 'utf8'));
    // Wrong installation/epoch is an operator-boundary check. Malformed cursor
    // shapes are covered without child startup in recording-recompression.test.
    for (const contents of ['{', JSON.stringify({ ...validReceipt, restore: 'wrong epoch' })]) {
      await fs.writeFile(receipt, contents);
      assert.equal((await invoke(apply)).code, 1);
      assert.equal(await fs.readFile(receipt, 'utf8'), contents, 'Invalid receipts must not be overwritten.');
    }
    for (const id of ['br-cli-01', 'br-cli-02']) {
      const row = (
        await context.pool.query('SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1', [id])
      ).rows[0];
      assert.equal(parseManagedArtifactDescriptor(row.recording_blob_key)?.encoding, 'br');
    }
    console.log(
      'Actual recompression CLI: encrypted settings, inventory, reader gate, bounded apply, resume and invalid receipts passed.',
    );
  } finally {
    await settings.dispose();
    if (settingsInserted) await context.pool.query('DELETE FROM app_settings WHERE setting_key=$1', [key]);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rivet-recompression-cli-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
