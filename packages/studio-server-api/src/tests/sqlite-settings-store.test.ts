import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import {
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
} from '../app-settings/managed-settings-crypto.js';
import {
  configureAppSettingsBackendForTests,
  disposeAppSettingsRepositories,
  VersionedSettingsRepository,
} from '../app-settings/settings-repository.js';

const { assertSettingsBackupSchema } = await import(
  new URL('../../../../deploy/studio-server/scripts/local-upgrade-backup.mjs', import.meta.url).href
);

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

test('SQLite App Settings persist plaintext revisions without a key and reject stale writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  const backend = new SqliteAppSettingsBackend({ databasePath });
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
    const backupReader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(assertSettingsBackupSchema(backupReader), 2);
    } finally {
      backupReader.close();
    }
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
      .prepare('SELECT value_json FROM app_settings WHERE setting_key = ?')
      .get('environment-variables') as {
      value_json: string;
    };
    assert.deepEqual(JSON.parse(stored.value_json), { secret: 'final-secret-payload' });
    raw.close();

    const noKey = new SqliteAppSettingsBackend({ databasePath });
    await noKey.initialize();
    assert.deepEqual((await noKey.read('environment-variables'))?.value, { secret: 'final-secret-payload' });
    await noKey.dispose();
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
    future.exec('PRAGMA user_version = 3');
    future.close();

    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(backend.initialize(), /schema version 3 is unsupported/);
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

test('SQLite App Settings fail health and reopen when a plaintext row is damaged', async () => {
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
      .prepare('UPDATE app_settings SET value_json = ? WHERE setting_key = ?')
      .run('private-broken-password', 'unloaded-setting');
    raw.close();
    await assert.rejects(backend.checkHealth(), { message: 'SQLite App Settings JSON is invalid.' });
    await backend.dispose();

    const reopened = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'test-secret' });
    await assert.rejects(reopened.initialize(), { message: 'SQLite App Settings JSON is invalid.' });
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

function legacyDatabase(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA application_id = 1380537940; PRAGMA user_version = 1;
CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  source_hash TEXT,
  updated_at TEXT NOT NULL
)`);
  const encrypted = encryptManagedSettingsValue(
    { key: 'public-routes', schemaVersion: 1 },
    { route: '/workflows' },
    deriveManagedSettingsEncryptionKey('old-secret'),
  );
  db.prepare('INSERT INTO app_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'public-routes',
    7,
    1,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.authTag,
    encrypted.keyId,
    'retained-hash',
    '2026-01-01T00:00:00.000Z',
  );
  db.close();
}

for (const legacy of [false, true]) {
  test(
    `SQLite settings are private before ${legacy ? 'plaintext conversion' : 'initial schema creation'}`,
    { skip: process.platform === 'win32' },
    async (context) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-private-settings-'));
      const databasePath = path.join(root, 'metadata.sqlite');
      const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'old-secret' });
      const originalUmask = process.umask(0);
      try {
        if (legacy) {
          legacyDatabase(databasePath);
          await fs.chmod(databasePath, 0o644);
        }
        const originalExec = DatabaseSync.prototype.exec;
        let checked = false;
        context.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
          if (sql.startsWith('CREATE TABLE app_settings') || sql.startsWith('ALTER TABLE app_settings')) {
            assert.equal(statSync(databasePath).mode & 0o777, 0o600);
            checked = true;
          }
          return originalExec.call(this, sql);
        });
        await backend.initialize();
        assert.equal(checked, true);
      } finally {
        process.umask(originalUmask);
        await backend.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}

test('SQLite App Settings convert encrypted rows atomically without changing revisions or needing a key afterward', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    legacyDatabase(databasePath);
    const before = await fs.readFile(databasePath);
    const missing = new SqliteAppSettingsBackend({ databasePath });
    await assert.rejects(missing.initialize(), /unavailable key/);
    assert.deepEqual(await fs.readFile(databasePath), before);
    const wrong = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'wrong-secret' });
    await assert.rejects(wrong.initialize(), /unavailable key/);
    assert.deepEqual(await fs.readFile(databasePath), before);
    const paused = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'old-secret', convertLegacy: false });
    await paused.initialize();
    assert.equal((await paused.read('public-routes'))?.revision, 7n);
    await assert.rejects(
      paused.write({ key: 'public-routes', expectedRevision: 7n, schemaVersion: 1, value: {} }),
      /read-only until write resumption/,
    );
    await paused.dispose();
    assert.deepEqual(await fs.readFile(databasePath), before);

    const rotating = new SqliteAppSettingsBackend({
      databasePath,
      encryptionSecret: 'new-secret',
      previousEncryptionSecret: 'old-secret',
    });
    await rotating.initialize();
    assert.equal((await rotating.read('public-routes'))?.revision, 7n);
    await rotating.dispose();

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.deepEqual(
      {
        ...(raw.prepare('SELECT revision, source_hash, updated_at FROM app_settings').get() as Record<string, unknown>),
      },
      { revision: 7, source_hash: 'retained-hash', updated_at: '2026-01-01T00:00:00.000Z' },
    );
    raw.close();
    const current = new SqliteAppSettingsBackend({ databasePath });
    await current.initialize();
    assert.deepEqual((await current.read('public-routes'))?.value, { route: '/workflows' });
    await current.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed encrypted-to-plaintext conversion rolls back the complete schema and can retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-settings-conversion-'));
  const databasePath = path.join(root, 'settings.sqlite');
  try {
    legacyDatabase(databasePath);
    const original = DatabaseSync.prototype.exec;
    const fault = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'DROP TABLE legacy_app_settings') throw new Error('fixture conversion failure');
      return original.call(this, sql);
    });
    const backend = new SqliteAppSettingsBackend({ databasePath, encryptionSecret: 'old-secret' });
    await assert.rejects(backend.initialize(), /fixture conversion failure/);
    fault.mock.restore();
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(raw.prepare('SELECT revision FROM app_settings').get()!.revision, 7);
    assert.equal(assertSettingsBackupSchema(raw), 1);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_app_settings'").get(), undefined);
    raw.close();
    await backend.initialize();
    assert.equal((await backend.read('public-routes'))?.revision, 7n);
    await backend.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy settings conversion rechecks write admission before changing the certified database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-settings-admission-'));
  const databasePath = path.join(root, 'settings.sqlite');
  const backend = new SqliteAppSettingsBackend({
    databasePath,
    encryptionSecret: 'old-secret',
    assertWritable: () => {
      throw new Error('fixture write fence closed');
    },
  });
  try {
    legacyDatabase(databasePath);
    const before = await fs.readFile(databasePath);
    await assert.rejects(backend.initialize(), /write fence closed/);
    assert.deepEqual(await fs.readFile(databasePath), before);
  } finally {
    await backend.dispose();
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

test('legacy encrypted SQLite verification is read-only even when plaintext conversion is available', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-settings-'));
  const databasePath = path.join(root, 'metadata.sqlite');
  try {
    legacyDatabase(databasePath);
    const before = await fs.stat(databasePath);

    const verifier = new SqliteAppSettingsBackend({
      databasePath,
      encryptionSecret: 'new-secret',
      previousEncryptionSecret: 'old-secret',
    });
    try {
      await verifier.initialize({ readOnly: true });
      assert.deepEqual((await verifier.read('public-routes'))?.value, { route: '/workflows' });
      assert.equal((await verifier.read('public-routes'))?.revision, 7n);
      await verifier.checkHealth();
      await assert.rejects(
        verifier.write({ key: 'public-routes', expectedRevision: 7n, schemaVersion: 1, value: {} }),
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
