import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectSourceAppSettings } from '../scripts/migrate-app-settings.js';
import { readWorkflowMigrationTargetConfig } from '../scripts/migrate-workflow-storage-lib.js';

const target = readWorkflowMigrationTargetConfig({
  RIVET_MIGRATION_TARGET_DATABASE_URL: 'postgresql://target:password@localhost/target',
  RIVET_MIGRATION_TARGET_DATABASE_SSL_MODE: 'disable',
  RIVET_MIGRATION_TARGET_S3_BUCKET: 'target',
  RIVET_MIGRATION_TARGET_S3_ENDPOINT: 'http://localhost:9000',
  RIVET_MIGRATION_TARGET_S3_REGION: 'us-east-1',
  RIVET_MIGRATION_TARGET_S3_PREFIX: 'migration/workflows/',
  RIVET_MIGRATION_TARGET_S3_FORCE_PATH_STYLE: 'true',
  RIVET_MIGRATION_TARGET_S3_ACCESS_KEY_ID: 'access',
  RIVET_MIGRATION_TARGET_S3_SECRET_ACCESS_KEY: 'secret',
});

test('App Settings migration keeps legacy public routes and targets a separate managed location', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'settings'));
  await fs.writeFile(
    path.join(root, 'settings', 'web-app-routes.json'),
    JSON.stringify({
      publishedAppsBasePath: '/stories',
      latestAppsBasePath: '/stories-latest',
    }),
  );

  const rows = await collectSourceAppSettings(root, target);
  const storage = rows.find((row) => row.key === 'deployment storage')?.value;
  const routes = rows.find((row) => row.key === 'public route')?.value;
  assert.equal(storage?.storageMode, 'managed');
  assert.equal(storage?.databaseMode, 'managed');
  assert.equal(storage?.objectStoragePrefix, 'migration/workflows/');
  assert.equal(routes?.publishedAppsBasePath, '/stories');
  assert.equal(routes?.latestAppsBasePath, '/stories-latest');
  assert.ok(rows.find((row) => row.key === 'public route')?.sourceHash);
});

test('App Settings migration rejects unknown and malformed source domains', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'settings'));
  const unknownPath = path.join(root, 'settings', 'unmapped.json');
  await fs.writeFile(unknownPath, '{}');
  await assert.rejects(collectSourceAppSettings(root, target), /Unrecognized source App Settings file/);
  await fs.rm(unknownPath);
  const unknownBackup = path.join(root, 'settings', 'unmapped.backup');
  await fs.writeFile(unknownBackup, 'unreviewed source');
  await assert.rejects(collectSourceAppSettings(root, target), /Unrecognized source App Settings file/);
  await fs.rm(unknownBackup);
  await fs.writeFile(path.join(root, 'settings', 'deployment-storage.json'), '{not json');
  await assert.rejects(collectSourceAppSettings(root, target));
  await fs.rm(path.join(root, 'settings', 'deployment-storage.json'));
  await fs.mkdir(path.join(root, 'settings', 'web-app-routes.json'));
  await assert.rejects(collectSourceAppSettings(root, target), /must be a regular file/);
});

test('App Settings migration refuses a source already configured for managed storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-migration-managed-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'settings'));
  const managed = (await collectSourceAppSettings(root, target)).find((row) => row.key === 'deployment storage');
  assert.ok(managed);
  await fs.writeFile(path.join(root, 'settings', 'deployment-storage.json'), JSON.stringify(managed.value));
  await assert.rejects(collectSourceAppSettings(root, target), /requires a filesystem source/);
});
