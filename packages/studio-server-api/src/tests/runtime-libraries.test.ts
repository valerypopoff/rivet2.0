import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-libraries-'));
const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-libraries-app-data-'));
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;

const manifest = await import('../runtime-libraries/manifest.js');
const startup = await import('../runtime-libraries/startup.js');
const filesystemBackend = await import('../runtime-libraries/filesystem-backend.js');
const runtimeLibrariesConfig = await import('../runtime-libraries/config.js');
const deploymentStorageSettings = await import('../deployment-storage-settings.js');
const { jobRunner } = await import('../runtime-libraries/job-runner.js');

async function resetRuntimeLibrariesRoot() {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeLibrariesRoot, { recursive: true });
  await fs.rm(appDataRoot, { recursive: true, force: true });
  await fs.mkdir(appDataRoot, { recursive: true });
}

test.beforeEach(async () => {
  await resetRuntimeLibrariesRoot();
});

test('readManifest normalizes invalid manifest content', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({
      packages: {
        valid: { name: 'wrong-name', version: '^1.0.0', installedAt: '2026-01-01T00:00:00.000Z' },
        missingVersion: { name: 'missingVersion' },
        arrayEntry: [],
      },
      updatedAt: '2026-02-02T00:00:00.000Z',
      activeReleaseId: 'release-123',
    }),
    'utf8',
  );

  assert.deepEqual(manifest.readManifest(), {
    packages: {
      valid: {
        name: 'valid',
        version: '^1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-02-02T00:00:00.000Z',
    activeReleaseId: 'release-123',
  });
});

test('reconcileRuntimeLibraries clears stale manifest state when no active runtime set exists', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({
      packages: {
        lodash: {
          name: 'lodash',
          version: '^4.17.21',
          installedAt: '2026-03-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
    'utf8',
  );

  await startup.reconcileRuntimeLibraries();

  assert.deepEqual(manifest.readManifest().packages, {});
});

test('reconcileRuntimeLibraries preserves manifest when active runtime set exists', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const packages = {
    lodash: {
      name: 'lodash',
      version: '^4.17.21',
      installedAt: '2026-03-01T00:00:00.000Z',
    },
  };

  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({ packages, updatedAt: '2026-03-01T00:00:00.000Z' }),
    'utf8',
  );

  await startup.reconcileRuntimeLibraries();

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, packages);
});

test('readManifest returns empty manifest when file does not exist', () => {
  const result = manifest.readManifest();
  assert.deepEqual(result.packages, {});
  assert.ok(result.updatedAt);
});

test('readManifest returns empty manifest when file contains invalid JSON', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    'not-json',
    'utf8',
  );

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, {});
});

test('writeManifest writes atomically and can be read back', () => {
  manifest.ensureDirectories();
  const packages = {
    express: { name: 'express', version: '^4.18.0', installedAt: '2026-01-01T00:00:00.000Z' },
  };

  manifest.writeManifest({ packages, updatedAt: '', activeReleaseId: 'release-456' });

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, packages);
  assert.equal(result.activeReleaseId, 'release-456');
  assert.ok(result.updatedAt, 'updatedAt should be set by writeManifest');
});

test('writeManifest recreates missing runtime-library directories before writing', async () => {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });

  manifest.writeManifest({
    packages: {},
    updatedAt: '',
    activeReleaseId: 'release-recreated',
  });

  const result = manifest.readManifest();
  assert.equal(result.activeReleaseId, 'release-recreated');
  const rootStat = await fs.stat(runtimeLibrariesRoot);
  assert.ok(rootStat.isDirectory());
});

test('normalizeManifest strips entries with empty version strings', () => {
  const result = manifest.normalizeManifest({
    packages: {
      good: { version: '1.0.0' },
      bad: { version: '' },
    },
  });

  assert.ok(result.packages.good);
  assert.equal(result.packages.bad, undefined);
});

test('ensureDirectories creates root and staging dirs', async () => {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
  manifest.ensureDirectories();

  const rootStat = await fs.stat(runtimeLibrariesRoot);
  const stagingStat = await fs.stat(path.join(runtimeLibrariesRoot, 'staging'));
  assert.ok(rootStat.isDirectory());
  assert.ok(stagingStat.isDirectory());
});

test('currentNodeModulesPath returns null when no current directory exists', () => {
  assert.equal(manifest.currentNodeModulesPath(), null);
});

test('currentNodeModulesPath returns path when node_modules exists', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const result = manifest.currentNodeModulesPath();
  assert.ok(result);
  assert.ok(result.endsWith('node_modules'));
});

test('filesystem backend reports no active libraries for an empty active release', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const backend = filesystemBackend.createFilesystemRuntimeLibrariesBackend();
  const state = await backend.getState();

  assert.equal(state.hasActiveLibraries, false);
  assert.deepEqual(state.packages, {});
  assert.equal(state.replicaReadiness, null);
});

test('filesystem backend exposes a permission error when runtime-library storage is not writable', async (t) => {
  const backend = filesystemBackend.createFilesystemRuntimeLibrariesBackend();
  const normalizedRoot = runtimeLibrariesRoot.replace(/\\/g, '/');

  t.mock.method(fsSync, 'mkdirSync', (targetPath: fsSync.PathLike) => {
    const normalizedTargetPath = String(targetPath).replace(/\\/g, '/');
    if (normalizedTargetPath.startsWith(normalizedRoot)) {
      const error = new Error(`EACCES: permission denied, mkdir '${targetPath}'`) as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    }

    return undefined;
  });

  await assert.rejects(
    backend.getState(),
    (error: Error & { status?: number; expose?: boolean }) => {
      assert.equal(error.status, 500);
      assert.equal(error.expose, true);
      assert.equal(
        error.message,
        `Runtime-library storage is not writable. Check server permissions for ${normalizedRoot}.`,
      );
      return true;
    },
  );
});

test('filesystem backend hides finished jobs from modal state but keeps them addressable by job id', async () => {
  const backend = filesystemBackend.createFilesystemRuntimeLibrariesBackend();
  const finishedJob = jobRunner.startRemove(['left-pad']);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const currentJob = jobRunner.getJob(finishedJob.id);
    if (currentJob?.status === 'succeeded' || currentJob?.status === 'failed') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const state = await backend.getState();
  assert.equal(state.backend, 'filesystem');
  assert.equal(state.activeJob, null);

  const job = await backend.getJob(finishedJob.id);
  assert.ok(job);
  assert.equal(job.id, finishedJob.id);
  assert.equal(job.status, 'succeeded');
  assert.ok(job.logEntries.length > 0);
});

test('runtime-library mode follows deployment storage app settings', async () => {
  const originalStorageMode = process.env.RIVET_STORAGE_MODE;

  try {
    process.env.RIVET_STORAGE_MODE = 'managed';
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'filesystem');

    await deploymentStorageSettings.writeDeploymentStorageSettings({
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://db-user:db-pass@example-db:5432/rivet',
      storageUrl: 'https://saved-bucket.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'saved-key-id',
      storageAccessKey: 'saved-secret',
    });
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');

    delete process.env.RIVET_STORAGE_MODE;
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');
  } finally {
    if (originalStorageMode === undefined) {
      delete process.env.RIVET_STORAGE_MODE;
    } else {
      process.env.RIVET_STORAGE_MODE = originalStorageMode;
    }
  }
});

test('runtime-library config rejects retired runtime-library alias env names', () => {
  const originalSyncPollInterval = process.env.RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS;

  try {
    process.env.RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS = '1000';
    assert.throws(
      () => runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(),
      /Retired environment variable/,
    );
  } finally {
    if (originalSyncPollInterval === undefined) {
      delete process.env.RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS;
    } else {
      process.env.RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS = originalSyncPollInterval;
    }
  }
});
