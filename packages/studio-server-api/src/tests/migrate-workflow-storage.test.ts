import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import * as tar from 'tar';

import {
  fingerprintWorkflowMigrationState,
  readWorkflowMigrationTargetConfig,
  verifyMigrationState,
} from '../scripts/migrate-workflow-storage-lib.js';
import { migrationTargetIdentity } from '../vm-migration-target-gate.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { createSourceArchive, readSourceManifest } from '../scripts/migrate-runtime-libraries.js';

test('frozen VM source manifest detects owned-file drift but ignores the migration job marker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-manifest-'));
  const roots = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'runtime-libraries'),
  };
  try {
    for (const directory of Object.values(roots)) await fs.mkdir(directory);
    await fs.mkdir(path.join(roots.appData, 'settings'));
    await fs.writeFile(path.join(roots.workflows, 'draft.rivet-project'), 'draft A');
    const initial = await fingerprintVmMigrationSource(roots);
    await fs.writeFile(path.join(roots.appData, 'vm-migration-job.json'), '{"phase":"verifying"}');
    assert.equal(await fingerprintVmMigrationSource(roots), initial);
    await fs.writeFile(path.join(roots.workflows, 'draft.rivet-project.wrapper-stats.json'), '{"derived":true}');
    assert.equal(await fingerprintVmMigrationSource(roots), initial);
    await fs.writeFile(path.join(roots.workflows, 'draft.rivet-project'), 'draft B');
    assert.notEqual(await fingerprintVmMigrationSource(roots), initial);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library source fingerprint accepts internal npm links but rejects escaping links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-links-'));
  const roots = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'runtime-libraries'),
  };
  try {
    for (const directory of Object.values(roots)) await fs.mkdir(directory);
    await fs.mkdir(path.join(roots.appData, 'settings'));
    const bin = path.join(roots.runtimeLibraries, 'node_modules', '.bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'command.js'), 'first');
    try {
      await fs.symlink('command.js', path.join(bin, 'command'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    const first = await fingerprintVmMigrationSource(roots);
    await fs.writeFile(path.join(bin, 'command.js'), 'second');
    assert.notEqual(await fingerprintVmMigrationSource(roots), first);
    await fs.symlink(path.join(root, 'outside'), path.join(bin, 'escaping'), 'file');
    await fs.writeFile(path.join(root, 'outside'), 'outside');
    await assert.rejects(fingerprintVmMigrationSource(roots), /escapes its root/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library archive rejects links to unarchived siblings even inside the overall source root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-archive-boundary-'));
  try {
    const modules = path.join(root, 'current', 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    await fs.writeFile(path.join(root, 'current', 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'shared.js'), 'module.exports = 1;');
    try {
      await fs.symlink('../../shared.js', path.join(modules, 'linked.js'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    await assert.rejects(createSourceArchive(root), /escapes.*archived release/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library archive remains loadable after relocation with internal npm links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-archive-relocate-'));
  try {
    const source = path.join(root, 'source');
    const packageRoot = path.join(source, 'current', 'node_modules', 'example');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(source, 'current', 'package.json'), '{}');
    await fs.writeFile(path.join(packageRoot, 'value.cjs'), 'module.exports = 42;', { mode: 0o755 });
    try {
      await fs.symlink('value.cjs', path.join(packageRoot, 'index.js'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    const archivePath = path.join(root, 'release.tar');
    await fs.writeFile(archivePath, await createSourceArchive(source));
    const destination = path.join(root, 'destination');
    await fs.mkdir(destination);
    await tar.x({ file: archivePath, cwd: destination, strict: true });
    await fs.rm(source, { recursive: true, force: true });
    assert.equal(createRequire(import.meta.url)(path.join(destination, 'node_modules', 'example', 'index.js')), 42);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(destination, 'node_modules', 'example', 'value.cjs'))).mode & 0o777, 0o755);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library source inspection rejects a dangling legacy release instead of treating it as empty', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-legacy-link-'));
  try {
    try {
      await fs.symlink('missing-release', path.join(root, 'active-release'), 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    await assert.rejects(readSourceManifest(root), /legacy active-release/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library fingerprint includes permissions that the portable archive preserves', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Executable permission changes require a POSIX filesystem');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-mode-'));
  const roots = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'runtime-libraries'),
  };
  try {
    for (const directory of Object.values(roots)) await fs.mkdir(directory);
    const script = path.join(roots.runtimeLibraries, 'command');
    await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const initial = await fingerprintVmMigrationSource(roots);
    await fs.chmod(script, 0o755);
    assert.notEqual(await fingerprintVmMigrationSource(roots), initial);
    const executable = await fingerprintVmMigrationSource(roots);
    await fs.chmod(roots.runtimeLibraries, 0o750);
    assert.notEqual(await fingerprintVmMigrationSource(roots), executable);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library source roots cannot be symlinks that hide installed-file drift', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-root-link-'));
  const actualRoot = path.join(root, 'actual');
  const linkedRoot = path.join(root, 'linked');
  try {
    await fs.mkdir(actualRoot);
    try {
      await fs.symlink('actual', linkedRoot, 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    const roots = {
      workflows: path.join(root, 'workflows'),
      recordings: path.join(root, 'recordings'),
      appData: path.join(root, 'app-data'),
      runtimeLibraries: linkedRoot,
    };
    await assert.rejects(fingerprintVmMigrationSource(roots), /source contains a symlink/);
    await assert.rejects(readSourceManifest(linkedRoot), /must be a real directory/);
    await assert.rejects(createSourceArchive(linkedRoot), /must be a real directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime-library inspection does not interpret denied source access as an empty installation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-access-denied-'));
  const originalStat = fs.lstat.bind(fs);
  const intercepted = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === path.join(root, 'active-release')) {
      throw Object.assign(new Error('test source access denied'), { code: 'EACCES' });
    }
    return originalStat(...args);
  });
  try {
    await assert.rejects(readSourceManifest(root), { code: 'EACCES' });
  } finally {
    intercepted.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration target is configured independently from active filesystem storage', () => {
  const config = readWorkflowMigrationTargetConfig({
    RIVET_MIGRATION_TARGET_DATABASE_URL: 'postgresql://target:secret@db.example/migration?sslmode=require',
    RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: 'verify-full',
    RIVET_MIGRATION_TARGET_S3_BUCKET: 'target',
    RIVET_MIGRATION_TARGET_S3_ENDPOINT: 'https://s3.example',
    RIVET_MIGRATION_TARGET_S3_REGION: 'ru-central1',
    RIVET_MIGRATION_TARGET_S3_PREFIX: 'tenant-a/workflows/',
    RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: 'true',
    RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: 'key',
    RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: 'secret',
  });
  assert.equal(config.databaseUrl, 'postgresql://target:secret@db.example/migration');
  assert.equal(config.objectStoragePrefix, 'tenant-a/workflows/');
  assert.equal(config.objectStorageRegion, 'ru-central1');
  assert.equal(config.databaseSslMode, 'verify-full');
  assert.equal(
    migrationTargetIdentity(config),
    migrationTargetIdentity({
      ...config,
      databaseUrl: 'postgresql://other-user:rotated@db.example/migration',
      objectStorageSecretAccessKey: 'rotated',
    }),
  );
  assert.notEqual(
    migrationTargetIdentity(config),
    migrationTargetIdentity({ ...config, objectStorageBucket: 'other' }),
  );
  assert.throws(() => readWorkflowMigrationTargetConfig({}), /RIVET_MIGRATION_TARGET_DATABASE_URL/);
  const malformedSecretUrl = 'postgresql://target:password-must-not-log@[';
  assert.throws(
    () => readWorkflowMigrationTargetConfig({ RIVET_MIGRATION_TARGET_DATABASE_URL: malformedSecretUrl }),
    (error: unknown) => {
      assert.match(String(error), /valid PostgreSQL URL/);
      assert.equal(String(error).includes('password-must-not-log'), false);
      assert.equal((error as { input?: string }).input, undefined);
      return true;
    },
  );
  for (const url of ['postgresql:db-name', 'postgresql://target:secret@db.example']) {
    assert.throws(
      () => readWorkflowMigrationTargetConfig({ RIVET_MIGRATION_TARGET_DATABASE_URL: url }),
      /must name a host and database/,
    );
  }
  assert.throws(
    () =>
      readWorkflowMigrationTargetConfig({
        RIVET_MIGRATION_TARGET_DATABASE_URL: 'postgresql://target@db.example/migration',
        RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: 'disable',
        RIVET_MIGRATION_TARGET_S3_BUCKET: 'target',
        RIVET_MIGRATION_TARGET_S3_REGION: 'ru-central1',
        RIVET_MIGRATION_TARGET_S3_PREFIX: '../workflows/',
        RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: 'true',
        RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: 'key',
        RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: 'secret',
      }),
    /prefix/,
  );
});

test('migration fingerprint includes historical publication bytes and access policy', () => {
  const state = {
    workflowId: 'p1',
    relativePath: 'p1.rivet-project',
    name: 'p1',
    fileName: 'p1.rivet-project',
    updatedAt: '2026-04-07T12:00:00.000Z',
    contents: '{}',
    datasetsContents: null,
    endpointName: 'p1',
    endpointAccess: 'internal' as const,
    publicationVersion: '3',
    publishedEndpointName: 'p1',
    publishedVersionId: 'v1',
    lastPublishedAt: '2026-04-07T12:00:00.000Z',
    publishedContents: '{}',
    publishedDatasetsContents: null,
    publishedWebApps: [],
    publishedVersions: [
      {
        versionId: 'v1',
        endpointName: 'p1',
        publishedAt: '2026-04-07T12:00:00.000Z',
        isStarred: false,
        comment: '',
        contents: '{}',
        datasetsContents: null,
      },
    ],
  };
  assert.notEqual(
    fingerprintWorkflowMigrationState(state),
    fingerprintWorkflowMigrationState({ ...state, endpointAccess: 'public' }),
  );
  assert.notEqual(
    fingerprintWorkflowMigrationState(state),
    fingerprintWorkflowMigrationState({
      ...state,
      publishedVersions: [{ ...state.publishedVersions[0]!, contents: '{"other":true}' }],
    }),
  );
});

test('verifyMigrationState accepts only matching folders, projects, and recording summaries', () => {
  const summary = verifyMigrationState({
    sourceFolderPaths: ['alpha', 'alpha/nested'],
    targetFolderPaths: ['alpha', 'alpha/nested'],
    sourceProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'hello-world',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
    ],
    targetProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'hello-world',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
    ],
    sourceRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 2,
        failedRuns: 1,
        suspiciousRuns: 0,
        latestRunAt: '2026-04-07T13:00:00.000Z',
      },
    ],
    targetRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 2,
        failedRuns: 1,
        suspiciousRuns: 0,
        latestRunAt: '2026-04-07T13:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(summary, {
    sourceProjectCount: 1,
    targetProjectCount: 1,
    sourceFolderCount: 2,
    targetFolderCount: 2,
    sourceRecordingWorkflowCount: 1,
    targetRecordingWorkflowCount: 1,
  });
});

test('verifyMigrationState reports missing folders, mismatched projects, and regressed recording summaries', () => {
  assert.throws(
    () =>
      verifyMigrationState({
        sourceFolderPaths: ['alpha', 'alpha/nested'],
        targetFolderPaths: ['alpha'],
        sourceProjectState: [],
        targetProjectState: [],
        sourceRecordingState: [],
        targetRecordingState: [],
      }),
    /Managed workflow folder is missing: alpha\/nested/,
  );

  assert.throws(
    () =>
      verifyMigrationState({
        sourceFolderPaths: ['alpha'],
        targetFolderPaths: ['alpha'],
        sourceProjectState: [
          {
            relativePath: 'alpha/hello.rivet-project',
            endpointName: 'hello-world',
            lastPublishedAt: '2026-04-07T12:00:00.000Z',
            status: 'published',
          },
        ],
        targetProjectState: [
          {
            relativePath: 'alpha/hello.rivet-project',
            endpointName: 'different-endpoint',
            lastPublishedAt: '2026-04-07T12:00:00.000Z',
            status: 'published',
          },
        ],
        sourceRecordingState: [],
        targetRecordingState: [],
      }),
    /Managed workflow mismatch for alpha\/hello\.rivet-project/,
  );

  assert.throws(
    () =>
      verifyMigrationState({
        sourceFolderPaths: ['alpha'],
        targetFolderPaths: ['alpha'],
        sourceProjectState: [],
        targetProjectState: [],
        sourceRecordingState: [
          {
            relativePath: 'alpha/hello.rivet-project',
            totalRuns: 2,
            failedRuns: 1,
            suspiciousRuns: 1,
            latestRunAt: '2026-04-07T13:00:00.000Z',
          },
        ],
        targetRecordingState: [
          {
            relativePath: 'alpha/hello.rivet-project',
            totalRuns: 1,
            failedRuns: 1,
            suspiciousRuns: 1,
            latestRunAt: '2026-04-07T12:00:00.000Z',
          },
        ],
      }),
    /Managed recording count differs for alpha\/hello\.rivet-project/,
  );
});

test('verifyMigrationState rejects unexpected target data', () => {
  const empty = {
    sourceFolderPaths: [],
    sourceProjectState: [],
    sourceRecordingState: [],
    targetRecordingState: [],
  };
  assert.throws(
    () => verifyMigrationState({ ...empty, targetFolderPaths: ['extra'], targetProjectState: [] }),
    /Unexpected managed workflow folder: extra/,
  );
  assert.throws(
    () =>
      verifyMigrationState({
        ...empty,
        targetFolderPaths: [],
        targetProjectState: [
          {
            relativePath: 'extra.rivet-project',
            endpointName: '',
            lastPublishedAt: null,
            status: 'unpublished',
          },
        ],
      }),
    /Unexpected managed workflow: extra\.rivet-project/,
  );
  assert.throws(
    () =>
      verifyMigrationState({
        ...empty,
        targetFolderPaths: [],
        targetProjectState: [],
        targetRecordingState: [
          {
            relativePath: 'extra.rivet-project',
            totalRuns: 1,
            failedRuns: 0,
            suspiciousRuns: 0,
            latestRunAt: null,
          },
        ],
      }),
    /Unexpected managed recording summary: extra\.rivet-project/,
  );
});
