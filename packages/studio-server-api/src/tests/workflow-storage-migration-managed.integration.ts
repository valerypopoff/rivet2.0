import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import { createEmptyEvaluationLibrary, normalizeEvaluationRun } from '@valerypopoff/rivet2-evaluations';
import { loadProjectFromFile, loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';
import { Pool } from 'pg';

import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { listWorkflowFolders } from '../routes/workflows/workflow-query.js';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import {
  localMetadataGenerationPaths,
  installLocalMetadataServingSelection,
} from '../local-metadata/serving-selection.js';
import { disposeWorkflowStorage } from '../routes/workflows/storage-backend.js';
import { localMetadataSourceIdentity } from '../local-metadata/source-identity.js';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { PostgresRivetEvaluationStore } from '../evaluation-runs/managed-store.js';
import { collectSourceWorkflows } from '../local-metadata/filesystem-workflow-source.js';
import { collectSourceAppSettings } from '../scripts/migrate-app-settings.js';
import { createSourceArchive } from '../scripts/migrate-runtime-libraries.js';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { SqliteMigrationSource } from '../scripts/sqlite-migration-source.js';
import { createWorkflowProjectContentHash } from '../routes/workflows/publication.js';
import { readWorkflowMigrationTargetConfig } from '../scripts/migrate-workflow-storage-lib.js';
import {
  leaveVmMigrationMode,
  reviewVmMigrationDeployment,
  testVmMigrationDatabase,
  testVmMigrationObjectStorage,
  getVmMigrationStatus,
  getVmMigrationSourceInventory,
  enterVmMigrationMode,
  startVmMigration,
  startVmMigrationPrecopy,
} from '../vm-migration-service.js';
import {
  enterVmMigrationMaintenance,
  isVmMigrationMaintenanceActive,
  leaveVmMigrationMaintenance,
} from '../vm-migration-maintenance.js';
import {
  assertVmMigrationTargetMayServe,
  invalidateVmMigrationTargetGate,
  migrationSourceIdentity,
  migrationTargetIdentity,
  verifyVmMigrationTargetGate,
} from '../vm-migration-target-gate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const owned: string[] = [];
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-vm-migration-'));
const classifierHealthEntry = {
  identity: {
    key: 'classifier-profile:migration-fixture',
    family: 'classifier',
    projectId: 'project-a',
    profileNodeId: 'classifier-node',
    profileName: 'Decision route',
    provider: 'liquid',
    model: 'd1',
    configurationFingerprint: 'sha256:classifier-fixture',
  },
  failureTimestamps: [Date.parse('2026-09-26T12:00:00.000Z')],
  failureEvidence: [
    {
      id: 'classifier-failure',
      occurredAt: Date.parse('2026-09-26T12:00:00.000Z'),
      correlationId: 'migration-correlation',
      recordingId: 'migration-recording',
      recordingAvailability: 'available',
    },
  ],
  activeSuspension: {
    id: 'classifier-suspension',
    contributorEventIds: ['classifier-failure'],
    triggerEventId: 'classifier-failure',
  },
  openUntil: Date.parse('2026-09-26T12:01:00.000Z'),
  closedPermits: {},
  updatedAt: Date.parse('2026-09-26T12:00:00.000Z'),
  policy: { failureThreshold: 1, failureWindowMs: 60_000, openDurationMs: 60_000, halfOpenLeaseMs: 10_000 },
};
let pool: Pool | undefined;

try {
  const launch = (port: number, ...args: string[]) => {
    const id = docker('run', '-d', '--name', `rivet-migration-${randomUUID()}`, '-p', `127.0.0.1::${port}`, ...args);
    owned.push(id);
    return Number(
      docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
    );
  };
  const databasePort = launch(
    5432,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=rivet_migration',
    'postgres:16.8-alpine',
  );
  const s3Port = launch(
    9000,
    '-e',
    'MINIO_ROOT_USER=migration',
    '-e',
    'MINIO_ROOT_PASSWORD=migrationsecret',
    '-e',
    'MINIO_REGION_NAME=eu-west-7',
    process.env.RIVET_ASYNC_TEST_MINIO_IMAGE ||
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
    'server',
    '/tmp/minio',
  );
  const databaseUrl = `postgres://postgres@127.0.0.1:${databasePort}/rivet_migration`;
  pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      await pool.query('SELECT 1');
      const ready = await fetch(`http://127.0.0.1:${s3Port}/minio/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!ready.ok) throw new Error('Object storage is not ready');
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }

  const workflowsRoot = path.join(root, 'workflows');
  const recordingsRoot = path.join(root, 'recordings');
  const appDataRoot = path.join(root, 'app-data');
  const runtimeRoot = path.join(root, 'runtime-libraries');
  for (const directory of [workflowsRoot, recordingsRoot, appDataRoot, runtimeRoot]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.mkdir(path.join(appDataRoot, 'settings'));
  await fs.writeFile(
    path.join(appDataRoot, 'settings', 'environment-variables.json'),
    JSON.stringify({
      version: 1,
      variables: [
        { id: 'migration_secret_1', name: 'MIGRATION_SECRET', value: 'fixture-sensitive-value', browserAccess: false },
      ],
      updatedAt: '2026-09-26T12:00:00.000Z',
    }),
  );
  const evaluation = new DatabaseSync(path.join(appDataRoot, 'evaluation-runs.sqlite'));
  try {
    evaluation.exec(`
      CREATE TABLE evaluation_library (revision INTEGER NOT NULL, library_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE evaluation_library_imports (source_fingerprint TEXT NOT NULL, imported_at_ms INTEGER NOT NULL);
      CREATE TABLE evaluation_runs (project_id TEXT NOT NULL, run_id TEXT NOT NULL, suite_id TEXT NOT NULL,
        started_at TEXT NOT NULL, run_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE evaluation_recordings (project_id TEXT NOT NULL, recording_id TEXT NOT NULL, run_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE evaluation_dataset_snapshots (project_id TEXT NOT NULL, dataset_fingerprint TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    `);
    evaluation
      .prepare('INSERT INTO evaluation_library VALUES (?, ?, ?)')
      .run(1, JSON.stringify(createEmptyEvaluationLibrary()), Date.parse('2026-09-26T12:00:00.000Z'));
  } finally {
    evaluation.close();
  }
  const health = new DatabaseSync(path.join(appDataRoot, 'llm-profile-health.sqlite'));
  try {
    // The old schema lacked project_id; migration must read it without altering the source.
    health.exec(
      'CREATE TABLE llm_profile_health (key TEXT PRIMARY KEY, entry_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)',
    );
    health.prepare('INSERT INTO llm_profile_health VALUES (?, ?, ?)').run(
      'legacy-fixture',
      JSON.stringify({
        identity: {
          key: 'legacy-fixture',
          projectId: 'project-a',
          profileNodeId: 'profile-node',
          profileName: 'Primary route',
          provider: 'custom',
          model: 'fast-model',
          customProviderApi: 'completions',
          configurationFingerprint: 'sha256:configuration',
        },
        failureTimestamps: [],
        failureEvidence: [],
        closedPermits: {},
        updatedAt: Date.parse('2026-09-26T12:00:00.000Z'),
        policy: { failureWindowMs: 60_000, openDurationMs: 60_000, halfOpenLeaseMs: 10_000 },
      }),
      Date.parse('2026-09-26T12:00:00.000Z'),
    );
    health
      .prepare('INSERT INTO llm_profile_health VALUES (?, ?, ?)')
      .run(classifierHealthEntry.identity.key, JSON.stringify(classifierHealthEntry), classifierHealthEntry.updatedAt);
  } finally {
    health.close();
  }
  const currentLibraries = path.join(runtimeRoot, 'current');
  await fs.mkdir(path.join(currentLibraries, 'node_modules', 'tiny-lib'), { recursive: true });
  await fs.writeFile(path.join(currentLibraries, 'package.json'), '{"name":"rivet-runtime-libraries","private":true}');
  await fs.writeFile(
    path.join(currentLibraries, 'node_modules', 'tiny-lib', 'package.json'),
    '{"name":"tiny-lib","version":"1.0.0"}',
  );
  await fs.writeFile(path.join(currentLibraries, 'node_modules', 'tiny-lib', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(
    path.join(runtimeRoot, 'manifest.json'),
    JSON.stringify({
      packages: { 'tiny-lib': { name: 'tiny-lib', version: '1.0.0' } },
      updatedAt: '2026-09-26T12:00:00.000Z',
    }),
  );
  const projectContents = createBlankProjectFile('Migration Fixture');
  const projectPath = path.join(workflowsRoot, 'fixture.rivet-project');
  const snapshotId = randomUUID();
  const publishedAt = new Date('2026-09-26T12:00:00.000Z').toISOString();
  await fs.writeFile(projectPath, projectContents);
  const projectId = (await loadProjectFromFile(projectPath)).metadata.id;
  const evaluationRunId = randomUUID();
  const evaluationDatabase = new DatabaseSync(path.join(appDataRoot, 'evaluation-runs.sqlite'));
  try {
    const timestamp = Date.parse('2026-09-26T12:00:00.000Z');
    evaluationDatabase.prepare('INSERT INTO evaluation_library_imports VALUES (?, ?)').run('fixture-import', timestamp);
    evaluationDatabase
      .prepare('INSERT INTO evaluation_runs VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        projectId,
        evaluationRunId,
        'fixture-suite',
        new Date(timestamp).toISOString(),
        JSON.stringify({ id: evaluationRunId, status: 'completed', input: { prompt: 'migration-evaluation' } }),
        timestamp,
      );
    evaluationDatabase
      .prepare('INSERT INTO evaluation_recordings VALUES (?, ?, ?, ?, ?)')
      .run(projectId, randomUUID(), evaluationRunId, JSON.stringify({ chunks: ['recorded'] }), timestamp);
    evaluationDatabase
      .prepare('INSERT INTO evaluation_dataset_snapshots VALUES (?, ?, ?, ?)')
      .run(projectId, 'fixture-dataset', JSON.stringify({ rows: [{ input: 'migration-evaluation' }] }), timestamp);
  } finally {
    evaluationDatabase.close();
  }
  assert.ok(projectId);
  const uiGraphId = Object.keys((await loadProjectFromFile(projectPath)).graphs)[0];
  assert.ok(uiGraphId);
  const publishedStateHash = await createWorkflowProjectContentHash(projectPath);
  await fs.mkdir(path.join(workflowsRoot, '.published'));
  await fs.writeFile(path.join(workflowsRoot, '.published', `${snapshotId}.rivet-project`), projectContents);
  const olderSnapshotId = randomUUID();
  await fs.writeFile(path.join(workflowsRoot, '.published', `${olderSnapshotId}.rivet-project`), projectContents);
  for (const [id, starred, comment] of [
    [snapshotId, false, ''],
    [olderSnapshotId, true, 'Earlier release'],
  ] as const) {
    await fs.writeFile(
      path.join(workflowsRoot, '.published', `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        projectId,
        projectName: 'Migration Fixture',
        relativePath: 'fixture.rivet-project',
        endpointName: 'migration-fixture',
        publishedAt,
        stateHash: publishedStateHash,
        isStarred: starred,
        comment,
      }),
    );
  }
  await fs.writeFile(
    `${projectPath}.wrapper-settings.json`,
    JSON.stringify({
      publicationVersion: '1',
      endpointName: 'migration-fixture',
      endpointAccess: 'internal',
      publishedEndpointName: 'migration-fixture',
      publishedSnapshotId: snapshotId,
      publishedStateHash,
      lastPublishedAt: publishedAt,
      publishedWebApps: [
        {
          appId: randomUUID(),
          uiGraphId,
          uiGraphName: 'Fixture UI',
          slug: 'migration-fixture-app',
          allowedEmails: ['admin@example.test'],
          publishedAt,
          publishedSnapshotId: snapshotId,
        },
      ],
    }),
  );
  const legacyPath = path.join(workflowsRoot, 'legacy.rivet-project');
  await fs.writeFile(legacyPath, createBlankProjectFile('Legacy'));
  await fs.mkdir(path.join(workflowsRoot, 'nested'));
  await fs.writeFile(path.join(workflowsRoot, 'nested', 'child.rivet-project'), createBlankProjectFile('Nested Child'));
  await fs.writeFile(
    `${legacyPath}.wrapper-settings.json`,
    JSON.stringify({
      status: 'unpublished_changes',
      endpointName: 'legacy',
      publishedEndpointName: 'legacy',
      lastPublishedAt: publishedAt,
    }),
  );

  const recordingId = randomUUID();
  const recordingBundle = path.join(recordingsRoot, projectId, recordingId);
  await fs.mkdir(recordingBundle, { recursive: true });
  const recordingContents = JSON.stringify({
    version: 1,
    recording: {
      recordingId,
      events: [
        {
          type: 'graphStart',
          data: { graphId: 'main', inputs: { prompt: { type: 'object', value: { requestId: 'migration-input' } } } },
          ts: 1,
        },
      ],
      startTs: 1,
      finishTs: 2,
    },
    assets: {},
    strings: {},
  });
  await fs.writeFile(path.join(recordingBundle, 'recording.rivet-recording'), recordingContents);
  await fs.writeFile(path.join(recordingBundle, 'replay.rivet-project'), projectContents);
  await fs.writeFile(
    path.join(recordingBundle, 'metadata.json'),
    JSON.stringify({
      version: 3,
      id: recordingId,
      workflowId: projectId,
      sourceProjectMetadataId: projectId,
      sourceProjectName: 'Migration Fixture',
      sourceProjectPath: projectPath,
      sourceProjectRelativePath: 'fixture.rivet-project',
      endpointNameAtExecution: 'migration-fixture',
      createdAt: publishedAt,
      runKind: 'published',
      status: 'succeeded',
      durationMs: 7,
      encoding: 'identity',
      hasReplayDataset: false,
      recordingCompressedBytes: Buffer.byteLength(recordingContents),
      recordingUncompressedBytes: Buffer.byteLength(recordingContents),
      projectCompressedBytes: Buffer.byteLength(projectContents),
      projectUncompressedBytes: Buffer.byteLength(projectContents),
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
    }),
  );

  const env = {
    ...process.env,
    RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT: workflowsRoot,
    RIVET_MIGRATION_SOURCE_APP_DATA_ROOT: appDataRoot,
    RIVET_MIGRATION_SOURCE_RECORDINGS_ROOT: recordingsRoot,
    RIVET_MIGRATION_SOURCE_RUNTIME_LIBRARIES_ROOT: runtimeRoot,
    RIVET_MIGRATION_TARGET_DATABASE_URL: databaseUrl,
    RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: 'disable',
    RIVET_MIGRATION_TARGET_S3_BUCKET: 'rivet-migration-fixture',
    RIVET_MIGRATION_TARGET_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    RIVET_MIGRATION_TARGET_S3_REGION: 'eu-west-7',
    RIVET_MIGRATION_TARGET_S3_PREFIX: 'tenant/migration-workflows/',
    RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: 'true',
    RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: 'migration',
    RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: 'migrationsecret',
    RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY: 'migration-fixture-settings-key',
    RIVET_MIGRATION_SOURCE_QUIESCED: '1',
    RIVET_MIGRATION_TARGET_OFFLINE: '1',
    RIVET_MIGRATION_RUNTIME_PLATFORM_ACK: '1',
    RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify', // Import copy mode must still create the empty target schema.
    RIVET_MANAGED_MAINTENANCE_ENABLED: 'true', // Migration mode must suppress background work despite ambient flags.
    RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
    RIVET_MIGRATION_REPORT_PATH: path.join(root, 'verification-report.json'),
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
  };
  const destination = {
    databaseUrl,
    databaseSslMode: 'disable',
    bucket: env.RIVET_MIGRATION_TARGET_S3_BUCKET,
    endpoint: env.RIVET_MIGRATION_TARGET_S3_ENDPOINT,
    region: env.RIVET_MIGRATION_TARGET_S3_REGION,
    prefix: env.RIVET_MIGRATION_TARGET_S3_PREFIX,
    forcePathStyle: true,
    accessKeyId: env.RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY,
    settingsEncryptionKey: env.RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY,
    targetOffline: true,
    runtimePlatformCompatible: true,
  };
  const run = (mode: 'precopy' | 'migrate' | 'verify' | 'freeze-source', overrides: NodeJS.ProcessEnv = {}) =>
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs'),
        'workspace',
        '@valerypopoff/rivet-studio-server-api',
        'run',
        `workflow-storage:${mode}`,
      ],
      { cwd: repoRoot, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 180_000 },
    );

  const previousAppDataRoot = process.env.RIVET_APP_DATA_ROOT;
  const previousEditorControl = process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL;
  const previousUiAuthMode = process.env.RIVET_SERVER_UI_AUTH_MODE;
  const previousTopology = process.env.RIVET_DEPLOYMENT_TOPOLOGY;
  process.env.RIVET_APP_DATA_ROOT = appDataRoot;
  process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL = '1';
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
  delete process.env.RIVET_DEPLOYMENT_TOPOLOGY;
  try {
    await testVmMigrationDatabase({ databaseUrl, databaseSslMode: 'disable' });
    await testVmMigrationObjectStorage({
      bucket: env.RIVET_MIGRATION_TARGET_S3_BUCKET,
      endpoint: env.RIVET_MIGRATION_TARGET_S3_ENDPOINT,
      region: env.RIVET_MIGRATION_TARGET_S3_REGION,
      prefix: env.RIVET_MIGRATION_TARGET_S3_PREFIX,
      forcePathStyle: true,
      accessKeyId: env.RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID,
      secretAccessKey: env.RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY,
    });
  } finally {
    if (previousAppDataRoot === undefined) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousAppDataRoot;
    if (previousEditorControl === undefined) delete process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL;
    else process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL = previousEditorControl;
    if (previousUiAuthMode === undefined) delete process.env.RIVET_SERVER_UI_AUTH_MODE;
    else process.env.RIVET_SERVER_UI_AUTH_MODE = previousUiAuthMode;
    if (previousTopology === undefined) delete process.env.RIVET_DEPLOYMENT_TOPOLOGY;
    else process.env.RIVET_DEPLOYMENT_TOPOLOGY = previousTopology;
  }
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_class WHERE relname LIKE 'rivet_vm_migration_preflight_%' LIMIT 1")).rowCount,
    0,
  );

  await pool.query('CREATE TABLE workflow_folders (relative_path TEXT NOT NULL)');
  await pool.query("INSERT INTO workflow_folders (relative_path) VALUES ('occupied')");
  assert.throws(() => run('migrate'), /Destination contains existing workflow_folders data/);
  assert.equal((await pool.query("SELECT to_regclass('public.rivet_vm_migration_gate') AS gate")).rows[0]?.gate, null);
  await pool.query('DROP TABLE workflow_folders');

  // A final-copy preflight failure happens before the importer creates any
  // gate. The VM must be resumable without inventing a gate to close.
  const preflightOriginalRoots = Object.fromEntries(
    [
      'RIVET_APP_DATA_ROOT',
      'RIVET_WORKFLOWS_ROOT',
      'RIVET_WORKFLOW_RECORDINGS_ROOT',
      'RIVET_RUNTIME_LIBRARIES_ROOT',
    ].map((key) => [key, process.env[key]]),
  );
  try {
    process.env.RIVET_APP_DATA_ROOT = appDataRoot;
    process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
    process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
    process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeRoot;
    await enterVmMigrationMaintenance();
    await fs.writeFile(
      path.join(appDataRoot, 'vm-migration-job.json'),
      JSON.stringify({
        id: randomUUID(),
        phase: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: null,
        finalCopyStarted: true,
        precopyCompleted: false,
        targetIdentity: migrationTargetIdentity(readWorkflowMigrationTargetConfig(env)),
      }),
    );
    const failedWithoutPrecopyJob = JSON.parse(
      await fs.readFile(path.join(appDataRoot, 'vm-migration-job.json'), 'utf8'),
    );
    await fs.writeFile(
      path.join(appDataRoot, 'vm-migration-job.json'),
      JSON.stringify({ ...failedWithoutPrecopyJob, precopyCompleted: true }),
    );
    await assert.rejects(() => leaveVmMigrationMode(destination), /startup gate/);
    assert.equal(isVmMigrationMaintenanceActive(), true);
    await fs.writeFile(path.join(appDataRoot, 'vm-migration-job.json'), JSON.stringify(failedWithoutPrecopyJob));
    await leaveVmMigrationMode(destination);
    assert.equal(isVmMigrationMaintenanceActive(), false);
  } finally {
    for (const [key, value] of Object.entries(preflightOriginalRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  run('precopy');
  await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  run('migrate');
  assert.equal(
    (await pool.query('SELECT 1 FROM managed_maintenance_leases LIMIT 1')).rowCount,
    0,
    'The importer must not start managed retention or reconciliation on its offline target.',
  );
  await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  run('migrate'); // A second copy must accept exact existing state.
  run('verify');
  await assertVmMigrationTargetMayServe(pool!);
  const driftFile = path.join(workflowsRoot, 'host-edit-during-freeze.txt');
  await fs.writeFile(driftFile, 'unexpected host edit');
  assert.throws(() => run('verify'), /Frozen VM source changed/);
  await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  await fs.rm(driftFile);
  run('verify');
  run('verify'); // Auditing the same verified snapshot remains repeatable.
  await assertVmMigrationTargetMayServe(pool!);
  const reportPath = path.join(root, 'verification-report.json');
  const reportContents = await fs.readFile(reportPath, 'utf8');
  const report = JSON.parse(reportContents) as {
    projects: number;
    recordings: number;
    checked: string[];
  };
  assert.equal(report.projects, 3);
  assert.equal(report.recordings, 1);
  assert.ok(report.checked.includes('Recording metadata and replay artifact bytes'));
  assert.ok(!reportContents.includes('migrationsecret'));
  await pool.query(
    `INSERT INTO evaluation_hosted_runs (project_id, run_id, status, snapshot_json)
     VALUES ($1, $2, 'queued', '{}'::jsonb)`,
    [projectId, evaluationRunId],
  );
  assert.throws(() => run('verify'), /Unexpected managed evaluation_hosted_runs rows/);
  await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  await pool.query('DELETE FROM evaluation_hosted_runs WHERE project_id = $1 AND run_id = $2', [
    projectId,
    evaluationRunId,
  ]);
  run('verify');
  await assertVmMigrationTargetMayServe(pool!);
  const reviewEnvNames = [
    'RIVET_APP_DATA_ROOT',
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
    'RIVET_VM_MIGRATION_EDITOR_CONTROL',
    'RIVET_SERVER_UI_AUTH_MODE',
    'RIVET_DEPLOYMENT_TOPOLOGY',
  ];
  const reviewPreviousEnv = Object.fromEntries(reviewEnvNames.map((name) => [name, process.env[name]]));
  try {
    process.env.RIVET_APP_DATA_ROOT = appDataRoot;
    process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
    process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
    process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeRoot;
    process.env.RIVET_VM_MIGRATION_EDITOR_CONTROL = '1';
    process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
    delete process.env.RIVET_DEPLOYMENT_TOPOLOGY;
    await enterVmMigrationMaintenance();
    await fs.writeFile(
      path.join(appDataRoot, 'vm-migration-job.json'),
      JSON.stringify({
        id: randomUUID(),
        phase: 'verified',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: null,
        finalCopyStarted: true,
        targetIdentity: migrationTargetIdentity(readWorkflowMigrationTargetConfig(env)),
        report,
      }),
    );
    await pool.query(
      `INSERT INTO evaluation_hosted_runs (project_id, run_id, status, snapshot_json)
       VALUES ($1, $2, 'queued', '{}'::jsonb)`,
      [projectId, evaluationRunId],
    );
    const admittedReview = await reviewVmMigrationDeployment(destination, {
      backupCompleted: true,
      deploymentSettingsMatch: true,
      functionalRehearsalPassed: true,
      externalDependenciesReviewed: true,
      rollbackWindowUnderstood: true,
    });
    assert.equal(admittedReview.phase, 'verifying');
    const reviewDeadline = Date.now() + 120_000;
    while ((await getVmMigrationStatus()).job?.phase === 'verifying') {
      if (Date.now() > reviewDeadline) throw new Error('Failed deployment review did not settle');
      await delay(100);
    }
    const failedReview = JSON.parse(await fs.readFile(path.join(appDataRoot, 'vm-migration-job.json'), 'utf8'));
    assert.equal(failedReview.phase, 'failed');
    assert.match(failedReview.message, /destination gate is closed/);
    await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
    await pool.query('DELETE FROM evaluation_hosted_runs WHERE project_id = $1 AND run_id = $2', [
      projectId,
      evaluationRunId,
    ]);
    await leaveVmMigrationMode(destination);
  } finally {
    for (const [name, value] of Object.entries(reviewPreviousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  run('verify');
  await assertVmMigrationTargetMayServe(pool!);
  const emptySourceRoot = path.join(root, 'empty-workflows');
  await fs.mkdir(emptySourceRoot);
  assert.throws(
    () => run('verify', { RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT: emptySourceRoot }),
    /Migration target gate does not belong to this source and destination/,
  );
  const emptyAppDataRoot = path.join(root, 'empty-app-data');
  await fs.mkdir(emptyAppDataRoot);
  assert.throws(
    () => run('verify', { RIVET_MIGRATION_SOURCE_APP_DATA_ROOT: emptyAppDataRoot }),
    /Migration target gate does not belong to this source and destination/,
  );
  await assertVmMigrationTargetMayServe(pool!); // A wrong source identity must not close the rightful target.
  const managed = new ManagedWorkflowBackend(readWorkflowMigrationTargetConfig(env), undefined, {
    migrationMode: 'verify',
  });
  try {
    const filtered = await managed.listWorkflowRecordingRunsPage(projectId, 1, 10, 'all', {
      path: '$.prompt.requestId',
      operator: '==',
      value: 'migration-input',
    });
    assert.deepEqual(
      filtered.runs.map((run) => run.id),
      [recordingId],
    );
  } finally {
    await managed.dispose();
  }
  const workflow = await pool.query<{
    endpoint_access: string;
    publication_version: string;
    published_version_id: string;
  }>(
    "SELECT endpoint_access, publication_version, published_version_id FROM workflows WHERE relative_path = 'fixture.rivet-project'",
  );
  assert.equal(workflow.rows.length, 1);
  assert.equal(workflow.rows[0]?.endpoint_access, 'internal');
  assert.equal(workflow.rows[0]?.publication_version, '1');
  assert.equal(workflow.rows[0]?.published_version_id, snapshotId);
  const legacy = await pool.query<{ current_draft_revision_id: string; published_revision_id: string }>(
    "SELECT current_draft_revision_id, published_revision_id FROM workflows WHERE relative_path = 'legacy.rivet-project'",
  );
  assert.equal(legacy.rows.length, 1);
  assert.notEqual(legacy.rows[0]?.current_draft_revision_id, legacy.rows[0]?.published_revision_id);
  const versions = await pool.query('SELECT version_id FROM workflow_published_versions');
  assert.equal(versions.rows.length, 3);
  assert.ok(versions.rows.some((row) => row.version_id === snapshotId));
  assert.deepEqual(
    (await pool.query('SELECT recording_id FROM workflow_recordings')).rows.map((row) => row.recording_id),
    [recordingId],
  );
  const settings = await pool.query('SELECT setting_key FROM app_settings');
  assert.ok(settings.rows.some((row) => row.setting_key === 'deployment storage'));
  const secret = await pool.query<{ ciphertext: Buffer }>(
    "SELECT ciphertext FROM app_settings WHERE setting_key = 'environment variable'",
  );
  assert.equal(secret.rows.length, 1);
  assert.equal(secret.rows[0]?.ciphertext.includes(Buffer.from('fixture-sensitive-value')), false);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM evaluation_library')).rows[0]?.count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM evaluation_library_imports')).rows[0]?.count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM evaluation_runs')).rows[0]?.count, 1);
  // Exercise the shared keyset query against actual PostgreSQL, not just a
  // mocked pool. Equal timestamps must neither repeat nor omit run headers.
  const evaluationStore = new PostgresRivetEvaluationStore(pool);
  const pageIds = Array.from({ length: 4 }, (_, index) => `page-fixture-${index}`);
  try {
    for (const id of pageIds) {
      const fixture = normalizeEvaluationRun({ id, status: 'completed', trials: [] });
      await evaluationStore.put({ ...fixture, projectId, suiteId: 'page-fixture', startedAt: publishedAt });
    }
    const first = await evaluationStore.listPage({ projectId, suiteId: 'page-fixture', limit: 2 });
    assert.deepEqual(
      first.runs.map((run) => run.id),
      ['page-fixture-3', 'page-fixture-2'],
    );
    assert.equal('trials' in first.runs[0]!, false);
    assert.equal('provenance' in first.runs[0]!, false);
    const second = await evaluationStore.listPage({
      projectId,
      suiteId: 'page-fixture',
      limit: 2,
      after: first.nextCursor,
    });
    assert.deepEqual(
      second.runs.map((run) => run.id),
      ['page-fixture-1', 'page-fixture-0'],
    );
    assert.equal(second.nextCursor, undefined);
    assert.ok(Array.isArray((await evaluationStore.get({ projectId, runId: pageIds[0]! }))?.trials));
    await assert.rejects(
      evaluationStore.listPage({ projectId, suiteId: 'other-suite', after: first.nextCursor }),
      /cursor/,
    );
  } finally {
    for (const id of pageIds) await evaluationStore.delete({ projectId, runId: id });
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM evaluation_recordings')).rows[0]?.count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM evaluation_dataset_snapshots')).rows[0]?.count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM llm_profile_health')).rows[0]?.count, 2);
  const assertClassifierHealthMigrated = async () => {
    const row = (
      await pool!.query('SELECT project_id, entry_json FROM llm_profile_health WHERE key = $1', [
        classifierHealthEntry.identity.key,
      ])
    ).rows[0];
    assert.equal(row?.project_id, classifierHealthEntry.identity.projectId);
    assert.deepEqual(row?.entry_json, classifierHealthEntry);
  };
  await assertClassifierHealthMigrated();
  assert.equal((await pool.query('SELECT project_id FROM llm_profile_health')).rows[0]?.project_id, 'project-a');
  assert.equal(
    (await pool.query('SELECT active_release_id FROM runtime_library_activation')).rows[0]?.active_release_id != null,
    true,
  );
  const incompleteBundle = path.join(recordingsRoot, projectId, randomUUID());
  await fs.mkdir(incompleteBundle);
  assert.throws(() => run('verify'), /Source recording bundle is incomplete or mismatched/);
  await fs.rmdir(incompleteBundle);
  await fs.rm(path.join(recordingBundle, 'replay.rivet-project'));
  assert.throws(() => run('verify'), /missing or unreadable replay-project artifact/);
  await fs.mkdir(path.join(recordingBundle, 'replay.rivet-project'));
  assert.throws(() => run('verify'), /missing or unreadable replay-project artifact/);
  await fs.rmdir(path.join(recordingBundle, 'replay.rivet-project'));
  await fs.writeFile(path.join(recordingBundle, 'replay.rivet-project'), projectContents);
  await fs.writeFile(path.join(runtimeRoot, 'active-release'), 'legacy-release');
  assert.throws(() => run('verify'), /Frozen VM source changed/);
  const targetIdentity = migrationTargetIdentity(readWorkflowMigrationTargetConfig(env));
  const sourceIdentity = migrationSourceIdentity([workflowsRoot, appDataRoot, recordingsRoot, runtimeRoot]);
  const originalRoots = Object.fromEntries(
    [
      'RIVET_APP_DATA_ROOT',
      'RIVET_WORKFLOWS_ROOT',
      'RIVET_WORKFLOW_RECORDINGS_ROOT',
      'RIVET_RUNTIME_LIBRARIES_ROOT',
    ].map((key) => [key, process.env[key]]),
  );
  try {
    process.env.RIVET_APP_DATA_ROOT = appDataRoot;
    process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
    process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
    process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeRoot;
    await enterVmMigrationMaintenance();
    await fs.writeFile(
      path.join(appDataRoot, 'vm-migration-job.json'),
      JSON.stringify({
        id: randomUUID(),
        phase: 'verified',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: null,
        precopyCompleted: true,
        targetIdentity,
      }),
    );
    await assert.rejects(() => leaveVmMigrationMode(), /re-enter its credentials/);
    assert.equal(isVmMigrationMaintenanceActive(), true);
    await leaveVmMigrationMode(destination);
    assert.equal(isVmMigrationMaintenanceActive(), false);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(appDataRoot, 'vm-migration-job.json'), 'utf8')).phase,
      'invalidated',
    );
    // A final copy can run without pre-copy. If its verify child opens the
    // gate and then fails, resuming the VM must still close that gate.
    await verifyVmMigrationTargetGate(pool!, sourceIdentity, targetIdentity);
    await enterVmMigrationMaintenance();
    await fs.writeFile(
      path.join(appDataRoot, 'vm-migration-job.json'),
      JSON.stringify({
        id: randomUUID(),
        phase: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        message: null,
        precopyCompleted: false,
        finalCopyStarted: true,
        targetIdentity,
      }),
    );
    await assert.rejects(() => leaveVmMigrationMode(), /re-enter its credentials/);
    assert.equal(isVmMigrationMaintenanceActive(), true);
    await leaveVmMigrationMode(destination);
    await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  } finally {
    for (const [key, value] of Object.entries(originalRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await invalidateVmMigrationTargetGate(pool!, sourceIdentity, targetIdentity);
  await invalidateVmMigrationTargetGate(pool!, sourceIdentity, targetIdentity); // Recovery after a VM crash is idempotent.
  await assert.rejects(() => assertVmMigrationTargetMayServe(pool!), /migration target is incomplete/i);
  console.log('VM-to-managed migration: copy, idempotent retry and exact verification passed.');

  // A resumed SQLite installation must export its live generation, not its
  // retained legacy files. Rehearse this into a separate database and bucket.
  await pool!.query('CREATE DATABASE rivet_native_migration');
  const controlRoot = path.join(root, 'native-control');
  const paths = localMetadataGenerationPaths(controlRoot, 'native-live');
  const sourceRoots = {
    workflows: workflowsRoot,
    recordings: recordingsRoot,
    appData: appDataRoot,
    runtimeLibraries: runtimeRoot,
  };
  const catalog = new LocalWorkflowCatalog({
    databasePath: paths.catalogDatabasePath,
    artifactRoot: paths.artifactRoot,
  });
  const sourceBackend = new SqliteWorkflowBackend({
    databasePath: paths.catalogDatabasePath,
    artifactRoot: paths.artifactRoot,
    virtualRoot: workflowsRoot,
    withWrite: (operation) => operation(),
  });
  const sourceSettings = new SqliteAppSettingsBackend({ databasePath: paths.settingsDatabasePath });
  const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
  const nativeEnv = {
    RIVET_MIGRATION_SOURCE_LOCAL_METADATA_CONTROL_ROOT: controlRoot,
    RIVET_MIGRATION_TARGET_DATABASE_URL: `postgres://postgres@127.0.0.1:${databasePort}/rivet_native_migration`,
    RIVET_MIGRATION_TARGET_S3_BUCKET: 'rivet-native-migration-fixture',
    RIVET_MIGRATION_SOURCE_STOPPED: '1',
  };
  const previousNativeRoots = Object.fromEntries(Object.keys(originalRoots).map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    RIVET_WORKFLOWS_ROOT: workflowsRoot,
    RIVET_APP_DATA_ROOT: appDataRoot,
    RIVET_WORKFLOW_RECORDINGS_ROOT: recordingsRoot,
    RIVET_RUNTIME_LIBRARIES_ROOT: runtimeRoot,
  });
  try {
    await fs.mkdir(paths.operationalRoot, { recursive: true });
    catalog.initialize();
    sourceBackend.initialize();
    await sourceSettings.initialize();
    const importFolders = (folders: Awaited<ReturnType<typeof listWorkflowFolders>>) => {
      for (const folder of folders) {
        catalog.importFolder(folder.relativePath);
        importFolders(folder.folders);
      }
    };
    importFolders(await listWorkflowFolders(workflowsRoot));
    for (const snapshot of await collectSourceWorkflows(workflowsRoot)) await catalog.importProject(snapshot);
    const latest = await sourceBackend.loadHostedProject(projectPath);
    const [project, attached] = loadProjectAndAttachedDataFromString(latest.contents);
    project.metadata.description = 'Changed after SQLite cutover; retained legacy file is stale.';
    let liveContents = serializeProject(project, attached) as string;
    await sourceBackend.saveHostedProject({
      projectPath,
      contents: liveContents,
      datasetsContents: null,
      expectedRevisionId: latest.revisionId,
    });
    // Hosted saves normalize title to the catalog name. Transfer must preserve
    // the actual durable source bytes, not the pre-normalization UI submission.
    liveContents = (await sourceBackend.loadHostedProject(projectPath)).contents;
    assert.equal(
      loadProjectAndAttachedDataFromString(liveContents)[0].metadata.description,
      project.metadata.description,
    );
    // Endpoint state must not inherit a still-published web app's aggregate state.
    const publication = await sourceBackend.listWorkflowProjectWebApps('fixture.rivet-project');
    const unpublished = await sourceBackend.unpublishWorkflowProjectItem('fixture.rivet-project', {
      expectedProjectId: publication.projectId,
      expectedPublicationVersion: publication.publicationVersion!,
    });
    assert.equal(unpublished.settings.status, 'unpublished');
    assert.equal(unpublished.settings.publicationStatus, 'unpublished_changes');
    await catalog.importRecording({
      recordingId,
      workflowId: projectId,
      sourceProjectRelativePath: 'fixture.rivet-project',
      sourceProjectName: 'fixture',
      createdAt: publishedAt,
      runKind: 'published',
      status: 'succeeded',
      durationMs: 7,
      endpointName: 'migration-fixture',
      errorMessage: null,
      recordingContents,
      replayProjectContents: projectContents,
      replayDatasetContents: null,
    });
    for (const row of await collectSourceAppSettings(appDataRoot))
      await sourceSettings.write({ ...row, expectedRevision: null });
    await catalog.importRuntimeLibraryState({
      manifest: {
        packages: { 'tiny-lib': { name: 'tiny-lib', version: '1.0.0' } },
        updatedAt: publishedAt,
        activeReleaseId: 'native-release',
      },
      archive: await createSourceArchive(runtimeRoot),
    });
    for (const database of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite'])
      await fs.copyFile(path.join(appDataRoot, database), path.join(paths.operationalRoot, database));
    const proof = {
      id: 'native-live',
      sourceIdentity: localMetadataSourceIdentity(sourceRoots),
      candidateIdentity: '1'.repeat(64),
      sourceFingerprint: '2'.repeat(64),
      candidateFingerprint: '3'.repeat(64),
      reportHash: '4'.repeat(64),
    };
    await journal.initialize({ create: true });
    const verified = journal.recordVerifiedCandidate(1, proof),
      selected = journal.selectSqliteForValidation(verified.revision, proof);
    const validated = journal.recordRuntimeValidation(selected.revision, 'sqlite', proof.id, '5'.repeat(64));
    const live = journal.resumeWrites(validated.revision, proof);
    sourceBackend.close();
    catalog.close();
    await sourceSettings.dispose();
    journal.close();
    run('freeze-source', nativeEnv);
    run('migrate', nativeEnv);
    run('migrate', nativeEnv);
    run('verify', nativeEnv);
    await assertClassifierHealthMigrated();
    const target = new ManagedWorkflowBackend(readWorkflowMigrationTargetConfig({ ...env, ...nativeEnv }), undefined, {
      migrationMode: 'verify',
    });
    try {
      await target.initialize();
      assert.equal((await target.readWorkflowMigrationSnapshot('fixture.rivet-project'))?.contents, liveContents);
      assert.equal(await target.readWorkflowRecordingArtifact(recordingId, 'recording'), recordingContents);
      const migrated = (await target.listWorkflowProjectWebApps('fixture.rivet-project')).project;
      assert.equal(migrated.settings.status, 'unpublished');
      assert.equal(migrated.settings.publicationStatus, 'unpublished_changes');
      assert.equal(migrated.settings.publishedWebApps.length, 1);
    } finally {
      await target.dispose();
    }
    console.log(
      'Live SQLite-to-managed migration: live draft, history, recording, operational rows, settings and runtime release verified.',
    );

    // Exercise the UI service with the serving selection installed, without
    // offline STOPPED acknowledgements or a legacy pre-copy. Real child
    // import/verify processes must transfer the live bytes and close the right gate.
    const nativeGate = new Pool(getManagedDbPoolConfig(readWorkflowMigrationTargetConfig({ ...env, ...nativeEnv })));
    try {
      await invalidateVmMigrationTargetGate(
        nativeGate,
        SqliteMigrationSource.identity(controlRoot, 'native-live', sourceRoots),
        migrationTargetIdentity(readWorkflowMigrationTargetConfig({ ...env, ...nativeEnv })),
      );
    } finally {
      await nativeGate.end();
    }
    await fs.rm(path.join(appDataRoot, 'vm-migration-maintenance.json'));
    await fs.rm(path.join(appDataRoot, 'vm-migration-job.json'), { force: true });
    await pool!.query('CREATE DATABASE rivet_ui_native_migration');
    const uiTargetEnv = {
      ...env,
      ...nativeEnv,
      RIVET_MIGRATION_TARGET_DATABASE_URL: `postgres://postgres@127.0.0.1:${databasePort}/rivet_ui_native_migration`,
      RIVET_MIGRATION_TARGET_S3_BUCKET: 'rivet-ui-native-migration-fixture',
    };
    const uiTarget = {
      databaseUrl: uiTargetEnv.RIVET_MIGRATION_TARGET_DATABASE_URL,
      databaseSslMode: env.RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE,
      bucket: uiTargetEnv.RIVET_MIGRATION_TARGET_S3_BUCKET,
      endpoint: env.RIVET_MIGRATION_TARGET_S3_ENDPOINT,
      region: env.RIVET_MIGRATION_TARGET_S3_REGION,
      prefix: env.RIVET_MIGRATION_TARGET_S3_PREFIX,
      forcePathStyle: true,
      accessKeyId: env.RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID,
      secretAccessKey: env.RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY,
      settingsEncryptionKey: env.RIVET_MIGRATION_TARGET_SETTINGS_ENCRYPTION_KEY,
      targetOffline: true,
      runtimePlatformCompatible: true,
    };
    const uiEnv = {
      RIVET_LOCAL_METADATA_CONTROL_ROOT: controlRoot,
      RIVET_LOCAL_METADATA_BOOT_REVISION: String(live.revision),
      RIVET_VM_MIGRATION_EDITOR_CONTROL: '1',
      RIVET_SERVER_UI_AUTH_MODE: 'key',
      RIVET_MIGRATION_SOURCE_STOPPED: '',
      RIVET_MIGRATION_SOURCE_QUIESCED: '',
    };
    const previousUiEnv = Object.fromEntries(Object.keys(uiEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, uiEnv);
    installLocalMetadataServingSelection({ ...paths, generationId: 'native-live', source: sourceRoots });
    try {
      const status = await getVmMigrationStatus();
      assert.equal(status.available, true);
      assert.equal(status.sourceKind, 'sqlite');
      assert.equal(status.precopyAvailable, false);
      const inventory = await getVmMigrationSourceInventory();
      assert.equal(inventory.recordingBundles, 1);
      assert.match(inventory.sourceDatabaseAuthority, /Selected live SQLite/);
      await assert.rejects(startVmMigrationPrecopy(uiTarget), /pre-copy is not needed/);
      await testVmMigrationDatabase(uiTarget);
      await testVmMigrationObjectStorage(uiTarget);
      await enterVmMigrationMode();
      await assert.rejects(leaveVmMigrationMaintenance(), /Migration recovery/);
      await assert.rejects(
        startVmMigration({ ...uiTarget, runtimePlatformCompatible: false }),
        /platform compatibility/,
      );
      await startVmMigration(uiTarget);
      const deadline = Date.now() + 120_000;
      let result;
      do {
        result = await getVmMigrationStatus();
        if (result.job?.phase === 'failed') throw new Error(result.job.message ?? 'UI SQLite migration failed');
        if (Date.now() > deadline) throw new Error('UI SQLite migration did not finish');
        if (result.job?.phase !== 'verified') await delay(100);
      } while (result.job?.phase !== 'verified');
      assert.equal(result.job.report?.recordings, 1);
      assert.equal(result.job.sourceIdentity, SqliteMigrationSource.identity(controlRoot, 'native-live', sourceRoots));
      const review = await reviewVmMigrationDeployment(uiTarget, {
        backupCompleted: true,
        deploymentSettingsMatch: true,
        functionalRehearsalPassed: true,
        externalDependenciesReviewed: true,
        rollbackWindowUnderstood: true,
      });
      assert.equal(review.phase, 'verifying');
      await assert.rejects(leaveVmMigrationMode(uiTarget), /state is changing/);
      await assert.rejects(
        reviewVmMigrationDeployment(uiTarget, {
          backupCompleted: true,
          deploymentSettingsMatch: true,
          functionalRehearsalPassed: true,
          externalDependenciesReviewed: true,
          rollbackWindowUnderstood: true,
        }),
        /state is changing/,
      );
      const reviewDeadline = Date.now() + 120_000;
      do {
        result = await getVmMigrationStatus();
        if (result.job?.phase === 'failed') throw new Error(result.job.message ?? 'UI SQLite review failed');
        if (Date.now() > reviewDeadline) throw new Error('UI SQLite review did not finish');
        if (result.job?.phase !== 'verified') await delay(100);
      } while (result.job?.phase !== 'verified');
      assert.ok(result.job.deploymentReview?.reviewedAt);
      const uiBackend = new ManagedWorkflowBackend(readWorkflowMigrationTargetConfig(uiTargetEnv), undefined, {
        migrationMode: 'verify',
      });
      try {
        await uiBackend.initialize();
        assert.equal((await uiBackend.readWorkflowMigrationSnapshot('fixture.rivet-project'))?.contents, liveContents);
        assert.equal(await uiBackend.readWorkflowRecordingArtifact(recordingId, 'recording'), recordingContents);
      } finally {
        await uiBackend.dispose();
      }
      await assert.rejects(leaveVmMigrationMode({ ...uiTarget, bucket: 'wrong-bucket' }), /Destination differs/);
      assert.equal(isVmMigrationMaintenanceActive(), true);
      await leaveVmMigrationMode(uiTarget);
      assert.equal(isVmMigrationMaintenanceActive(), false);
      const uiPool = new Pool(getManagedDbPoolConfig(readWorkflowMigrationTargetConfig(uiTargetEnv)));
      try {
        await assert.rejects(assertVmMigrationTargetMayServe(uiPool), /migration target is incomplete/i);
      } finally {
        await uiPool.end();
      }
      console.log('SQLite UI migration: inspection, pause/drain, real copy/verify, review and fenced recovery passed.');
    } finally {
      await disposeWorkflowStorage();
      for (const [key, value] of Object.entries(previousUiEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    sourceBackend.close();
    catalog.close();
    await sourceSettings.dispose();
    journal.close();
    for (const [key, value] of Object.entries(previousNativeRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally {
  await pool?.end().catch(() => undefined);
  for (const id of owned.reverse()) {
    try {
      docker('rm', '-f', id);
    } catch {
      /* Best-effort cleanup after the original error. */
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}
