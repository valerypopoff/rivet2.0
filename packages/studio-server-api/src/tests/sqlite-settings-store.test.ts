import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import {
  configureAppSettingsBackendForTests,
  disposeAppSettingsRepositories,
  VersionedSettingsRepository,
} from '../app-settings/settings-repository.js';

// test-style: fixture-read: reads only generated retained settings JSON and temporary encrypted database fixtures.

test('settings shutdown drains notifications against SQLite instead of retained JSON', { timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-shutdown-'));
  const settingsPath = path.join(root, 'settings.json');
  const backend = new SqliteAppSettingsBackend({
    databasePath: path.join(root, 'settings.sqlite'),
    encryptionSecret: 'test-secret',
  });
  const repository = new VersionedSettingsRepository({
    key: 'shutdown-fixture',
    currentVersion: 1,
    getPath: () => settingsPath,
    getDefault: () => ({ count: 0 }),
    parseStored: (stored) => ({ count: Number(stored.count) }),
    serialize: (value: { count: number }) => value,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const notificationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, count: 900 }));
    await configureAppSettingsBackendForTests(backend);
    await backend.write({
      key: 'shutdown-fixture',
      expectedRevision: null,
      schemaVersion: 1,
      value: { version: 1, count: 1 },
    });
    await backend.checkHealth();
    backend.subscribe(async () => {
      started();
      await gate;
      await repository.refresh();
    });
    await repository.update(() => ({ count: 2 }));
    await notificationStarted;
    const shutdown = disposeAppSettingsRepositories();
    // Let disposal reach its notification drain before releasing the listener.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await shutdown;
    assert.equal(repository.readSync().value.count, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { version: 1, count: 900 });
  } finally {
    release();
    await disposeAppSettingsRepositories();
    repository.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite repository updates do not wait on their own queued notification refresh', { timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-repository-'));
  const backend = new SqliteAppSettingsBackend({
    databasePath: path.join(root, 'settings.sqlite'),
    encryptionSecret: 'test-secret',
  });
  const repository = new VersionedSettingsRepository({
    key: 'reentrant-fixture',
    currentVersion: 1,
    getPath: () => path.join(root, 'settings.json'),
    getDefault: () => ({ count: 0 }),
    parseStored: (stored) => ({ count: Number(stored.count) }),
    serialize: (value: { count: number }) => value,
  });
  const secondRepository = new VersionedSettingsRepository(repository.descriptor);
  try {
    await configureAppSettingsBackendForTests(backend);
    await backend.write({
      key: 'reentrant-fixture',
      expectedRevision: null,
      schemaVersion: 1,
      value: { version: 1, count: 0 },
    });
    await repository.refresh();
    await Promise.all(Array.from({ length: 5 }, () => repository.update((current) => ({ count: current.count + 1 }))));
    await backend.checkHealth();
    assert.equal(repository.readSync().value.count, 5);
    assert.deepEqual((await backend.read('reentrant-fixture'))?.value, { version: 1, count: 5 });
    assert.equal((await backend.read('reentrant-fixture'))?.revision, 6n);
    await secondRepository.refresh();
    await Promise.all(
      [repository, secondRepository].map((owner) => owner.update((current) => ({ count: current.count + 1 }))),
    );
    await backend.checkHealth();
    assert.equal(repository.readSync().value.count, 7);
    assert.equal(secondRepository.readSync().value.count, 7);
  } finally {
    repository.dispose();
    secondRepository.dispose();
    await configureAppSettingsBackendForTests(null);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings persist encrypted revisions and reject stale writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
  try {
    await backend.initialize();
    const initial = await backend.write({
      key: 'environment-variables',
      expectedRevision: null,
      schemaVersion: 1,
      value: { secret: 'unique-secret-payload' },
    });
    assert.equal(initial?.revision, 1n);
    assert.deepEqual(initial?.value, { secret: 'unique-secret-payload' });
    assert.equal(
      await backend.write({
        key: 'environment-variables',
        expectedRevision: null,
        schemaVersion: 1,
        value: { secret: 'stale' },
      }),
      null,
    );
    const updated = await backend.write({
      key: 'environment-variables',
      expectedRevision: 1n,
      schemaVersion: 1,
      value: { secret: 'next-secret-payload' },
    });
    assert.equal(updated?.revision, 2n);
    const second = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await second.initialize();
    assert.equal(
      await second.write({
        key: 'environment-variables',
        expectedRevision: 1n,
        schemaVersion: 1,
        value: { secret: 'stale-from-another-process' },
      }),
      null,
    );
    await second.dispose();

    let listenerFails = true;
    backend.subscribe(() => {
      if (listenerFails) throw new Error('subscriber failed');
    });
    const afterNotificationFailure = await backend.write({
      key: 'environment-variables',
      expectedRevision: 2n,
      schemaVersion: 1,
      value: { secret: 'final-secret-payload' },
    });
    assert.equal(afterNotificationFailure?.revision, 3n);
    assert.throws(() => backend.assertSynchronized(), /synchronization failed/);
    await assert.rejects(backend.checkHealth(), /synchronization failed/);
    listenerFails = false;
    await backend.checkHealth();
    await backend.dispose();

    const reopened = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await reopened.initialize();
    assert.deepEqual((await reopened.read('environment-variables'))?.value, { secret: 'final-secret-payload' });
    await reopened.dispose();
    const raw = new DatabaseSync(databasePath);
    const stored = raw
      .prepare('SELECT ciphertext FROM app_settings WHERE setting_key = ?')
      .get('environment-variables') as {
      ciphertext: Uint8Array;
    };
    assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from('final-secret-payload')), false);
    raw.close();

    const wrongKey = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'wrong-secret' });
    await assert.rejects(wrongKey.initialize(), /unavailable key/);
  } finally {
    await backend.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings refuse a symlink database path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const target = path.join(root, 'target.sqlite');
    const database = new DatabaseSync(target);
    database.close();
    await fs.symlink(target, databasePath);
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /symlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings refuse to modify an unrelated database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'unrelated.sqlite');
  try {
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec('CREATE TABLE important_data (value TEXT NOT NULL)');
    unrelated.close();

    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /unidentified database/);

    const inspect = new DatabaseSync(databasePath);
    const tables = inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    assert.deepEqual(
      tables.map((table) => table.name),
      ['important_data'],
    );
    inspect.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject an incompatible table in a marked database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(
      'PRAGMA application_id = 1380537940; PRAGMA user_version = 1; CREATE TABLE app_settings (setting_key TEXT)',
    );
    malformed.close();
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /schema is incompatible/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject a table with matching names but missing constraints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      PRAGMA application_id = 1380537940;
      PRAGMA user_version = 1;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY, revision INTEGER, schema_version INTEGER,
        ciphertext BLOB, iv BLOB, auth_tag BLOB, key_id TEXT,
        source_hash TEXT, updated_at TEXT
      );
    `);
    malformed.close();
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /schema is incompatible/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject another database even if it contains only a view', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'unrelated.sqlite');
  try {
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec('CREATE VIEW important_view AS SELECT 1 AS value');
    unrelated.close();

    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /unidentified database/);
    const inspect = new DatabaseSync(databasePath);
    assert.equal((inspect.prepare('PRAGMA application_id').get() as { application_id: number }).application_id, 0);
    inspect.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject unknown schema versions without altering records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const original = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await original.initialize();
    await original.write({ key: 'general', expectedRevision: null, schemaVersion: 1, value: { name: 'original' } });
    await original.dispose();

    const future = new DatabaseSync(databasePath);
    future.exec('PRAGMA user_version = 2');
    future.close();

    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /schema version 2 is unsupported/);
    const inspect = new DatabaseSync(databasePath);
    assert.equal((inspect.prepare('SELECT COUNT(*) AS count FROM app_settings').get() as { count: number }).count, 1);
    inspect.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject weakened constraints even with matching columns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      PRAGMA application_id = 1380537940;
      PRAGMA user_version = 1;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        key_id TEXT NOT NULL,
        source_hash TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    malformed.close();
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /schema is incompatible/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings fail health and reopen when an encrypted row is damaged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await backend.initialize();
    await backend.write({
      key: 'unloaded-setting',
      expectedRevision: null,
      schemaVersion: 1,
      value: { enabled: true },
    });
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare('UPDATE app_settings SET ciphertext = ? WHERE setting_key = ?')
      .run(Buffer.from('broken'), 'unloaded-setting');
    raw.close();
    await assert.rejects(backend.checkHealth());
    await backend.dispose();

    const reopened = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(reopened.initialize());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings do not clear a newer failed notification when an older one finishes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
  try {
    await backend.initialize();
    await backend.write({ key: 'general', expectedRevision: null, schemaVersion: 1, value: { value: 1 } });
    let releaseOlder!: () => void;
    let olderStarted!: () => void;
    const olderWait = new Promise<void>((resolve) => (releaseOlder = resolve));
    const olderStartedWait = new Promise<void>((resolve) => (olderStarted = resolve));
    let calls = 0;
    backend.subscribe(async () => {
      calls += 1;
      if (calls === 1) {
        olderStarted();
        await olderWait;
      } else if (calls === 2) {
        throw new Error('newer notification failed');
      }
    });

    const olderWrite = backend.write({
      key: 'general',
      expectedRevision: 1n,
      schemaVersion: 1,
      value: { value: 2 },
    });
    await olderStartedWait;
    const newerWrite = await backend.write({
      key: 'general',
      expectedRevision: 2n,
      schemaVersion: 1,
      value: { value: 3 },
    });
    assert.equal(newerWrite?.revision, 3n);
    releaseOlder();
    await olderWrite;
    assert.throws(() => backend.assertSynchronized(), /synchronization failed/);
    await backend.checkHealth();
  } finally {
    await backend.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings re-encrypt an old-key row before the old key is removed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const old = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'old-secret' });
    await old.initialize();
    await old.write({
      key: 'public-routes',
      expectedRevision: null,
      schemaVersion: 1,
      value: { route: '/workflows' },
    });
    await old.dispose();

    const rotating = new SqliteAppSettingsBackend({
      databasePath,
      encryptionSecret: 'new-secret',
      previousEncryptionSecret: 'old-secret',
    });
    await rotating.initialize();
    assert.equal((await rotating.read('public-routes'))?.revision, 2n);
    await rotating.dispose();

    const current = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'new-secret' });
    await current.initialize();
    assert.deepEqual((await current.read('public-routes'))?.value, { route: '/workflows' });
    await current.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings reject an unexpected trigger in an otherwise valid database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const original = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await original.initialize();
    await original.dispose();
    const raw = new DatabaseSync(databasePath);
    raw.exec('CREATE TRIGGER unexpected AFTER INSERT ON app_settings BEGIN SELECT 1; END');
    raw.close();
    const reopened = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(reopened.initialize(), /unexpected objects/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite App Settings verification is read-only, including when a key rotation is available', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    const original = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'old-secret' });
    await original.initialize();
    await original.write({ key: 'general', expectedRevision: null, schemaVersion: 1, value: { value: 1 } });
    await original.dispose();
    const before = await fs.stat(databasePath);

    const verifier = new SqliteAppSettingsBackend({
      databasePath,
      encryptionSecret: 'new-secret',
      previousEncryptionSecret: 'old-secret',
    });
    try {
      await verifier.initialize({ readOnly: true });
      assert.deepEqual((await verifier.read('general'))?.value, { value: 1 });
      assert.equal((await verifier.read('general'))?.revision, 1n);
      await verifier.checkHealth();
      await assert.rejects(
        verifier.write({ key: 'general', expectedRevision: 1n, schemaVersion: 1, value: { value: 2 } }),
        /verification only/,
      );
      await assert.rejects(verifier.initialize(), /already open in another mode/);
    } finally {
      await verifier.dispose();
    }
    const after = await fs.stat(databasePath);
    assert.deepEqual(
      { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs },
      { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
