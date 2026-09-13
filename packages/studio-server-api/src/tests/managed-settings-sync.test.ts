import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { PostgresAppSettingsBackend } from '../app-settings/managed-settings-store.js';
import { deriveManagedSettingsEncryptionKey, encryptManagedSettingsValue } from '../app-settings/managed-settings-crypto.js';
import { configureAppSettingsBackendForTests, VersionedSettingsRepository } from '../app-settings/settings-repository.js';

test('revision polling failures disable cached settings and recover at the same database revision', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const secret = 'isolated-sync-test';
  const key = 'sync-test';
  const encryptionKey = deriveManagedSettingsEncryptionKey(secret);
  const encrypted = encryptManagedSettingsValue({ key, schemaVersion: 1 }, { version: 1, allowed: true }, encryptionKey);
  const row = {
    setting_key: key, revision: '1', schema_version: 1, source_hash: null,
    ciphertext: encrypted.ciphertext, iv: encrypted.iv, auth_tag: encrypted.authTag, key_id: encrypted.keyId,
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
      if (stallPoll) await new Promise<void>((resolve) => { releasePoll = resolve; });
      return { rows: [{ setting_key: key, revision: '1' }] };
    }
    reads++;
    if (failRead) throw new Error('setting read unavailable');
    return { rows: [row] };
  }) as unknown as Pool['query']);
  t.mock.method(Client.prototype, 'connect', (async function (this: Client) { return this; }) as Client['connect']);
  t.mock.method(Client.prototype, 'query', (async () => ({ rows: [] })) as unknown as Client['query']);
  t.mock.method(Client.prototype, 'end', (async () => {}) as Client['end']);
  const backend = new PostgresAppSettingsBackend({
    poolConfig: { host: 'isolated-sync.invalid', database: 'sync-test' },
    encryptionSecret: secret, pollIntervalMs: 1_000,
    logger: { error() {}, warn() {}, log() {} },
  });
  const repository = new VersionedSettingsRepository({
    key, currentVersion: 1, getPath: () => 'unused-managed-sync-test.json',
    getDefault: () => ({ allowed: false }),
    parseStored: (value) => ({ allowed: value.allowed === true }), serialize: (value) => value,
  });
  const poll = async () => { t.mock.timers.tick(1_000); await setImmediate(); };
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
    assert.equal(repository.readSync().value.allowed, true, 'a single-domain read failure recovers without a version change');
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
