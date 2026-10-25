import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { PostgresAppSettingsBackend } from '../app-settings/managed-settings-store.js';
import {
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
} from '../app-settings/managed-settings-crypto.js';
import {
  configureAppSettingsBackendForTests,
  initializeAppSettingsRepositories,
  getAppSettingsBackendKind,
  VersionedSettingsRepository,
} from '../app-settings/settings-repository.js';

test('concurrent settings disposal waits for the same pending pool close', async (t) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const end: (this: Pool) => Promise<void> = Pool.prototype.end;
  let closes = 0;
  t.mock.method(Pool.prototype, 'end', function (this: Pool) {
    closes++;
    return gate.then(() => end.call(this));
  });
  const backend = new PostgresAppSettingsBackend({
    poolConfig: { host: 'settings-dispose-pending.invalid' },
    encryptionSecret: 'fixture',
  });
  const first = backend.dispose();
  const second = backend.dispose();
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  try {
    await setImmediate();
    assert.equal(settled, false, 'a second disposal must not invent an early close acknowledgement');
  } finally {
    finish();
    await first;
  }
  await second;
  assert.equal(closes, 1);
});

test('failed settings disposal remains failed and never retries an uncertain driver close', async (t) => {
  const failure = new Error('settings pool close acknowledgement unavailable');
  const end: (this: Pool) => Promise<void> = Pool.prototype.end;
  let pool: Pool | undefined;
  let closes = 0;
  t.mock.method(Pool.prototype, 'end', async function (this: Pool) {
    pool = this;
    closes++;
    throw failure;
  });
  // Test-owned, never-connected driver object is closed directly after the
  // simulated failure; the registry must still preserve its unconfirmed state.
  t.after(async () => {
    if (pool) await end.call(pool);
  });
  const backend = new PostgresAppSettingsBackend({
    poolConfig: { host: 'settings-dispose-failed.invalid' },
    encryptionSecret: 'fixture',
  });
  const isFailure = (error: unknown) => error instanceof AggregateError && error.errors.includes(failure);
  await assert.rejects(backend.dispose(), isFailure);
  await assert.rejects(backend.dispose(), isFailure);
  assert.equal(closes, 1);
});

test('failed settings startup and cleanup retain a failed initialization until explicit cleanup succeeds', async (t) => {
  const env = process.env;
  const startup = new Error('fixture settings startup failure');
  const cleanup = new Error('fixture cleanup remains unconfirmed');
  const dispose = PostgresAppSettingsBackend.prototype.dispose;
  let allowCleanup = false;
  t.mock.method(PostgresAppSettingsBackend.prototype, 'initialize', async () => {
    throw startup;
  });
  t.mock.method(PostgresAppSettingsBackend.prototype, 'dispose', function (this: PostgresAppSettingsBackend) {
    return allowCleanup ? dispose.call(this) : Promise.reject(cleanup);
  });
  process.env = {
    ...env,
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_APP_SETTINGS_DATABASE_URL: 'postgresql://fixture:fixture@startup-cleanup.invalid/settings',
    RIVET_APP_SETTINGS_ENCRYPTION_KEY: 'fixture',
    RIVET_DEPLOYMENT_DATABASE_SSL_MODE: 'disable',
  };
  const isFailure = (error: unknown) =>
    error instanceof AggregateError && error.errors.includes(startup) && error.errors.includes(cleanup);
  try {
    await assert.rejects(initializeAppSettingsRepositories(), isFailure);
    assert.equal(getAppSettingsBackendKind(), 'postgres');
    await assert.rejects(
      initializeAppSettingsRepositories(),
      isFailure,
      'retaining an owner must not falsely report startup readiness',
    );
  } finally {
    allowCleanup = true;
    await configureAppSettingsBackendForTests(null);
    process.env = env;
  }
});

test('revision polling failures disable cached settings and recover at the same database revision', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const secret = 'isolated-sync-test';
  const key = 'sync-test';
  const encryptionKey = deriveManagedSettingsEncryptionKey(secret);
  const encrypted = encryptManagedSettingsValue(
    { key, schemaVersion: 1 },
    { version: 1, allowed: true },
    encryptionKey,
  );
  const row = {
    setting_key: key,
    revision: '1',
    schema_version: 1,
    source_hash: null,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    auth_tag: encrypted.authTag,
    key_id: encrypted.keyId,
  };
  let failPoll = false;
  let releasePoll: (() => void) | undefined;
  let stallPoll = false;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  let failRead = false;
  let reads = 0;
  t.mock.method(Pool.prototype, 'query', (async (sql: string) => {
    if (sql.includes('ORDER BY setting_key')) {
      if (failPoll) throw new Error('revision index unavailable');
      if (stallPoll)
        await new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
      return { rows: [{ setting_key: key, revision: '1' }] };
    }
    reads++;
    if (failRead) throw new Error('setting read unavailable');
    return { rows: [row] };
  }) as unknown as Pool['query']);
  t.mock.method(Client.prototype, 'connect', async function (this: Client) {
    return this;
  } as Client['connect']);
  t.mock.method(Client.prototype, 'query', (async () => ({ rows: [] })) as unknown as Client['query']);
  t.mock.method(Client.prototype, 'end', (async () => {}) as Client['end']);
  const backend = new PostgresAppSettingsBackend({
    poolConfig: { host: 'isolated-sync.invalid', database: 'sync-test' },
    encryptionSecret: secret,
    pollIntervalMs: 1_000,
    logger: { error() {}, warn() {}, log() {} },
  });
  const repository = new VersionedSettingsRepository({
    key,
    currentVersion: 1,
    getPath: () => 'unused-managed-sync-test.json',
    getDefault: () => ({ allowed: false }),
    parseStored: (value) => ({ allowed: value.allowed === true }),
    serialize: (value) => value,
  });
  const poll = async () => {
    t.mock.timers.tick(1_000);
    await setImmediate();
  };
  try {
    await configureAppSettingsBackendForTests(backend);
    await repository.initialize();
    assert.equal(repository.readSync().value.allowed, true);
    failPoll = true;
    await poll();
    assert.throws(() => repository.readSync(), /synchroniz/i);
    failPoll = false;
    failRead = true;
    await poll();
    assert.throws(() => repository.readSync());
    failRead = false;
    await poll();
    assert.equal(repository.readSync().value.allowed, true);
    const recoveredReads = reads;
    await poll();
    assert.equal(reads, recoveredReads, 'healthy unchanged revisions need no value reads');
    failRead = true;
    await assert.rejects(repository.refresh(), /setting read unavailable/);
    failRead = false;
    await poll();
    assert.equal(
      repository.readSync().value.allowed,
      true,
      'a single-domain read failure recovers without a version change',
    );
    stallPoll = true;
    await poll();
    clock = 15_000;
    assert.throws(() => repository.readSync(), /stale/);
    stallPoll = false;
    releasePoll!();
    await setImmediate();
    assert.throws(() => repository.readSync(), /stale/, 'late completion must not freshen an old index');
    await poll();
    assert.equal(repository.readSync().value.allowed, true);
  } finally {
    releasePoll?.();
    repository.dispose();
    await configureAppSettingsBackendForTests(null);
  }
});
