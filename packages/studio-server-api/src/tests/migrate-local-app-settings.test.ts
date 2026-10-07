import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { runtimeLimitSettingsRepository } from '../runtime-limit-settings.js';
import { migrateLocalAppSettings } from '../scripts/migrate-local-app-settings.js';

test('local App Settings candidate import is idempotent and verifies every domain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-settings-import-'));
  const sourceRoot = path.join(root, 'source');
  const databasePath = path.join(root, 'candidate', 'metadata.sqlite');
  const options = { sourceRoot, databasePath };
  try {
    await fs.mkdir(sourceRoot);
    const imported = await migrateLocalAppSettings(options);
    assert.ok(imported > 0);
    const beforeVerification = await fs.stat(databasePath);
    assert.equal(await migrateLocalAppSettings({ ...options, verifyOnly: true }), imported);
    const afterVerification = await fs.stat(databasePath);
    assert.deepEqual(
      { size: afterVerification.size, mtimeMs: afterVerification.mtimeMs, ctimeMs: afterVerification.ctimeMs },
      { size: beforeVerification.size, mtimeMs: beforeVerification.mtimeMs, ctimeMs: beforeVerification.ctimeMs },
    );
    assert.equal(await migrateLocalAppSettings(options), imported);
    await assert.rejects(fs.stat(path.join(sourceRoot, 'settings')), { code: 'ENOENT' });

    const candidate = new SqliteAppSettingsBackend({ databasePath });
    try {
      await candidate.initialize();
      const record = await candidate.read('environment variable');
      assert.ok(record);
      await candidate.write({
        key: 'environment variable',
        expectedRevision: record.revision,
        schemaVersion: record.schemaVersion,
        value: record.value,
        sourceHash: record.sourceHash,
      });
    } finally {
      await candidate.dispose();
    }
    await assert.rejects(migrateLocalAppSettings({ ...options, verifyOnly: true }), /differs from the source/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('local App Settings candidate import rejects unknown settings files before creating a database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-settings-import-'));
  const sourceRoot = path.join(root, 'source');
  const databasePath = path.join(root, 'candidate', 'metadata.sqlite');
  try {
    await fs.mkdir(path.join(sourceRoot, 'settings'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'settings', 'unknown.json'), '{}');
    await assert.rejects(
      migrateLocalAppSettings({ sourceRoot, databasePath, encryptionKey: 'candidate-secret' }),
      /Unrecognized source App Settings file/,
    );
    await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
    await fs.rm(path.join(sourceRoot, 'settings', 'unknown.json'));
    await fs.writeFile(path.join(sourceRoot, 'settings', 'unknown.backup'), 'possibly authoritative');
    await assert.rejects(
      migrateLocalAppSettings({ sourceRoot, databasePath, encryptionKey: 'candidate-secret' }),
      /Unrecognized source App Settings file/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local App Settings verify-only never creates a missing candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-settings-import-'));
  const sourceRoot = path.join(root, 'source');
  const databasePath = path.join(root, 'candidate', 'metadata.sqlite');
  try {
    await fs.mkdir(sourceRoot);
    await assert.rejects(
      migrateLocalAppSettings({ sourceRoot, databasePath, encryptionKey: 'candidate-secret', verifyOnly: true }),
      /does not exist/,
    );
    await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local App Settings import rejects malformed UTF-8 before creating a candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-settings-utf8-'));
  const sourceRoot = path.join(root, 'source');
  const databasePath = path.join(root, 'candidate', 'metadata.sqlite');
  const settingsPath = path.join(
    sourceRoot,
    'settings',
    path.basename(runtimeLimitSettingsRepository.descriptor.getPath()),
  );
  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, Buffer.from([0xff]));
    await assert.rejects(
      migrateLocalAppSettings({ sourceRoot, databasePath, encryptionKey: 'candidate-secret' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cannot read source App Settings domain runtime limit/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /not valid UTF-8/);
        return true;
      },
    );
    await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local App Settings candidate verification detects changed source bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-settings-import-'));
  const sourceRoot = path.join(root, 'source');
  const databasePath = path.join(root, 'candidate', 'metadata.sqlite');
  const descriptor = runtimeLimitSettingsRepository.descriptor;
  const settingsPath = path.join(sourceRoot, 'settings', path.basename(descriptor.getPath()));
  const options = { sourceRoot, databasePath, encryptionKey: 'candidate-secret' };
  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const source = JSON.stringify({
      version: descriptor.currentVersion,
      ...descriptor.serialize(descriptor.getDefault()),
    });
    await fs.writeFile(settingsPath, source);
    await migrateLocalAppSettings(options);
    await fs.writeFile(settingsPath, `${source}\n`);
    await assert.rejects(migrateLocalAppSettings({ ...options, verifyOnly: true }), /differs from the source/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
