import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { withArgv, withScopedEnv } from './helpers/runtime-library-harness.js';

const cleanup = await import('../runtime-libraries/managed/cleanup.js');
const managedSchema = await import('../runtime-libraries/managed/schema.js');
const managedState = await import('../runtime-libraries/managed/state.js');
const runtimeLibrariesConfig = await import('../runtime-libraries/config.js');
const bootstrapConfig = await import(new URL('../../../studio-server-bootstrap/config.mjs', import.meta.url).href) as {
  isManagedRuntimeLibrariesEnabled: () => boolean;
  shouldBootstrapManagedRuntimeLibrariesInCurrentProcess: () => boolean;
  getManagedRuntimeLibrariesConfig: () => Record<string, unknown>;
};
const deploymentStorageSettings = await import('../deployment-storage-settings.js');

const managedEnvKeys = [
  'RIVET_STORAGE_MODE',
  'RIVET_DATABASE_MODE',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_STORAGE_URL',
  'RIVET_STORAGE_BUCKET',
  'RIVET_STORAGE_REGION',
  'RIVET_STORAGE_ENDPOINT',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_STORAGE_PREFIX',
  'RIVET_STORAGE_FORCE_PATH_STYLE',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
  'RIVET_APP_DATA_ROOT',
  'RIVET_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
  'RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS',
  'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS',
  'RIVET_RUNTIME_PROCESS_ROLE',
  'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER',
  'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED',
] as const;

async function withManagedEnv(
  overrides: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  await withScopedEnv(managedEnvKeys, overrides, run);
}

type DeploymentSettingsDraft = Parameters<typeof deploymentStorageSettings.writeDeploymentStorageSettings>[0];

async function withDeploymentStorageSettings(
  settings: DeploymentSettingsDraft,
  overrides: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-runtime-settings-'));
  const appDataRoot = path.join(tempRoot, 'app-data');

  try {
    await withManagedEnv({
      ...overrides,
      RIVET_APP_DATA_ROOT: appDataRoot,
    }, async () => {
      await deploymentStorageSettings.writeDeploymentStorageSettings(settings);
      await run();
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function isoHoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1_000).toISOString();
}

test('API and bootstrap runtime-library config stay in parity for saved storage URL settings', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseSslMode: 'disable',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb?sslmode=disable',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '7000',
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
  }, () => {
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');
    assert.equal(bootstrapConfig.isManagedRuntimeLibrariesEnabled(), true);
    assert.deepEqual(
      bootstrapConfig.getManagedRuntimeLibrariesConfig(),
      runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
    );
  });
});

test('API and bootstrap runtime-library config stay in parity for saved local-docker settings', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'local-docker',
    storageUrl: 'http://workflow-minio:9000/rivet-artifacts',
    storageAccessKeyId: 'minioadmin',
    storageAccessKey: 'minioadmin',
  }, {
    RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '5000',
    RIVET_RUNTIME_PROCESS_ROLE: 'executor',
  }, () => {
    assert.deepEqual(
      bootstrapConfig.getManagedRuntimeLibrariesConfig(),
      runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
    );
  });
});

test('API and bootstrap runtime-library config stay in parity for saved deployment storage settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-runtime-settings-'));

  try {
    const appDataRoot = path.join(tempRoot, 'app-data');
    const settingsDir = path.join(appDataRoot, 'settings');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'deployment-storage.json'),
      JSON.stringify({
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'verify-full',
        databaseConnectionString: 'postgresql://saved-user:saved-pass@example-db:25060/defaultdb?sslmode=disable',
        storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
        storageAccessKeyId: 'saved-access-key-id',
        storageAccessKey: 'saved-secret-access-key',
      }),
      'utf8',
    );

    await withManagedEnv({
      RIVET_APP_DATA_ROOT: appDataRoot,
      RIVET_STORAGE_MODE: 'filesystem',
      RIVET_STORAGE_BUCKET: 'env-bucket',
      RIVET_STORAGE_ENDPOINT: 'https://env-storage.example.test',
      RIVET_STORAGE_ACCESS_KEY_ID: 'env-access-key-id',
      RIVET_STORAGE_ACCESS_KEY: 'env-secret-access-key',
      RIVET_STORAGE_BACKEND: 'filesystem',
      RIVET_DATABASE_CONNECTION_STRING: 'postgresql://env-user:env-pass@example-db:25060/defaultdb',
      RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '7000',
      RIVET_RUNTIME_PROCESS_ROLE: 'api',
    }, () => {
      assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');
      assert.equal(bootstrapConfig.isManagedRuntimeLibrariesEnabled(), true);
      assert.deepEqual(
        bootstrapConfig.getManagedRuntimeLibrariesConfig(),
        runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
      );
      assert.equal(runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig().objectStorageBucket, 'saved-bucket');
      assert.equal(runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig().objectStorageAccessKeyId, 'saved-access-key-id');
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('API and bootstrap runtime-library config stay aligned when storage mode is filesystem', async () => {
  await withManagedEnv({
    RIVET_STORAGE_MODE: 'filesystem',
  }, () => {
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'filesystem');
    assert.equal(runtimeLibrariesConfig.isManagedRuntimeLibrariesEnabled(), false);
    assert.equal(bootstrapConfig.isManagedRuntimeLibrariesEnabled(), false);
  });
});

test('runtime-library config rejects invalid explicit process roles', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'worker',
  }, () => {
    assert.throws(
      () => runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
      /RIVET_RUNTIME_PROCESS_ROLE/,
    );
    assert.throws(
      () => bootstrapConfig.getManagedRuntimeLibrariesConfig(),
      /RIVET_RUNTIME_PROCESS_ROLE/,
    );
  });
});

test('API and bootstrap runtime-library config keep explicit replica-tier and job-worker flags in parity', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
    RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: 'none',
    RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: 'false',
  }, () => {
    const apiConfig = runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig();
    const bootstrapManagedConfig = bootstrapConfig.getManagedRuntimeLibrariesConfig() as typeof apiConfig;

    assert.equal(apiConfig.runtimeReplicaTier, 'none');
    assert.equal(apiConfig.jobWorkerEnabled, false);
    assert.equal(bootstrapManagedConfig.runtimeReplicaTier, 'none');
    assert.equal(bootstrapManagedConfig.jobWorkerEnabled, false);
    assert.deepEqual(bootstrapManagedConfig, apiConfig);
  });
});

test('managed runtime-library schema init serializes DDL behind an advisory lock', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let released = false;
  const fakePool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as Pool;

  await managedSchema.ensureManagedRuntimeLibrariesSchema(fakePool);

  assert.equal(queries.length, 3);
  assert.equal(queries[0]?.sql, 'SELECT pg_advisory_lock($1::integer, $2::integer)');
  assert.equal(queries[1]?.sql, managedSchema.MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL);
  assert.equal(queries[2]?.sql, 'SELECT pg_advisory_unlock($1::integer, $2::integer)');
  assert.deepEqual(queries[0]?.params, queries[2]?.params);
  assert.equal(released, true);
});

test('managed runtime-library schema init preserves the schema error and still releases the advisory lock client', async () => {
  const schemaError = new Error('schema failed');
  const unlockError = new Error('unlock failed');
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  let released = false;
  let unlockAttempted = false;
  const fakePool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === managedSchema.MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL) {
          throw schemaError;
        }
        if (sql === 'SELECT pg_advisory_unlock($1::integer, $2::integer)') {
          unlockAttempted = true;
          throw unlockError;
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as Pool;

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await assert.rejects(
      managedSchema.ensureManagedRuntimeLibrariesSchema(fakePool),
      schemaError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(unlockAttempted, true);
  assert.equal(released, true);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] ?? ''), /Failed to release managed schema advisory lock/);
  assert.equal(warnings[0]?.[1], unlockError);
});

test('managed runtime-library config keeps long replica-status retention for local-docker and shortens it for managed environments', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'local-docker',
    storageUrl: 'http://workflow-minio:9000/rivet-artifacts',
    storageAccessKeyId: 'minioadmin',
    storageAccessKey: 'minioadmin',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
  }, () => {
    const config = runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig();
    assert.equal(config.replicaStatusRetentionMs, 24 * 60 * 60 * 1_000);
    assert.equal(config.replicaStatusCleanupIntervalMs, 15 * 60 * 1_000);
  });

  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
  }, () => {
    const config = runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig();
    assert.equal(config.replicaStatusRetentionMs, 15 * 60 * 1_000);
    assert.equal(config.replicaStatusCleanupIntervalMs, 5 * 60 * 1_000);
  });
});

test('runtime-library config falls back on non-positive interval overrides and stays in parity with bootstrap', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
    RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '0',
    RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS: '-1',
    RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS: '0',
  }, () => {
    const apiConfig = runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig();
    const bootstrapManagedConfig = bootstrapConfig.getManagedRuntimeLibrariesConfig() as typeof apiConfig;

    assert.equal(apiConfig.syncPollIntervalMs, 5_000);
    assert.equal(apiConfig.replicaStatusRetentionMs, 15 * 60 * 1_000);
    assert.equal(apiConfig.replicaStatusCleanupIntervalMs, 5 * 60 * 1_000);
    assert.deepEqual(bootstrapManagedConfig, apiConfig);
  });
});

test('bootstrap runtime-library sync skips dev supervisor processes and keeps the real runtime process', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
  }, async () => {
    await withArgv(['npm', 'run', 'dev'], () => {
      assert.equal(bootstrapConfig.shouldBootstrapManagedRuntimeLibrariesInCurrentProcess(), false);
    });

    await withArgv(['node', '/app/node_modules/.bin/tsx', 'watch', 'src/server.ts'], () => {
      assert.equal(bootstrapConfig.shouldBootstrapManagedRuntimeLibrariesInCurrentProcess(), false);
    });

    await withArgv([
      '/usr/local/bin/node',
      '--require',
      '/app/node_modules/tsx/dist/preflight.cjs',
      '--import',
      'file:///app/node_modules/tsx/dist/loader.mjs',
      'src/server.ts',
    ], () => {
      assert.equal(bootstrapConfig.shouldBootstrapManagedRuntimeLibrariesInCurrentProcess(), true);
    });
  });
});

test('bootstrap runtime-library sync keeps executor runtime processes', async () => {
  await withDeploymentStorageSettings({
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb',
    storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    storageAccessKeyId: 'spaces-access-key-id',
    storageAccessKey: 'spaces-secret-access-key',
  }, {
    RIVET_RUNTIME_PROCESS_ROLE: 'executor',
  }, async () => {
    await withArgv(['/usr/local/bin/node', 'executor-bundle.cjs', '--port', '21889'], () => {
      assert.equal(bootstrapConfig.shouldBootstrapManagedRuntimeLibrariesInCurrentProcess(), true);
    });
  });
});

test('managed runtime-library audit reports integrity issues and prune candidates correctly', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');
  const snapshot = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: isoDaysBefore(now, 1) },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: isoDaysBefore(now, 2) },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: isoDaysBefore(now, 10) },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: isoDaysBefore(now, 20) },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: isoDaysBefore(now, 30) },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: isoDaysBefore(now, 40) },
      { release_id: 'release-missing', packages_json: {}, artifact_blob_key: 'releases/release-missing/release.tar', artifact_sha256: 'sha-missing', created_at: isoDaysBefore(now, 50) },
      { release_id: 'release-inflight', packages_json: {}, artifact_blob_key: 'releases/release-inflight/release.tar', artifact_sha256: 'sha-inflight', created_at: isoDaysBefore(now, 90) },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: isoDaysBefore(now, 120) },
    ],
    jobs: [
      {
        job_id: 'job-running',
        type: 'install',
        status: 'running',
        packages_json: [],
        error: null,
        claimed_by: 'worker-1',
        created_at: isoDaysBefore(now, 1),
        started_at: isoDaysBefore(now, 1),
        finished_at: null,
        progress_at: isoDaysBefore(now, 0.1),
        cancel_requested_at: null,
        release_id: 'release-inflight',
      },
      {
        job_id: 'job-succeeded-recent',
        type: 'install',
        status: 'succeeded',
        packages_json: [],
        error: null,
        claimed_by: null,
        created_at: isoDaysBefore(now, 3),
        started_at: isoDaysBefore(now, 3),
        finished_at: isoDaysBefore(now, 3),
        progress_at: isoDaysBefore(now, 3),
        cancel_requested_at: null,
        release_id: 'release-10d',
      },
      {
        job_id: 'job-succeeded-old',
        type: 'remove',
        status: 'succeeded',
        packages_json: [],
        error: null,
        claimed_by: null,
        created_at: isoDaysBefore(now, 40),
        started_at: isoDaysBefore(now, 40),
        finished_at: isoDaysBefore(now, 40),
        progress_at: isoDaysBefore(now, 40),
        cancel_requested_at: null,
        release_id: 'release-40d',
      },
      {
        job_id: 'job-failed-recent',
        type: 'install',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: isoDaysBefore(now, 5),
        started_at: isoDaysBefore(now, 5),
        finished_at: isoDaysBefore(now, 5),
        progress_at: isoDaysBefore(now, 5),
        cancel_requested_at: null,
        release_id: null,
      },
      {
        job_id: 'job-failed-old',
        type: 'install',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: isoDaysBefore(now, 20),
        started_at: isoDaysBefore(now, 20),
        finished_at: isoDaysBefore(now, 20),
        progress_at: isoDaysBefore(now, 20),
        cancel_requested_at: null,
        release_id: null,
      },
    ],
    objects: [
      { key: 'releases/release-active/release.tar', size: 10, lastModified: isoDaysBefore(now, 1) },
      { key: 'releases/release-2d/release.tar', size: 10, lastModified: isoDaysBefore(now, 2) },
      { key: 'releases/release-10d/release.tar', size: 10, lastModified: isoDaysBefore(now, 10) },
      { key: 'releases/release-20d/release.tar', size: 10, lastModified: isoDaysBefore(now, 20) },
      { key: 'releases/release-30d/release.tar', size: 10, lastModified: isoDaysBefore(now, 30) },
      { key: 'releases/release-40d/release.tar', size: 10, lastModified: isoDaysBefore(now, 40) },
      { key: 'releases/release-inflight/release.tar', size: 10, lastModified: isoDaysBefore(now, 90) },
      { key: 'releases/release-prune/release.tar', size: 10, lastModified: isoDaysBefore(now, 120) },
      { key: 'orphaned/old.tar', size: 7, lastModified: isoDaysBefore(now, 3) },
      { key: 'orphaned/new.tar', size: 7, lastModified: isoHoursBefore(now, 1) },
    ],
  }, now);

  assert.equal(snapshot.activeReleaseId, 'release-active');
  assert.deepEqual(snapshot.releaseRowsMissingArtifacts.map((entry) => entry.releaseId), ['release-missing']);
  assert.deepEqual(snapshot.orphanedArtifacts.map((entry) => entry.key), ['orphaned/new.tar', 'orphaned/old.tar']);
  assert.deepEqual(snapshot.releasesReferencedByInFlightJobs, ['release-inflight']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateReleaseIds, ['release-prune']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateJobIds.sort(), ['job-failed-old', 'job-succeeded-old']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateOrphanedArtifactKeys, ['orphaned/old.tar']);
});

test('managed runtime-library prune dry run does not delete anything', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: '2025-12-01T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-prune/release.tar', size: 1, lastModified: '2025-12-01T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const deletes = { jobs: 0, releases: 0, objects: 0 };
  const result = await cleanup.pruneManagedRuntimeLibrariesState({
    apply: false,
    driver: {
      audit: async () => before,
      deleteJobs: async () => {
        deletes.jobs += 1;
        return 0;
      },
      deleteReleases: async () => {
        deletes.releases += 1;
        return 0;
      },
      deleteObjects: async () => {
        deletes.objects += 1;
        return 0;
      },
    },
  });

  assert.equal(result.deletedJobCount, 0);
  assert.equal(result.deletedReleaseCount, 0);
  assert.equal(result.deletedObjectCount, 0);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, before);
  assert.deepEqual(deletes, { jobs: 0, releases: 0, objects: 0 });
});

test('managed runtime-library prune apply deletes only plan candidates', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: '2026-04-03T00:00:00.000Z' },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: '2026-03-26T00:00:00.000Z' },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: '2026-03-16T00:00:00.000Z' },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: '2026-03-06T00:00:00.000Z' },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: '2026-02-24T00:00:00.000Z' },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: '2025-12-01T00:00:00.000Z' },
    ],
    jobs: [
      {
        job_id: 'job-prune',
        type: 'remove',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: '2026-03-01T00:00:00.000Z',
        started_at: '2026-03-01T00:00:00.000Z',
        finished_at: '2026-03-01T00:00:00.000Z',
        progress_at: '2026-03-01T00:00:00.000Z',
        cancel_requested_at: null,
        release_id: null,
      },
    ],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-2d/release.tar', size: 1, lastModified: '2026-04-03T00:00:00.000Z' },
      { key: 'releases/release-10d/release.tar', size: 1, lastModified: '2026-03-26T00:00:00.000Z' },
      { key: 'releases/release-20d/release.tar', size: 1, lastModified: '2026-03-16T00:00:00.000Z' },
      { key: 'releases/release-30d/release.tar', size: 1, lastModified: '2026-03-06T00:00:00.000Z' },
      { key: 'releases/release-40d/release.tar', size: 1, lastModified: '2026-02-24T00:00:00.000Z' },
      { key: 'releases/release-prune/release.tar', size: 1, lastModified: '2025-12-01T00:00:00.000Z' },
      { key: 'orphaned/old.tar', size: 1, lastModified: '2026-03-01T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const after = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: '2026-04-03T00:00:00.000Z' },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: '2026-03-26T00:00:00.000Z' },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: '2026-03-16T00:00:00.000Z' },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: '2026-03-06T00:00:00.000Z' },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: '2026-02-24T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-2d/release.tar', size: 1, lastModified: '2026-04-03T00:00:00.000Z' },
      { key: 'releases/release-10d/release.tar', size: 1, lastModified: '2026-03-26T00:00:00.000Z' },
      { key: 'releases/release-20d/release.tar', size: 1, lastModified: '2026-03-16T00:00:00.000Z' },
      { key: 'releases/release-30d/release.tar', size: 1, lastModified: '2026-03-06T00:00:00.000Z' },
      { key: 'releases/release-40d/release.tar', size: 1, lastModified: '2026-02-24T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const deleted = {
    jobs: [] as string[],
    releases: [] as string[],
    objects: [] as string[],
  };
  let auditCalls = 0;

  const result = await cleanup.pruneManagedRuntimeLibrariesState({
    apply: true,
    driver: {
      audit: async () => {
        auditCalls += 1;
        return auditCalls === 1 ? before : after;
      },
      deleteJobs: async (jobIds) => {
        deleted.jobs = [...jobIds];
        return jobIds.length;
      },
      deleteReleases: async (releaseIds) => {
        deleted.releases = [...releaseIds];
        return releaseIds.length;
      },
      deleteObjects: async (keys) => {
        deleted.objects = [...keys].sort();
        return keys.length;
      },
    },
  });

  assert.deepEqual(deleted.jobs, ['job-prune']);
  assert.deepEqual(deleted.releases, ['release-prune']);
  assert.deepEqual(deleted.objects, ['orphaned/old.tar', 'releases/release-prune/release.tar']);
  assert.equal(result.deletedJobCount, 1);
  assert.equal(result.deletedReleaseCount, 1);
  assert.equal(result.deletedObjectCount, 2);
  assert.equal(result.after.totalReleaseCount, 6);
});

test('managed runtime-library prune fails if retained releases still miss artifacts after apply', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [],
  }, new Date('2026-04-05T12:00:00.000Z'));

  await assert.rejects(
    cleanup.pruneManagedRuntimeLibrariesState({
      apply: true,
      driver: {
        audit: async () => before,
        deleteJobs: async () => 0,
        deleteReleases: async () => 0,
        deleteObjects: async () => 0,
      },
    }),
    /Retained release rows still reference missing artifacts/,
  );
});

test('managed runtime-library replica readiness excludes stale rows from the live denominator', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');
  const readiness = managedState.buildManagedRuntimeLibraryReplicaReadinessState(
    [
      {
        replica_id: 'api-ready',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-ready',
        hostname: 'api-ready',
        pod_name: 'api-ready',
        target_release_id: 'release-1',
        synced_release_id: 'release-1',
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:50.000Z',
        last_sync_completed_at: '2026-04-05T11:59:55.000Z',
        last_heartbeat_at: '2026-04-05T11:59:58.000Z',
        created_at: '2026-04-05T11:59:40.000Z',
        updated_at: '2026-04-05T11:59:58.000Z',
      },
      {
        replica_id: 'api-stale',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-stale',
        hostname: 'api-stale',
        pod_name: 'api-stale',
        target_release_id: 'release-1',
        synced_release_id: 'release-1',
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:58:00.000Z',
        last_sync_completed_at: '2026-04-05T11:58:05.000Z',
        last_heartbeat_at: '2026-04-05T11:58:10.000Z',
        created_at: '2026-04-05T11:58:00.000Z',
        updated_at: '2026-04-05T11:58:10.000Z',
      },
      {
        replica_id: 'executor-syncing',
        tier: 'editor',
        process_role: 'executor',
        display_name: 'executor-syncing',
        hostname: 'executor-syncing',
        pod_name: 'executor-syncing',
        target_release_id: 'release-1',
        synced_release_id: 'release-0',
        sync_state: 'syncing',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:56.000Z',
        last_sync_completed_at: null,
        last_heartbeat_at: '2026-04-05T11:59:59.000Z',
        created_at: '2026-04-05T11:59:56.000Z',
        updated_at: '2026-04-05T11:59:59.000Z',
      },
      {
        replica_id: 'executor-error',
        tier: 'editor',
        process_role: 'executor',
        display_name: 'executor-error',
        hostname: 'executor-error',
        pod_name: 'executor-error',
        target_release_id: 'release-1',
        synced_release_id: 'release-0',
        sync_state: 'error',
        last_error: 'checksum mismatch',
        last_sync_started_at: '2026-04-05T11:59:50.000Z',
        last_sync_completed_at: null,
        last_heartbeat_at: '2026-04-05T11:59:57.000Z',
        created_at: '2026-04-05T11:59:50.000Z',
        updated_at: '2026-04-05T11:59:57.000Z',
      },
    ],
    'release-1',
    30_000,
    now,
  );

  assert.equal(readiness.endpoint.liveReplicaCount, 1);
  assert.equal(readiness.endpoint.readyReplicaCount, 1);
  assert.equal(readiness.endpoint.staleReplicaCount, 1);
  assert.equal(readiness.editor.liveReplicaCount, 2);
  assert.equal(readiness.editor.readyReplicaCount, 0);
  assert.equal(readiness.editor.staleReplicaCount, 0);
  assert.deepEqual(readiness.editor.replicas.map((replica) => replica.replicaId), ['executor-error', 'executor-syncing']);
});

test('managed runtime-library replica readiness collapses duplicate rows for the same logical replica identity', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');
  const readiness = managedState.buildManagedRuntimeLibraryReplicaReadinessState(
    [
      {
        replica_id: 'api-newest',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-dev-container',
        hostname: 'api-dev-container',
        pod_name: 'api-dev-container',
        target_release_id: 'release-1',
        synced_release_id: 'release-1',
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:56.000Z',
        last_sync_completed_at: '2026-04-05T11:59:58.000Z',
        last_heartbeat_at: '2026-04-05T11:59:59.000Z',
        created_at: '2026-04-05T11:59:55.000Z',
        updated_at: '2026-04-05T11:59:59.000Z',
      },
      {
        replica_id: 'api-older-live',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-dev-container',
        hostname: 'api-dev-container',
        pod_name: 'api-dev-container',
        target_release_id: 'release-1',
        synced_release_id: 'release-0',
        sync_state: 'syncing',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:50.000Z',
        last_sync_completed_at: null,
        last_heartbeat_at: '2026-04-05T11:59:57.000Z',
        created_at: '2026-04-05T11:59:49.000Z',
        updated_at: '2026-04-05T11:59:57.000Z',
      },
      {
        replica_id: 'api-older-stale',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-dev-container',
        hostname: 'api-dev-container',
        pod_name: 'api-dev-container',
        target_release_id: 'release-0',
        synced_release_id: 'release-0',
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:58:00.000Z',
        last_sync_completed_at: '2026-04-05T11:58:05.000Z',
        last_heartbeat_at: '2026-04-05T11:58:10.000Z',
        created_at: '2026-04-05T11:58:00.000Z',
        updated_at: '2026-04-05T11:58:10.000Z',
      },
      {
        replica_id: 'executor-1',
        tier: 'editor',
        process_role: 'executor',
        display_name: 'executor-1',
        hostname: 'executor-1',
        pod_name: 'executor-1',
        target_release_id: 'release-1',
        synced_release_id: 'release-1',
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:56.000Z',
        last_sync_completed_at: '2026-04-05T11:59:58.000Z',
        last_heartbeat_at: '2026-04-05T11:59:59.000Z',
        created_at: '2026-04-05T11:59:55.000Z',
        updated_at: '2026-04-05T11:59:59.000Z',
      },
    ],
    'release-1',
    30_000,
    now,
  );

  assert.equal(readiness.endpoint.liveReplicaCount, 1);
  assert.equal(readiness.endpoint.readyReplicaCount, 1);
  assert.equal(readiness.endpoint.staleReplicaCount, 0);
  assert.deepEqual(readiness.endpoint.replicas.map((replica) => replica.replicaId), ['api-newest']);
  assert.equal(readiness.editor.liveReplicaCount, 1);
});

test('managed runtime-library replica readiness treats null active release as converged empty state', () => {
  const readiness = managedState.buildManagedRuntimeLibraryReplicaReadinessState(
    [
      {
        replica_id: 'api-empty',
        tier: 'endpoint',
        process_role: 'api',
        display_name: 'api-empty',
        hostname: 'api-empty',
        pod_name: null,
        target_release_id: null,
        synced_release_id: null,
        sync_state: 'ready',
        last_error: null,
        last_sync_started_at: '2026-04-05T11:59:50.000Z',
        last_sync_completed_at: '2026-04-05T11:59:55.000Z',
        last_heartbeat_at: '2026-04-05T11:59:59.000Z',
        created_at: '2026-04-05T11:59:50.000Z',
        updated_at: '2026-04-05T11:59:59.000Z',
      },
    ],
    null,
    30_000,
    new Date('2026-04-05T12:00:00.000Z'),
  );

  assert.equal(readiness.endpoint.readyReplicaCount, 1);
  assert.equal(readiness.endpoint.replicas[0]?.isReadyForActiveRelease, true);
});
