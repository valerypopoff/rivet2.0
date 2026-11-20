import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { S3Client, CreateBucketCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { deserializeProject } from '@valerypopoff/rivet2-core/serialization';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
} from '../routes/workflows/managed/schema-migrations.js';
import { createManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import { createManagedWorkflowRecordingService } from '../routes/workflows/managed/recordings.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import { ManagedRecordingEvidence } from '../routes/workflows/managed/recording-evidence.js';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import { completeRunEvidence, incompleteChildEvidence } from '../routes/workflows/execution-evidence-owner.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import type { RunEvidenceHandle } from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';
import { serializeProject, ExecutionRecorder, type DataId, type Project } from '@valerypopoff/rivet2-node';
import { listRecordingHistory, missingRecordingCount } from '../routes/workflows/managed/recording-history.js';
import {
  recordingStatisticsRowsSql,
  recordingStatisticsIncompleteSql,
  recordingStatisticsCatalogSql,
} from '../routes/workflows/recording-statistics-sql.js';
import { findManagedWorkflowObjectReferences } from '../routes/workflows/managed/workflow-object-references.js';
import { captureRestoreObjects, type RestoreObject } from '../legacy-restore/scope.js';
import { isRecordingProjectSnapshotKey } from '../routes/workflows/managed/blob-store.js';
import { createRecordingProjectSnapshotRetentionTask } from '../routes/workflows/managed/recording-project-snapshots.js';
import { startAsyncWorkflowProcess, withAsyncDeadline } from './helpers/workflow-async-process.js';
import { listenTestServer } from './helpers/http-server-harness.js';
import { verifyHistoricalRecordingCompaction } from './helpers/recording-project-compaction.js';
import http from 'node:http';

const input = {
  projectId: 'durability-project',
  sourceProjectName: 'Durability',
  sourceProjectRelativePath: 'Durability.rivet-project',
  endpointName: 'durability',
  runKind: 'published' as const,
  executionIdentity: { surface: 'workflow_endpoint' as const, graphId: 'main' },
};
const project: Project = {
  metadata: { id: input.projectId as Project['metadata']['id'], title: 'Durability', description: '' },
  graphs: {},
  plugins: [],
};
const recording = {
  sourceProject: project,
  sourceProjectPath: 'unused',
  executedProject: project,
  executedAttachedData: {},
  executedDatasets: [],
  endpointName: 'durability',
  recordingSerialized: '{"captured":"complete"}',
  runKind: 'published' as const,
  status: 'succeeded' as const,
  durationMs: 300.25,
  executionIdentity: input.executionIdentity,
};
const proxyHeaders = {
  'x-rivet-proxy-auth': createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex'),
};

async function crashWorker() {
  const config = JSON.parse(process.env.RIVET_DURABILITY_TEST_CONFIG!) as ManagedWorkflowStorageConfig;
  const context = createManagedWorkflowContext(config, undefined, { migrationMode: 'verify' });
  const evidence = new ManagedRecordingEvidence(context);
  const handle = await evidence.begin(input);
  await evidence.outcome(handle, { state: 'succeeded', durationMs: 300 });
  await context.pool.query('INSERT INTO durability_side_effects VALUES ($1)', [handle.id]);
  // Abrupt process loss after the real S3 uploads and before their SQL publication.
  context.revisions.insertRecordingRow = async () => {
    process.stdout.write(JSON.stringify(handle) + '\n');
    process.exit(71);
  };
  await evidence.persist(recording, handle);
  throw new Error('Crash injection was not reached.');
}

async function verifySharedReplayProjects(
  context: ReturnType<typeof createManagedWorkflowContext>,
  other: ReturnType<typeof createManagedWorkflowContext>,
  config: ManagedWorkflowStorageConfig,
  baseUrl: string,
  measure: boolean,
  compacted: Awaited<ReturnType<typeof verifyHistoricalRecordingCompaction>>,
  copyBackup: (objects: RestoreObject[]) => Promise<ReturnType<typeof createManagedWorkflowContext>>,
) {
  const { pool, blobStore } = context;
  const evidence = new ManagedRecordingEvidence(context);
  const peer = new ManagedRecordingEvidence(other);
  const service = createManagedWorkflowRecordingService({ context, evidence });
  const workflowId = 'shared-replay-fixture' as Project['metadata']['id'];
  const sourceProject = { ...project, metadata: { ...project.metadata, id: workflowId } };
  const capture = {
    ...recording,
    sourceProject,
    executedProject: sourceProject,
    executedAttachedData: { fixture: 'one' },
  };
  const begin = async (writer: ManagedRecordingEvidence) => {
    const handle = await writer.begin({ ...input, projectId: workflowId });
    await writer.outcome(handle, { state: 'succeeded', durationMs: 300 });
    return handle;
  };
  const persist = async (writer = evidence, data = capture) => writer.persist(data, await begin(writer));
  const keyFor = async (id: string) =>
    (
      await pool.query<{ replay_project_blob_key: string }>(
        'SELECT replay_project_blob_key FROM workflow_recordings WHERE recording_id=$1',
        [id],
      )
    ).rows[0]!.replay_project_blob_key;
  const readFromApi = async (id: string) => {
    const res = await fetch(`${baseUrl}/api/workflows/recordings/${id}/replay-project`, {
      headers: proxyHeaders,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.text();
  };
  const put = blobStore.putArtifact!.bind(blobStore);
  const get = blobStore.getBytes!.bind(blobStore);
  const remove = blobStore.delete.bind(blobStore);
  try {
    const legacyWriter = new ManagedRecordingEvidence(context);
    legacyWriter.canShareReplayProject = () => false;
    const legacy = await persist(legacyWriter).finally(() => legacyWriter.dispose());
    const legacyKey = await keyFor(legacy);
    const legacyText = await blobStore.getText(legacyKey);
    const [first, second] = await Promise.all([persist(), persist(peer)]);
    const key = await keyFor(first);
    assert.ok(isRecordingProjectSnapshotKey(key));
    assert.equal(await keyFor(second), key);
    blobStore.putArtifact = async (...args) => {
      assert.equal(isRecordingProjectSnapshotKey(args[0].key), false, 'Verified reuse performed a replay PUT.');
      return put(...args);
    };
    blobStore.getBytes = async (...args) => {
      assert.equal(isRecordingProjectSnapshotKey(args[0]), false, 'Verified reuse performed a replay GET.');
      return get(...args);
    };
    try {
      const warm = await persist();
      assert.equal(await keyFor(warm), key);
      await service.deleteWorkflowRecording(warm);
    } finally {
      blobStore.putArtifact = put;
      blobStore.getBytes = get;
    }

    const distinct = await persist(evidence, { ...capture, executedAttachedData: { fixture: 'two' } });
    assert.notEqual(await keyFor(distinct), key);
    assert.equal(await readFromApi(legacy), legacyText);
    for (const id of [first, second, distinct]) {
      const [replay, attached] = deserializeProject(await readFromApi(id));
      assert.equal(replay.metadata.id, id);
      assert.equal(replay.metadata.title, sourceProject.metadata.title);
      assert.deepEqual(attached, { fixture: id === distinct ? 'two' : 'one' });
    }
    const restoreObjects = await captureRestoreObjects(pool, config);
    assert.equal(restoreObjects.filter((object) => object.key === config.objectStoragePrefix + key).length, 1);
    assert.ok(restoreObjects.some((object) => object.key === config.objectStoragePrefix + legacyKey));
    assert.equal(
      restoreObjects.filter((object) => object.key === config.objectStoragePrefix + compacted.sharedKey).length,
      1,
    );
    assert.ok(!restoreObjects.some((object) => object.key === config.objectStoragePrefix + compacted.originalKey));
    const restored = await copyBackup(restoreObjects);
    try {
      const reader = createManagedWorkflowRecordingService({ context: restored });
      assert.equal(await reader.readWorkflowRecordingArtifact(legacy, 'replay-project'), legacyText);
      for (const id of [first, second])
        assert.equal(await reader.readWorkflowRecordingArtifact(id, 'replay-project'), await readFromApi(id));
      assert.equal(
        await reader.readWorkflowRecordingArtifact(compacted.recordingId, 'replay-project'),
        compacted.sharedContents,
      );
      assert.equal(
        await reader.readWorkflowRecordingArtifact(compacted.recordingId, 'replay-dataset'),
        compacted.dataset,
      );
      assert.equal(await reader.readWorkflowRecordingArtifact(compacted.recordingId, 'recording'), compacted.trace);
      const checkpointSql = 'SELECT next_after,resume_at FROM workflow_recording_project_compaction WHERE singleton';
      const checkpoint = (await pool.query(checkpointSql)).rows;
      assert.equal(checkpoint.length, 1);
      assert.deepEqual((await restored.pool.query(checkpointSql)).rows, checkpoint);
    } finally {
      await restored.dispose();
    }

    context.maintenance.registerTask(
      'verify-shared-replay-reclamation',
      createRecordingProjectSnapshotRetentionTask(context),
    );
    await service.deleteWorkflowRecording(first);
    await context.maintenance.runNow();
    assert.equal(await blobStore.exists!(key), true);
    assert.equal(deserializeProject(await readFromApi(second))[0].metadata.id, second);

    // An unfinalized run also pins the generation through its manifest.
    const pending = await evidence.begin({ ...input, projectId: workflowId });
    await assert.rejects(evidence.persist(capture, pending), /confirmed execution outcome/);
    await service.deleteWorkflowRecording(second);
    await context.maintenance.runNow();
    assert.equal(await blobStore.exists!(key), true);
    await service.deleteWorkflowRecording(pending.id);

    let releaseDelete!: () => void;
    let enteredDelete!: () => void;
    const deleting = new Promise<void>((resolve) => {
      enteredDelete = resolve;
    });
    const heldDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    blobStore.delete = async (target) => {
      if (target === key) {
        enteredDelete();
        await heldDelete;
      }
      await remove(target);
    };
    const cleanup = context.maintenance.runNow();
    let replacement: string;
    try {
      await withAsyncDeadline(
        Promise.race([
          deleting,
          cleanup.then(async () => {
            const catalog = await pool.query(
              'SELECT state FROM workflow_recording_project_snapshots WHERE object_key=$1',
              [key],
            );
            const outbox = await pool.query(
              'SELECT status,last_error FROM managed_object_deletion_outbox WHERE object_key=$1',
              [key],
            );
            const references = await findManagedWorkflowObjectReferences(pool, [key]);
            throw new Error(
              `Shared replay was not collected ${JSON.stringify({ catalog: catalog.rows, outbox: outbox.rows, live: references.has(key) })}`,
            );
          }),
        ]),
        'retired shared replay object enters deletion',
      );
      replacement = await persist(peer);
      assert.notEqual(await keyFor(replacement), key);
    } finally {
      releaseDelete();
      await cleanup;
      blobStore.delete = remove;
    }
    assert.equal(await blobStore.exists!(key), false);
    assert.equal(deserializeProject(await readFromApi(replacement))[0].metadata.id, replacement);
    const replacementKey = await keyFor(replacement);
    await remove(replacementKey);
    await assert.rejects(service.readWorkflowRecordingArtifact(replacement, 'replay-project'));
    assert.equal(
      (await pool.query('SELECT state FROM workflow_recording_project_snapshots WHERE object_key=$1', [replacementKey]))
        .rows[0]?.state,
      'unusable',
    );
    const fallback = await persist();
    assert.equal(isRecordingProjectSnapshotKey(await keyFor(fallback)), false);
    assert.equal(deserializeProject(await readFromApi(fallback))[0].metadata.id, fallback);

    // Mixed encoders may run together during an update. A different encoding
    // must keep its own replay while the cold shared reservation is unverified.
    const codecCapture = { ...capture, executedAttachedData: { fixture: 'codec' } };
    let enteredUpload!: () => void;
    let releaseUpload!: () => void;
    const uploading = new Promise<void>((resolve) => {
      enteredUpload = resolve;
    });
    const continueUpload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    process.env.RIVET_RECORDINGS_COMPRESS = 'gzip';
    blobStore.putArtifact = async (...args) => {
      if (isRecordingProjectSnapshotKey(args[0].key)) {
        enteredUpload();
        await continueUpload;
      }
      return put(...args);
    };
    const gzipCapture = persist(evidence, codecCapture);
    void gzipCapture.catch(() => undefined);
    try {
      await withAsyncDeadline(Promise.race([uploading, gzipCapture]), 'cold shared upload begins');
      process.env.RIVET_RECORDINGS_COMPRESS = 'identity';
      const dedicated = await persist(peer, codecCapture);
      assert.equal(isRecordingProjectSnapshotKey(await keyFor(dedicated)), false);
      assert.deepEqual(deserializeProject(await readFromApi(dedicated))[1], codecCapture.executedAttachedData);
    } finally {
      releaseUpload();
      blobStore.putArtifact = put;
      delete process.env.RIVET_RECORDINGS_COMPRESS;
      await gzipCapture.catch(() => undefined);
    }
    assert.ok(isRecordingProjectSnapshotKey(await keyFor(await gzipCapture)));
    console.log(
      'Shared replay reuse, exact legacy API bytes, mixed restore scope, pending pins, delayed deletes and missing-object fallback passed.',
    );

    if (measure) {
      const listFixtureKeys = async () => {
        const result = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await blobStore.listPage!({ cursor, pageSize: 1000 });
          for (const object of page.objects) if (object.key.startsWith(workflowId + '/')) result.add(object.key);
          cursor = page.nextCursor;
        } while (cursor);
        return result;
      };
      const before = await listFixtureKeys();
      const variant = { ...capture, executedAttachedData: { fixture: 'measured' } };
      const started = performance.now();
      const keys = new Set<string>();
      for (let batch = 0; batch < 125; batch++) {
        const ids = await Promise.all(Array.from({ length: 8 }, () => persist(evidence, variant)));
        for (const id of ids) keys.add(await keyFor(id));
      }
      assert.equal(keys.size, 1);
      const measuredKey = [...keys][0]!;
      assert.equal(await blobStore.exists!(measuredKey), true);
      const added = [...(await listFixtureKeys())].filter((key) => !before.has(key));
      assert.deepEqual(added.filter(isRecordingProjectSnapshotKey), [measuredKey]);
      const traces = (
        await pool.query<{ key: string }>(
          'SELECT recording_blob_key AS key FROM workflow_recordings WHERE replay_project_blob_key=$1',
          [measuredKey],
        )
      ).rows;
      assert.equal(new Set(traces.map((row) => row.key)).size, 1000);
      const addedKeys = new Set(added);
      assert.ok(traces.every((row) => addedKeys.has(row.key)));
      console.log(
        `LOCAL_SHARED_REPLAY_OBJECTS ${JSON.stringify({ recordings: traces.length, snapshots: keys.size, elapsedMs: performance.now() - started })}`,
      );

      // Exercise a single workflow's retention lookup with more metadata
      // rows than the normal test fixture, without inventing extra S3 traces.
      await pool.query(
        `INSERT INTO workflow_recordings (recording_id,workflow_id,source_project_name,source_project_relative_path,
            run_kind,status,duration_ms,endpoint_name_at_execution,recording_blob_key,replay_project_blob_key)
         SELECT 'retention-measure-' || n, $1, 'Fixture', 'Fixture.rivet-project', 'published', 'succeeded',
           1, 'fixture', $1 || '/recordings/retention-measure-' || n || '/recording.rivet-recording', $2
         FROM generate_series(1,100000) AS n`,
        [workflowId, measuredKey],
      );
      const orphaned = measuredKey.replace(/(recording-project-snapshots\/)[^/]+/, '$1' + randomUUID());
      await pool.query(
        `INSERT INTO workflow_recording_project_snapshots(workflow_id,digest,object_key,state)
         VALUES($1,$2,$3,'pending')`,
        [workflowId, createHash('sha256').update(orphaned).digest('hex'), orphaned],
      );
      const reclaimStarted = performance.now();
      await context.maintenance.runNow();
      const reclaimMs = performance.now() - reclaimStarted;
      const retained = (
        await pool.query(
          'SELECT object_key FROM workflow_recording_project_snapshots WHERE object_key=ANY($1::text[])',
          [[measuredKey, orphaned]],
        )
      ).rows;
      assert.deepEqual(
        retained.map((row) => row.object_key),
        [measuredKey],
      );
      console.log(`LOCAL_SHARED_REPLAY_RETENTION ${JSON.stringify({ extraRecordings: 100000, reclaimMs })}`);
      await pool.query(
        "DELETE FROM workflow_recordings WHERE workflow_id=$1 AND recording_id LIKE 'retention-measure-%'",
        [workflowId],
      );
    }
  } finally {
    await evidence.dispose();
    await peer.dispose();
  }
}

async function measureSnapshotSharing(options: Parameters<typeof startAsyncWorkflowProcess>[0], pool: Pool) {
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summarize = (values: number[]) => ({
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  });
  for (const projectPayloadBytes of [0, 512 * 1024]) {
    const api = await startAsyncWorkflowProcess({
      ...options,
      projectPayloadBytes,
      projectName: `Snapshot timing ${projectPayloadBytes}`,
      endpointName: 'snapshot-timing-' + projectPayloadBytes,
    });
    const run = async () => {
      const start = performance.now();
      const response = await fetch(`${api.baseUrl}/workflows/snapshot-timing-${projectPayloadBytes}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"fixture":"timing"}',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200)
        throw new Error(`Timed endpoint returned ${response.status}: ${await response.text()}`);
      await response.arrayBuffer();
      return performance.now() - start;
    };
    const idle = async () => {
      const deadline = Date.now() + 5000;
      while ((await api.command<{ activeRuns: number }>('execution-admission')).activeRuns) {
        assert.ok(Date.now() < deadline, 'Measured request kept an execution permit.');
        await delay(5);
      }
    };
    const timedReplay = async (id: string) => {
      const start = performance.now();
      const response = await fetch(`${api.baseUrl}/api/workflows/recordings/${id}/replay-project`, {
        headers: proxyHeaders,
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      return performance.now() - start;
    };
    const editorContents = serializeProject({
      ...project,
      metadata: { ...project.metadata, id: api.projectId as Project['metadata']['id'] },
      data: projectPayloadBytes ? { ['replay-fixture' as DataId]: 'x'.repeat(projectPayloadBytes) } : undefined,
    });
    const editorRecording = new ExecutionRecorder().serialize();
    const editorPost = (suffix: string, body: object) =>
      fetch(api.baseUrl + '/api/workflows/local-editor-recordings' + suffix, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...proxyHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    const timedEditorUpload = async () => {
      const handle = { id: randomUUID(), token: randomUUID() };
      const executionIdentity = { graphId: 'unsaved-editor-graph', correlationId: 'rvt-timing-' + randomUUID() };
      const source = { projectId: api.projectId, projectPath: api.projectPath };
      const accepted = await editorPost('/runs/begin', {
        ...source,
        ...executionIdentity,
        handle,
        createdAt: new Date().toISOString(),
      });
      assert.equal(accepted.status, 201, await accepted.text());
      const start = performance.now();
      const completed = await editorPost('', {
        ...source,
        executionIdentity,
        evidenceHandle: handle,
        projectContents: editorContents,
        recordingSerialized: editorRecording,
        status: 'succeeded',
        durationMs: 1,
      });
      assert.equal(completed.status, 201, await completed.text());
      return performance.now() - start;
    };
    const count = async () =>
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM workflow_run_evidence WHERE workflow_id=$1 AND availability='available'",
          [api.projectId],
        )
      ).rows[0].n as number;
    const group = () => ({
      endpoint: [] as number[],
      replay: [] as number[],
      schedule: [] as number[],
      editor: [] as number[],
      capturedPerSecond: [] as number[],
      resources: [] as Record<string, number>[],
    });
    const timings = { off: group(), on: group() };
    try {
      for (const mode of ['off', 'on', 'on', 'off', 'on', 'off', 'off', 'on'] as const) {
        const samples = timings[mode];
        await api.command('snapshot-sharing-' + mode);
        await run();
        await idle();
        await api.command('scheduled-recordings');
        const replayId = (await api.command<{ runs: { id: string }[] }>('recordings')).runs[0]!.id;
        const before = await count();
        await api.command('begin-snapshot-timing');
        const started = performance.now();
        for (let batch = 0; batch < 16; batch++) {
          const reads = batch % 4 === 0 ? timedReplay(replayId) : undefined;
          void reads?.catch(() => undefined);
          samples.endpoint.push(...(await Promise.all(Array.from({ length: 4 }, run))));
          await idle();
          if (reads) samples.replay.push(await reads);
        }
        await api.command('scheduled-recordings');
        assert.equal((await count()) - before, 64, 'Timed writes must retain every measured recording.');
        samples.capturedPerSecond.push(64_000 / (performance.now() - started));
        for (let sample = 0; sample < 6; sample++) {
          const scheduled = api.command<number>('measure-scheduled-permit');
          void scheduled.catch(() => undefined);
          await Promise.all(Array.from({ length: 3 }, run));
          samples.schedule.push(await scheduled);
          await idle();
        }
        await api.command('scheduled-recordings');
        for (let sample = 0; sample < 6; sample++) samples.editor.push(await timedEditorUpload());
        samples.resources.push(await api.command('finish-snapshot-timing'));
      }
      console.log(
        `LOCAL_SHARED_REPLAY_LATENCY ${JSON.stringify({
          projectPayloadBytes,
          endpointMs: { off: summarize(timings.off.endpoint), on: summarize(timings.on.endpoint) },
          replayOpenMs: { off: summarize(timings.off.replay), on: summarize(timings.on.replay) },
          scheduledPermitMs: { off: summarize(timings.off.schedule), on: summarize(timings.on.schedule) },
          editorUploadMs: { off: summarize(timings.off.editor), on: summarize(timings.on.editor) },
          capturedPerSecond: {
            off: summarize(timings.off.capturedPerSecond),
            on: summarize(timings.on.capturedPerSecond),
          },
          resources: { off: timings.off.resources, on: timings.on.resources },
        })}`,
      );
    } finally {
      await api.close();
    }
  }
}

async function main() {
  const measurePerformance = process.argv.includes('--measure');
  const owned: string[] = [],
    docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-durability-'));
  process.env.RIVET_APP_DATA_ROOT = root;
  process.env.RIVET_RECORDING_DURABILITY_ENABLED = 'true';
  process.env.RIVET_MANAGED_MAINTENANCE_ENABLED = 'true';
  process.env.RIVET_MANAGED_WORKFLOW_SCHEMA_MODE = 'verify';
  let pool: Pool | undefined, s3: S3Client | undefined;
  const contexts: Array<ReturnType<typeof createManagedWorkflowContext>> = [];
  let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>> | undefined;
  let catalogBackend: ManagedWorkflowBackend | undefined;
  let tail: Awaited<ReturnType<typeof listenTestServer>> | undefined;
  let holdTail = false;
  let tailEntered: (() => void) | undefined;
  let releaseTail = () => {};
  try {
    const launch = (port: number, ...args: string[]) => {
      const id = docker(
        'run',
        '--rm',
        '-d',
        '--name',
        'rivet-durability-' + randomUUID(),
        '-p',
        `127.0.0.1::${port}`,
        ...args,
      );
      owned.push(id);
      return Number(
        docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
      );
    };
    const dbPort = launch(
      5432,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=rivet_durability',
      'postgres:16.8-alpine',
    );
    const blobPort = launch(
      9000,
      '-e',
      'MINIO_ROOT_USER=durabilityfixture',
      '-e',
      'MINIO_ROOT_PASSWORD=durabilityfixturesecret',
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
      'server',
      '/tmp/minio',
    );
    const config: ManagedWorkflowStorageConfig = {
      databaseMode: 'managed',
      databaseUrl: `postgres://postgres@127.0.0.1:${dbPort}/rivet_durability`,
      databaseSslMode: 'disable',
      objectStorageBucket: 'durability-fixture',
      objectStorageEndpoint: `http://127.0.0.1:${blobPort}`,
      objectStorageRegion: 'us-east-1',
      objectStorageAccessKeyId: 'durabilityfixture',
      objectStorageSecretAccessKey: 'durabilityfixturesecret',
      objectStorageForcePathStyle: true,
      objectStoragePrefix: 'durability/',
    };
    pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1000 });
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await pool.query('SELECT 1');
        if (
          !(await fetch(config.objectStorageEndpoint + '/minio/health/ready', { signal: AbortSignal.timeout(1000) })).ok
        )
          throw new Error('MinIO starting');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(100);
      }
    }
    await migrateManagedWorkflowSchema(pool);
    await verifyManagedWorkflowSchema(pool);
    await pool.query('CREATE TABLE durability_side_effects(run_id TEXT PRIMARY KEY)');
    s3 = new S3Client({
      endpoint: config.objectStorageEndpoint!,
      region: config.objectStorageRegion,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.objectStorageAccessKeyId,
        secretAccessKey: config.objectStorageSecretAccessKey,
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: config.objectStorageBucket }));
    const apiOptions = {
      recordingDurability: true,
      workflowMaintenance: false,
      graceSeconds: 5,
      storage: {
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'disable',
        databaseConnectionString: config.databaseUrl,
        objectStorageBucket: config.objectStorageBucket,
        objectStorageEndpoint: config.objectStorageEndpoint,
        objectStorageRegion: config.objectStorageRegion,
        objectStoragePrefix: config.objectStoragePrefix,
        objectStorageForcePathStyle: true,
        storageAccessKeyId: config.objectStorageAccessKeyId,
        storageAccessKey: config.objectStorageSecretAccessKey,
        storageUrl: config.objectStorageEndpoint + '/' + config.objectStorageBucket,
      },
    };
    if (process.argv.includes('--sharing-latency-only')) {
      await measureSnapshotSharing(apiOptions, pool);
      return;
    }
    const context = createManagedWorkflowContext(config, undefined, { migrationMode: 'verify' });
    contexts.push(context);
    const evidence = new ManagedRecordingEvidence(context);
    const handle = await evidence.begin(input);
    const again = await evidence.begin(input, handle);
    assert.deepEqual(again, handle);
    assert.equal((await evidence.read(handle)).state, 'accepted');
    await evidence.outcome(handle, { state: 'succeeded', durationMs: 300 });
    const ids = await Promise.all([evidence.persist(recording, handle), evidence.persist(recording, handle)]);
    assert.deepEqual(ids, [handle.id, handle.id]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM workflow_recordings')).rows[0].n, 1);
    await assert.rejects(evidence.persist({ ...recording, recordingSerialized: 'different' }, handle), /differs/);
    await assert.rejects(evidence.read({ ...handle, token: randomUUID() }), /another attempt/);
    await pool.query('DELETE FROM workflow_recordings WHERE recording_id=$1', [handle.id]);
    assert.equal((await evidence.read(handle)).availability, 'deleted');
    await assert.rejects(evidence.persist(recording, handle), /closed/);
    console.log('Stable IDs, concurrent finalization, conflicting bytes, ownership and deletion passed.');

    const coverageFailure = await evidence.begin(input);
    const childIncomplete = evidence.childIncomplete;
    evidence.childIncomplete = async () => {
      throw new Error('Injected child-coverage write failure');
    };
    const coverageOwner = { handle: coverageFailure, repository: evidence };
    try {
      await incompleteChildEvidence(coverageOwner);
      await completeRunEvidence(coverageOwner, { state: 'failed', durationMs: 300 });
    } finally {
      evidence.childIncomplete = childIncomplete;
    }
    assert.equal((await evidence.read(coverageFailure)).state, 'failed');
    assert.equal((await evidence.read(coverageFailure)).childCoverage, 'incomplete');
    await evidence.persist({ ...recording, status: 'failed' }, coverageFailure);
    assert.equal((await evidence.read(coverageFailure)).availability, 'available');
    console.log('A child-coverage write failure preserved the known root failure and its replay.');

    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--worker'], {
      env: {
        ...process.env,
        RIVET_DURABILITY_TEST_CONFIG: JSON.stringify(config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Crash-injection child exceeded its local deadline.'));
      }, 30_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exit, 71, stderr);
    const crashed = JSON.parse(output.trim().split('\n').at(-1)!) as RunEvidenceHandle;
    const fresh = createManagedWorkflowContext(config, undefined, { migrationMode: 'verify' });
    contexts.push(fresh);
    const recovered = new ManagedRecordingEvidence(fresh);
    await recovered.recover();
    assert.equal((await recovered.read(crashed)).availability, 'available');
    const crashedReplayKey = (
      await pool.query('SELECT replay_project_blob_key FROM workflow_recordings WHERE recording_id=$1', [crashed.id])
    ).rows[0].replay_project_blob_key;
    assert.ok(isRecordingProjectSnapshotKey(crashedReplayKey));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM durability_side_effects')).rows[0].n, 1);
    console.log('Abrupt process exit after real uploads recovered with a fresh owner; no business replay.');

    const lost = await evidence.begin({ ...input, endpointName: 'lost-owner' });
    await evidence.childIncomplete(lost);
    await pool.query("UPDATE workflow_run_evidence SET lease_until=NOW()-INTERVAL '1 second' WHERE run_id=$1", [
      lost.id,
    ]);
    await recovered.recover();
    assert.equal((await evidence.read(lost)).state, 'unknown');
    assert.equal((await evidence.read(lost)).childCoverage, 'incomplete');
    await evidence.outcome(lost, { state: 'failed', durationMs: 10 });
    await evidence.unavailable(lost, 'serialization_failed');
    const history = await listRecordingHistory(
      context,
      { workflowId: '', page: 1, pageSize: 100, includeEvidence: true },
      (row) => ({ id: row.recording_id }) as never,
    );
    const item = history.runs.find((row) => row.id === lost.id)!;
    assert.equal(item.status, 'failed');
    assert.equal(item.evidence?.availability, 'unavailable');
    assert.equal(JSON.stringify(history).includes(lost.token), false);
    await evidence.deletePending(lost.id);
    await recovered.recover();
    assert.equal((await evidence.read(lost)).availability, 'deleted');
    console.log('Unknown owner, late known outcome, visible unavailable evidence and pending deletion passed.');

    const unknown = await evidence.begin({ ...input, endpointName: 'unknown-capture' });
    await assert.rejects(evidence.persist(recording, unknown), /confirmed execution outcome/);
    assert.equal((await evidence.read(unknown)).handoffReady, true);
    assert.equal((await evidence.read(unknown)).availability, 'pending');
    await evidence.outcome(unknown, { state: 'succeeded', durationMs: 300 });
    await recovered.recover();
    assert.equal((await evidence.read(unknown)).availability, 'available');

    const parent = await evidence.begin({ ...input, endpointName: 'family-parent' });
    const childHandle = await evidence.begin({
      ...input,
      rootId: parent.id,
      executionIdentity: { surface: 'subgraph_project', graphId: 'main' },
    });
    await evidence.outcome(childHandle, { state: 'succeeded', durationMs: 300 });
    await evidence.persist(
      { ...recording, executionIdentity: { surface: 'subgraph_project', graphId: 'main' } },
      childHandle,
    );
    const families = await listRecordingHistory(
      context,
      { workflowId: '', page: 1, pageSize: 100, runScope: 'families' },
      (row) => ({ id: row.recording_id }) as never,
    );
    assert.equal(
      families.runs.some((row) => row.id === parent.id),
      true,
    );
    assert.equal(
      families.runs.some((row) => row.id === childHandle.id),
      false,
    );
    const children = await listRecordingHistory(
      context,
      { workflowId: parent.id, page: 1, pageSize: 100, runScope: 'children' },
      (row) => ({ id: row.recording_id }) as never,
    );
    assert.equal(
      children.runs.some((row) => row.id === childHandle.id),
      true,
    );

    for (const [sharing, failAfter] of [
      [false, 1],
      [false, 2],
      [true, 1],
      [true, 2],
    ] as const) {
      const uncertain = await evidence.begin({ ...input, endpointName: 'uncertain-' + failAfter });
      await evidence.outcome(uncertain, { state: 'succeeded', durationMs: 300 });
      const transaction = context.withTransaction;
      const canShare = evidence.canShareReplayProject;
      if (!sharing) evidence.canShareReplayProject = () => false;
      let transactions = 0;
      context.withTransaction = async (operation) => {
        const value = await transaction(operation);
        if (++transactions === failAfter)
          throw Object.assign(new Error('committed acknowledgement lost'), { code: 'ECONNRESET' });
        return value;
      };
      try {
        assert.equal(await evidence.persist(recording, uncertain), uncertain.id);
      } finally {
        context.withTransaction = transaction;
        evidence.canShareReplayProject = canShare;
      }
    }
    console.log('Lost manifest and publication commit acknowledgements confirmed by readback.');
    const partial = await evidence.begin({ ...input, endpointName: 'partial' });
    await evidence.outcome(partial, { state: 'succeeded', durationMs: 300 });
    const put = context.blobStore.putArtifact!.bind(context.blobStore);
    let transient = true;
    context.blobStore.putArtifact = async (...args) => {
      if (transient && args[0].key.includes('/recording.')) {
        transient = false;
        throw { $metadata: { httpStatusCode: 503 } };
      }
      return put(...args);
    };
    try {
      await evidence.persist(recording, partial);
    } finally {
      context.blobStore.putArtifact = put;
    }
    assert.equal((await evidence.read(partial)).availability, 'available');
    console.log('Transient partial upload repaired through identical immutable writes.');
    const unavailable = await evidence.begin({ ...input, endpointName: 'durability' });
    await evidence.outcome(unavailable, {
      state: 'failed',
      durationMs: 20,
      cost: { status: 'partial', knownCostUsd: 0.1 },
    });
    await evidence.unavailable(unavailable, 'serialization_failed');
    assert.ok(await missingRecordingCount(context, { workflowId: '', page: 1, pageSize: 100, runScope: 'roots' }));
    const statisticsQuery = {
      target: { surface: 'endpoint' as const, workflowId: input.projectId },
      period: { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
      runKind: 'both' as const,
      includeFailed: true,
      includeWarnings: true,
    };
    for (const statement of [
      recordingStatisticsRowsSql('postgres', statisticsQuery, true),
      recordingStatisticsIncompleteSql(statisticsQuery),
      recordingStatisticsCatalogSql('postgres', 'endpoint', true),
    ])
      await pool.query(statement.sql, statement.values);
    await listRecordingHistory(
      context,
      { workflowId: '', page: 1, pageSize: 100, runScope: 'families' },
      (row) => ({ id: row.recording_id }) as never,
    );
    assert.equal(
      (
        await findManagedWorkflowObjectReferences(
          pool,
          (
            await pool.query(
              "SELECT jsonb_array_elements(manifest_json->'artifacts')->>'key' AS key FROM workflow_run_evidence WHERE run_id=$1",
              [partial.id],
            )
          ).rows.map((row) => row.key),
        )
      ).size,
      2,
    );
    console.log('History families, incomplete-search counts, statistics and live object references passed.');

    const service = createManagedWorkflowRecordingService({ context, evidence });
    const racing = await evidence.begin({ ...input, endpointName: 'delete-race' });
    await evidence.outcome(racing, { state: 'succeeded', durationMs: 300 });
    const insert = context.revisions.insertRecordingRow;
    let releaseInsert!: () => void, enteredInsert!: () => void;
    const paused = new Promise<void>((resolve) => {
        releaseInsert = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enteredInsert = resolve;
      });
    context.revisions.insertRecordingRow = async (...args) => {
      enteredInsert();
      await paused;
      return insert(...args);
    };
    try {
      const finalizing = evidence.persist(recording, racing);
      await entered;
      const deleting = service.deleteWorkflowRecording(racing.id);
      releaseInsert();
      await Promise.all([finalizing, deleting]);
      assert.equal((await evidence.read(racing)).availability, 'deleted');
      await assert.rejects(evidence.persist(recording, racing), /closed/);
    } finally {
      releaseInsert();
      context.revisions.insertRecordingRow = insert;
    }
    console.log('Concurrent finalization/deletion retained its tombstone and did not resurrect a replay.');

    for (const fault of ['integrity', 'permission'] as const) {
      const poisoned = await evidence.begin({ ...input, endpointName: fault });
      await evidence.outcome(poisoned, { state: 'succeeded', durationMs: 300 });
      context.revisions.insertRecordingRow = async () => {
        throw new Error('Fixture publication interrupted');
      };
      try {
        await assert.rejects(evidence.persist(recording, poisoned), /interrupted/);
      } finally {
        context.revisions.insertRecordingRow = insert;
      }
      const get = fresh.blobStore.getBytes!.bind(fresh.blobStore);
      let reads = 0;
      fresh.blobStore.getBytes = async (...args) => {
        if (args[0].includes(poisoned.id)) {
          reads++;
          if (fault === 'permission') throw { $metadata: { httpStatusCode: 403 } };
          return new Uint8Array([0]);
        }
        return get(...args);
      };
      try {
        await recovered.recover();
        const observed = await evidence.read(poisoned);
        assert.equal(observed.state, 'succeeded');
        assert.equal(observed.availability, 'unavailable');
        assert.equal(observed.reason, 'persistence_failed');
        await recovered.recover();
        assert.equal(reads, 1);
      } finally {
        fresh.blobStore.getBytes = get;
      }
    }
    console.log('Corrupt bytes and permanent permission failures stop recovery without changing execution outcome.');

    if (measurePerformance) {
      const timings: { legacyMs: number[]; durableMs: number[]; registrationMs: number[]; recoveryMs: number[] } = {
        legacyMs: [],
        durableMs: [],
        registrationMs: [],
        recoveryMs: [],
      };
      const sample = {
        ...recording,
        sourceProjectPath: getManagedWorkflowProjectVirtualPath('Durability.rivet-project'),
        recordingSerialized: JSON.stringify({ capture: 'x'.repeat(512 * 1024) }),
      };
      for (let i = 0; i < 5; i++) {
        let started = performance.now();
        await service.persistWorkflowExecutionRecording(sample);
        timings.legacyMs.push(performance.now() - started);
        started = performance.now();
        const sampleHandle = await evidence.begin({ ...input, endpointName: 'measurement-' + i });
        timings.registrationMs.push(performance.now() - started);
        await evidence.outcome(sampleHandle, { state: 'succeeded', durationMs: 300 });
        started = performance.now();
        await evidence.persist(sample, sampleHandle);
        timings.durableMs.push(performance.now() - started);
      }
      const recoveryStarted = performance.now();
      await recovered.recover();
      timings.recoveryMs.push(performance.now() - recoveryStarted);
      console.log(
        'LOCAL_DURABILITY_MEASUREMENTS ' +
          JSON.stringify({
            payloadBytes: Buffer.byteLength(sample.recordingSerialized),
            concurrency: 1,
            ...timings,
            peakRssBytes: process.resourceUsage().maxRSS * 1024,
          }),
      );
    }

    tail = await listenTestServer(
      http.createServer((_req, res) => {
        if (!holdTail) {
          res.end('background complete');
          return;
        }
        releaseTail = () => res.end('background complete');
        tailEntered?.();
      }),
    );
    api = await startAsyncWorkflowProcess(apiOptions);
    const response = await fetch(api.baseUrl + '/workflows/async-acceptance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tail.baseUrl),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const finishBy = Date.now() + 15_000;
    for (;;) {
      const accepted = await pool.query('SELECT * FROM workflow_run_evidence WHERE workflow_id=$1', [api.projectId]);
      if (accepted.rows.some((row) => row.state === 'succeeded' && row.availability === 'available')) break;
      assert.ok(Date.now() < finishBy, api.logs);
      await delay(50);
    }
    console.log('Real API route accepted, executed and durably recorded an asynchronous graph.');

    const localUrl = api.baseUrl + '/api/workflows/local-editor-recordings';
    const capabilityResponse = await fetch(localUrl + '/capability', { headers: proxyHeaders });
    assert.equal(capabilityResponse.status, 200, await capabilityResponse.clone().text());
    const capability = (await capabilityResponse.json()) as { durability?: string };
    assert.equal(capability.durability, 'run-evidence-v1');
    const editorHandle = { id: randomUUID(), token: randomUUID() },
      correlationId = 'rvt-durable-local-' + randomUUID();
    const post = (suffix: string, body: unknown, executor = false) =>
      fetch(localUrl + suffix, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...proxyHeaders,
          ...(executor
            ? {
                'x-rivet-executor-auth': createHash('sha256')
                  .update('async-fixture-key:executor-internal')
                  .digest('hex'),
              }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    const registration = await post('/runs/begin', {
      handle: editorHandle,
      createdAt: new Date().toISOString(),
      projectId: api.projectId,
      projectPath: api.projectPath,
      graphId: 'unsaved-editor-graph',
      correlationId,
    });
    assert.equal(registration.status, 201, await registration.clone().text());
    const editorUpload = {
      evidenceHandle: editorHandle,
      projectId: api.projectId,
      projectPath: api.projectPath,
      projectContents: serializeProject({
        ...project,
        metadata: { ...project.metadata, id: api.projectId as Project['metadata']['id'] },
      }),
      recordingSerialized: new ExecutionRecorder().serialize(),
      status: 'failed',
      durationMs: 300,
      executionIdentity: { graphId: 'unsaved-editor-graph', correlationId },
    };
    for (const invalidSnapshot of [
      { projectContents: serializeProject(project) },
      { datasetsContents: 'invalid dataset snapshot' },
    ]) {
      const rejected = await post('', { ...editorUpload, ...invalidSnapshot });
      assert.equal(rejected.status, 400, await rejected.clone().text());
      assert.equal((await evidence.read(editorHandle)).state, 'accepted', 'Rejected snapshots must not settle a run');
    }
    const adoption = {
      projectId: api.projectId,
      graphId: 'unsaved-editor-graph',
      correlationId,
      requestId: 'fixture-node-owner',
    };
    assert.equal((await post('/runs/executor-owner', adoption)).status, 403);
    const adopted = await post('/runs/executor-owner', adoption, true);
    assert.equal(adopted.status, 200, await adopted.clone().text());
    assert.deepEqual(((await adopted.json()) as { handle: unknown }).handle, editorHandle);
    await post('/runs/outcome', { handle: editorHandle, outcome: { state: 'succeeded', durationMs: 300 } });
    assert.notEqual(
      (await evidence.read(editorHandle)).state,
      'succeeded',
      'The browser cannot settle a Node-owned run',
    );
    const upload = await post('', editorUpload);
    assert.equal(upload.status, 202, await upload.clone().text());
    assert.equal((await evidence.read(editorHandle)).availability, 'pending');
    const invalidRetry = await post('', { ...editorUpload, projectContents: serializeProject(project) });
    assert.equal(invalidRetry.status, 400, 'A ready handoff must not hide an invalid retry payload');
    const conflictingRetry = await post('', {
      ...editorUpload,
      recordingSerialized: editorUpload.recordingSerialized + ' ',
    });
    assert.equal(conflictingRetry.status, 409, 'A ready handoff must not acknowledge different replay bytes');
    assert.equal(
      (await post('/runs/outcome', { handle: editorHandle, outcome: { state: 'failed', durationMs: 300 } }, true))
        .status,
      200,
    );
    await recovered.recover();
    assert.equal((await evidence.read(editorHandle)).availability, 'available');
    const denied = await post('/runs/read', { handle: { ...editorHandle, token: randomUUID() } });
    assert.equal(denied.status, 409);
    console.log(
      'Real editor API negotiated durable capture, fenced browser outcomes and finalized staged Node evidence.',
    );

    await api.close();
    api = await startAsyncWorkflowProcess({
      ...apiOptions,
      projectName: 'Recording latency fixture',
      endpointName: 'latency-fixture',
      holdRecordingWork: true,
    });
    const timedRequest = async () => {
      const start = performance.now();
      const result = await fetch(api!.baseUrl + '/workflows/latency-fixture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tail!.baseUrl),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(result.status, 200, await result.clone().text());
      await result.json();
      return performance.now() - start;
    };
    const waitIdle = async () => {
      const deadline = Date.now() + 5_000;
      while ((await api!.command<{ active: number }>('snapshot')).active !== 0) {
        assert.ok(Date.now() < deadline, 'Recording I/O retained an execution slot');
        await delay(10);
      }
    };
    await api.command('durability-off');
    await Promise.all(Array.from({ length: 4 }, timedRequest));
    await waitIdle();
    await api.command('scheduled-recordings');
    await api.command('durability-on');
    const blockedRequestMs = await Promise.all(Array.from({ length: 4 }, timedRequest));
    await waitIdle();
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS n FROM workflow_run_evidence WHERE workflow_id=$1', [api.projectId]))
        .rows[0].n,
      0,
    );
    assert.ok((await api.command<{ registrations: number }>('recording-work-state')).registrations > 0);
    await api.command('release-recording-work');
    await api.command('scheduled-recordings');
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM workflow_run_evidence WHERE workflow_id=$1 AND availability='available'",
          [api.projectId],
        )
      ).rows[0].n,
      4,
    );
    console.log(
      'Four public requests completed and released execution slots while recording writes were blocked; recordings caught up after release.',
    );
    const lockedRegistry = await pool.connect();
    try {
      await lockedRegistry.query('BEGIN; LOCK TABLE workflow_recording_project_snapshots IN ACCESS EXCLUSIVE MODE');
      await Promise.all(Array.from({ length: 4 }, timedRequest));
      await waitIdle();
      const before = Date.now() + 3500;
      for (;;) {
        const blocked = await pool.query(
          `SELECT 1 FROM pg_locks WHERE relation='workflow_recording_project_snapshots'::regclass AND NOT granted`,
        );
        if (blocked.rows.length) break;
        assert.ok(Date.now() < before, 'The snapshot writer did not reach the recording database lock.');
        await delay(10);
      }
      assert.equal((await api.command<{ activeRuns: number }>('execution-admission')).activeRuns, 0);
    } finally {
      await lockedRegistry.query('ROLLBACK');
      lockedRegistry.release();
    }
    await api.command('scheduled-recordings');
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM workflow_recording_project_snapshots WHERE workflow_id=$1 AND state='verified'",
          [api.projectId],
        )
      ).rows[0].n,
      1,
    );
    console.log('Public execution released its permits while the shared-snapshot registry was blocked.');
    if (measurePerformance) {
      const latency: { baselineMs: number[]; asynchronousMs: number[] } = { baselineMs: [], asynchronousMs: [] };
      for (let batch = 0; batch < 8; batch++) {
        const enabled = batch % 2 === 1;
        await api.command(enabled ? 'durability-on' : 'durability-off');
        const samples = await Promise.all(Array.from({ length: 4 }, timedRequest));
        latency[enabled ? 'asynchronousMs' : 'baselineMs'].push(...samples);
        await waitIdle();
        await api.command('scheduled-recordings');
      }
      const distribution = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          samples: sorted.length,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        };
      };
      console.log(
        'LOCAL_EXECUTION_LATENCY ' +
          JSON.stringify({
            concurrency: 4,
            baseline: distribution(latency.baselineMs),
            asynchronous: distribution(latency.asynchronousMs),
            blockedRecordingRequestMs: blockedRequestMs,
          }),
      );
    }

    const availableCount = async () =>
      (
        await pool!.query(
          "SELECT COUNT(*)::int AS n FROM workflow_run_evidence WHERE workflow_id=$1 AND availability='available'",
          [api!.projectId],
        )
      ).rows[0].n as number;
    const beforeDisabled = await availableCount();
    holdTail = true;
    const captureReached = new Promise<void>((resolve) => {
      tailEntered = resolve;
    });
    const completing = timedRequest();
    void completing.catch(() => undefined);
    await withAsyncDeadline(captureReached, 'accepted request reaches background branch');
    await api.command('recording-off');
    releaseTail();
    await completing;
    await waitIdle();
    await api.command('scheduled-recordings');
    assert.equal(await availableCount(), beforeDisabled + 1, 'An accepted recording must survive disabling capture');
    holdTail = false;
    await timedRequest();
    await waitIdle();
    await api.command('scheduled-recordings');
    assert.equal(await availableCount(), beforeDisabled + 1, 'New unrecorded requests must not create evidence');
    await api.command('recording-on');
    console.log('Disabling recording preserves accepted capture and prevents new recording admission.');

    catalogBackend = new ManagedWorkflowBackend(config, undefined, { migrationMode: 'verify' });
    const catalogBefore = await catalogBackend.listWorkflowRecordingWorkflows(true);
    const catalogProject = await catalogBackend.createWorkflowProjectItem('', 'Pending-only recordings');
    assert.ok(catalogProject.projectMetadataId);
    const identity = {
      surface: 'editor_local' as const,
      graphId: 'main',
      correlationId: 'rvt-catalog-' + randomUUID(),
    };
    const catalogHandle = await catalogBackend.evidence.begin({
      ...input,
      projectId: catalogProject.projectMetadataId,
      sourceProjectName: catalogProject.name,
      sourceProjectRelativePath: catalogProject.relativePath,
      runKind: 'editor',
      executionIdentity: identity,
    });
    const pendingCatalog = await catalogBackend.listWorkflowRecordingWorkflows(true);
    assert.equal(
      pendingCatalog.workflows.find((item) => item.workflowId === catalogProject.projectMetadataId)?.totalRuns,
      1,
    );
    assert.equal(pendingCatalog.totals!.totalRuns, catalogBefore.totals!.totalRuns + 1);
    assert.ok(
      !(await catalogBackend.listWorkflowRecordingWorkflows()).workflows.some(
        (item) => item.workflowId === catalogProject.projectMetadataId,
      ),
    );
    await catalogBackend.evidence.outcome(catalogHandle, { state: 'failed', durationMs: 1 });
    await catalogBackend.evidence.unavailable(catalogHandle, 'serialization_failed');
    const unavailableCatalog = await catalogBackend.listWorkflowRecordingWorkflows(true);
    assert.equal(
      unavailableCatalog.workflows.find((item) => item.workflowId === catalogProject.projectMetadataId)?.failedRuns,
      1,
    );
    const replayProject = {
      ...project,
      metadata: { ...project.metadata, id: catalogProject.projectMetadataId as Project['metadata']['id'] },
    };
    await catalogBackend.evidence.persist(
      {
        ...recording,
        sourceProject: replayProject,
        executedProject: replayProject,
        runKind: 'editor',
        status: 'failed',
        executionIdentity: identity,
      },
      catalogHandle,
    );
    const savedCatalog = await catalogBackend.listWorkflowRecordingWorkflows(true);
    assert.equal(
      savedCatalog.workflows.find((item) => item.workflowId === catalogProject.projectMetadataId)?.totalRuns,
      1,
    );
    assert.equal(savedCatalog.totals!.totalRuns, pendingCatalog.totals!.totalRuns);
    assert.equal(savedCatalog.totals!.failedRuns, catalogBefore.totals!.failedRuns + 1);
    await catalogBackend.deleteWorkflowRecording(catalogHandle.id);
    const deletedCatalog = await catalogBackend.listWorkflowRecordingWorkflows(true);
    assert.ok(!deletedCatalog.workflows.some((item) => item.workflowId === catalogProject.projectMetadataId));
    assert.equal(deletedCatalog.totals!.totalRuns, catalogBefore.totals!.totalRuns);
    console.log('Catalog shows first pending/unavailable runs and counts publication/deletion exactly once.');
    const compacted = await verifyHistoricalRecordingCompaction(context, {
      baseUrl: api.baseUrl,
      headers: proxyHeaders,
      storage: apiOptions.storage,
      storageConfig: config,
      count: measurePerformance ? 128 : 6,
      compiledCommand: process.argv.includes('--compiled-compaction'),
      traffic: measurePerformance ? { run: timedRequest, settle: waitIdle } : undefined,
    });
    await verifySharedReplayProjects(
      context,
      fresh,
      config,
      api.baseUrl,
      measurePerformance,
      compacted,
      async (objects) => {
        const database = 'rivet_durability_restore';
        const dbContainer = owned[0]!;
        const fixtureDump = '/tmp/rivet-durability-restore.dump';
        docker('exec', dbContainer, 'pg_dump', '-U', 'postgres', '-Fc', '-f', fixtureDump, 'rivet_durability');
        docker('exec', dbContainer, 'createdb', '-U', 'postgres', database);
        docker('exec', dbContainer, 'pg_restore', '-U', 'postgres', '--exit-on-error', '-d', database, fixtureDump);
        const objectStoragePrefix = 'durability-restored/';
        for (const { key, etag } of objects)
          await s3!.send(
            new CopyObjectCommand({
              Bucket: config.objectStorageBucket,
              CopySource: config.objectStorageBucket + '/' + key,
              CopySourceIfMatch: etag,
              Key: objectStoragePrefix + key.slice(config.objectStoragePrefix.length),
            }),
          );
        const databaseUrl = new URL(config.databaseUrl!);
        databaseUrl.pathname = '/' + database;
        return createManagedWorkflowContext(
          { ...config, databaseUrl: databaseUrl.href, objectStoragePrefix },
          undefined,
          { migrationMode: 'verify' },
        );
      },
    );
    if (measurePerformance) {
      await api.close();
      api = undefined;
      await measureSnapshotSharing(apiOptions, pool);
    }
    await catalogBackend.dispose();
    await evidence.dispose();
    await recovered.dispose();
    console.log('Managed recording durability integration passed.');
  } finally {
    releaseTail();
    await api?.command('release-recording-work').catch(() => undefined);
    await api?.close();
    await catalogBackend?.dispose();
    await tail?.close();
    for (const context of contexts) await context.dispose();
    await pool?.end();
    s3?.destroy();
    for (const id of owned.reverse()) docker('rm', '-f', id);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'rivet-durability-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--worker')) await crashWorker();
else await main();
