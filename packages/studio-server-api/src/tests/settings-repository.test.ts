import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  configureAppSettingsBackendForTests,
  runWithAppSettingsSnapshot,
  SettingsRevisionConflictError,
  VersionedSettingsRepository,
  type SettingsRepositoryDescriptor,
} from '../app-settings/settings-repository.js';
import {
  decryptManagedSettingsValue,
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
} from '../app-settings/managed-settings-crypto.js';
import type {
  AppSettingsBackend,
  ManagedSettingsRecord,
  ManagedSettingsWrite,
} from '../app-settings/managed-settings-store.js';
import {
  acknowledgeManagedSettingsRevision,
  publishManagedSettingsChange,
} from '../app-settings/managed-settings-store.js';

type TestSettings = {
  count: number;
  nested: {
    label: string;
  };
};

async function withTestRepository(
  run: (context: {
    filePath: string;
    repository: VersionedSettingsRepository<TestSettings>;
  }) => Promise<void> | void,
  descriptorOverrides: Partial<SettingsRepositoryDescriptor<TestSettings>> = {},
): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-settings-repository-'));
  const filePath = path.join(tempRoot, 'settings.json');
  const repository = new VersionedSettingsRepository<TestSettings>({
    key: `test-${path.basename(tempRoot)}`,
    currentVersion: 1,
    getPath: () => filePath,
    getDefault: () => ({ count: 0, nested: { label: 'default' } }),
    parseStored: (stored) => ({
      count: Number(stored.count ?? 0),
      nested: {
        label: typeof stored.label === 'string' ? stored.label : 'default',
      },
    }),
    serialize: (value) => ({ count: value.count, label: value.nested.label }),
    ...descriptorOverrides,
  });

  try {
    await run({ filePath, repository });
  } finally {
    repository.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('settings repository returns immutable cached snapshots', async () => {
  await withTestRepository(async ({ repository }) => {
    const first = repository.readSync();
    const second = repository.readSync();

    assert.equal(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.value), true);
    assert.equal(Object.isFrozen(first.value.nested), true);
    assert.throws(() => {
      (first.value.nested as { label: string }).label = 'mutated';
    }, TypeError);
    assert.equal(repository.readSync().value.nested.label, 'default');
  });
});

test('settings repository rejects unsupported future schema versions', async () => {
  await withTestRepository(async ({ filePath, repository }) => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, count: 1, label: 'future' }));

    await assert.rejects(repository.read(), /newer than supported version 1/);
  });
});

test('settings repository applies explicit schema migrations', async () => {
  await withTestRepository(async ({ filePath, repository }) => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, oldCount: 7, label: 'migrated' }));

    const snapshot = await repository.read();
    assert.equal(snapshot.value.count, 7);
    assert.equal(snapshot.value.nested.label, 'migrated');
  }, {
    currentVersion: 2,
    migrations: {
      1: (stored) => ({ ...stored, count: stored.oldCount }),
    },
  });
});

test('settings repository serializes concurrent partial updates', async () => {
  await withTestRepository(async ({ repository }) => {
    await Promise.all(Array.from({ length: 20 }, () => repository.update((current) => ({
      count: current.count + 1,
      nested: current.nested,
    }))));

    assert.equal((await repository.read()).value.count, 20);
  });
});

test('settings repository orders external refreshes before queued updates', async () => {
  await withTestRepository(async ({ filePath, repository }) => {
    await repository.initialize();
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, count: 5, label: 'external' }));

    const refresh = repository.refreshIfChanged();
    const update = repository.update((current) => ({
      count: current.count + 1,
      nested: current.nested,
    }));
    await Promise.all([refresh, update]);

    const snapshot = await repository.read();
    assert.equal(snapshot.value.count, 6);
    assert.equal(snapshot.value.nested.label, 'external');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).count, 6);
  });
});

test('settings repository pins one revision for the lifetime of a request', async () => {
  await withTestRepository(async ({ repository }) => {
    await repository.update(() => ({ count: 1, nested: { label: 'first' } }));

    let releaseRequest!: () => void;
    const requestCanFinish = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const request = runWithAppSettingsSnapshot(async () => {
      const first = await repository.read();
      await requestCanFinish;
      const second = await repository.read();
      return { first, second };
    });

    await repository.update(() => ({ count: 2, nested: { label: 'second' } }));
    releaseRequest();
    const snapshots = await request;

    assert.equal(snapshots.first, snapshots.second);
    assert.equal(snapshots.second.value.count, 1);
    assert.equal((await repository.read()).value.count, 2);
  });
});

test('settings repository captures every domain at the request boundary', async () => {
  await withTestRepository(async ({ repository: firstRepository }) => {
    await withTestRepository(async ({ repository: secondRepository }) => {
      await firstRepository.update(() => ({ count: 1, nested: { label: 'first' } }));
      await secondRepository.update(() => ({ count: 10, nested: { label: 'second' } }));

      let releaseRequest!: () => void;
      const requestCanFinish = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      const request = runWithAppSettingsSnapshot(async () => {
        const first = firstRepository.readSync();
        await requestCanFinish;
        return {
          first,
          second: secondRepository.readSync(),
        };
      });

      await secondRepository.update(() => ({ count: 20, nested: { label: 'updated' } }));
      releaseRequest();
      const snapshots = await request;

      assert.equal(snapshots.first.value.count, 1);
      assert.equal(snapshots.second.value.count, 10);
      assert.equal(secondRepository.readSync().value.count, 20);
    });
  });
});

test('settings repository rejects stale optimistic revisions', async () => {
  await withTestRepository(async ({ repository }) => {
    const original = repository.readSync();
    await repository.update(() => ({ count: 1, nested: { label: 'saved' } }), original.revision);

    await assert.rejects(
      repository.update(() => ({ count: 2, nested: { label: 'stale' } }), original.revision),
      SettingsRevisionConflictError,
    );
    assert.equal((await repository.read()).value.count, 1);
  });
});

test('settings repository notifies subscribers only when content changes', async () => {
  await withTestRepository(async ({ repository }) => {
    await repository.initialize();
    const revisions: string[] = [];
    const unsubscribe = repository.subscribe((snapshot) => revisions.push(snapshot.revision));

    await repository.update(() => ({ count: 1, nested: { label: 'saved' } }));
    await repository.read();
    unsubscribe();

    assert.equal(revisions.length, 1);
  });
});

test('settings repository isolates subscriber failures from successful writes', async () => {
  await withTestRepository(async ({ repository }) => {
    await repository.initialize();
    const originalConsoleError = console.error;
    let healthyListenerCalls = 0;
    console.error = () => {
      throw new Error('logger failed');
    };
    repository.subscribe(() => {
      throw new Error('subscriber failed');
    });
    repository.subscribe(() => {
      healthyListenerCalls += 1;
    });

    try {
      const saved = await repository.update(() => ({ count: 1, nested: { label: 'saved' } }));
      assert.equal(saved.value.count, 1);
      assert.equal(repository.readSync().value.count, 1);
      assert.equal(healthyListenerCalls, 1);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
type StoredManagedRecord = ManagedSettingsRecord;

class InMemoryAppSettingsBackend implements AppSettingsBackend {
  readonly records = new Map<string, StoredManagedRecord>();
  readonly listeners = new Set<(key: string) => void>();
  initialized = false;
  disposed = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async read(key: string): Promise<ManagedSettingsRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  async write(input: ManagedSettingsWrite): Promise<ManagedSettingsRecord | null> {
    const current = this.records.get(input.key);
    if (input.expectedRevision == null ? current != null : current?.revision !== input.expectedRevision) {
      return null;
    }

    await Promise.resolve();
    const latest = this.records.get(input.key);
    if (input.expectedRevision == null ? latest != null : latest?.revision !== input.expectedRevision) {
      return null;
    }

    const record: StoredManagedRecord = {
      key: input.key,
      revision: (latest?.revision ?? 0n) + 1n,
      schemaVersion: input.schemaVersion,
      value: structuredClone(input.value),
      sourceHash: input.sourceHash ?? null,
    };
    this.records.set(input.key, record);
    for (const listener of this.listeners) {
      listener(input.key);
    }
    return structuredClone(record);
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
  }
}

function createManagedTestRepository(key: string, filePath: string): VersionedSettingsRepository<TestSettings> {
  return new VersionedSettingsRepository<TestSettings>({
    key,
    currentVersion: 1,
    getPath: () => filePath,
    getDefault: () => ({ count: 0, nested: { label: 'default' } }),
    parseStored: (stored) => ({
      count: Number(stored.count ?? 0),
      nested: { label: typeof stored.label === 'string' ? stored.label : 'default' },
    }),
    serialize: (value) => ({ count: value.count, label: value.nested.label }),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for managed settings invalidation.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('managed settings import a legacy file once and use PostgreSQL afterward', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-managed-settings-import-'));
  const firstPath = path.join(tempRoot, 'first.json');
  const secondPath = path.join(tempRoot, 'second.json');
  const key = `managed-import-${path.basename(tempRoot)}`;
  fs.writeFileSync(firstPath, JSON.stringify({ version: 1, count: 7, label: 'legacy' }));
  fs.writeFileSync(secondPath, JSON.stringify({ version: 1, count: 99, label: 'stale-file' }));
  const backend = new InMemoryAppSettingsBackend();
  const first = createManagedTestRepository(key, firstPath);
  const second = createManagedTestRepository(key, secondPath);

  try {
    await configureAppSettingsBackendForTests(backend);
    assert.equal((await first.initialize()).value.count, 7);
    assert.match(backend.records.get(key)?.sourceHash ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual((await second.initialize()).value, { count: 7, nested: { label: 'legacy' } });
  } finally {
    first.dispose();
    second.dispose();
    await configureAppSettingsBackendForTests(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed settings retry concurrent CAS updates without losing fields', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-managed-settings-cas-'));
  const key = `managed-cas-${path.basename(tempRoot)}`;
  const backend = new InMemoryAppSettingsBackend();
  const first = createManagedTestRepository(key, path.join(tempRoot, 'first.json'));
  const second = createManagedTestRepository(key, path.join(tempRoot, 'second.json'));

  try {
    await configureAppSettingsBackendForTests(backend);
    await Promise.all([first.initialize(), second.initialize()]);
    await Promise.all([
      first.update((current) => ({ ...current, count: current.count + 1 })),
      second.update((current) => ({ ...current, nested: { label: 'replica-two' } })),
    ]);

    const current = await first.read();
    assert.equal(current.value.count, 1);
    assert.equal(current.value.nested.label, 'replica-two');
    assert.equal(backend.records.get(key)?.revision, 3n);
  } finally {
    first.dispose();
    second.dispose();
    await configureAppSettingsBackendForTests(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed settings invalidate replica caches and preserve request snapshots', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-managed-settings-snapshot-'));
  const key = `managed-snapshot-${path.basename(tempRoot)}`;
  const backend = new InMemoryAppSettingsBackend();
  const first = createManagedTestRepository(key, path.join(tempRoot, 'first.json'));
  const second = createManagedTestRepository(key, path.join(tempRoot, 'second.json'));

  try {
    await configureAppSettingsBackendForTests(backend);
    await Promise.all([first.initialize(), second.initialize()]);
    const staleRevision = first.readSync().revision;

    let releaseRequest!: () => void;
    const requestCanFinish = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const request = runWithAppSettingsSnapshot(async () => {
      const before = first.readSync();
      await requestCanFinish;
      return { before, after: first.readSync() };
    });

    await second.update(() => ({ count: 4, nested: { label: 'remote' } }));
    await waitFor(() => first.readSync().value.count === 4);
    releaseRequest();
    const captured = await request;

    assert.equal(captured.before, captured.after);
    assert.equal(captured.after.value.count, 0);
    assert.equal(first.readSync().value.count, 4);
    await assert.rejects(
      first.update((current) => ({ ...current, count: 5 }), staleRevision),
      SettingsRevisionConflictError,
    );
  } finally {
    first.dispose();
    second.dispose();
    await configureAppSettingsBackendForTests(null);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
test('managed settings encryption binds ciphertext to its domain and schema version', () => {
  const oldKey = deriveManagedSettingsEncryptionKey('old-deployment-secret');
  const newKey = deriveManagedSettingsEncryptionKey('new-deployment-secret');
  const context = { key: 'oauth', schemaVersion: 2 };
  const encrypted = encryptManagedSettingsValue(
    context,
    { clientSecret: 'sensitive-value' },
    oldKey,
  );

  assert.notEqual(oldKey.id, newKey.id);
  assert.equal(encrypted.keyId, oldKey.id);
  assert.equal(encrypted.ciphertext.includes(Buffer.from('sensitive-value')), false);
  assert.deepEqual(
    decryptManagedSettingsValue(context, encrypted, new Map([
      [newKey.id, newKey],
      [oldKey.id, oldKey],
    ])),
    { clientSecret: 'sensitive-value' },
  );
  assert.throws(
    () => decryptManagedSettingsValue(context, encrypted, new Map([[newKey.id, newKey]])),
    /encrypted with unavailable key/,
  );
  assert.throws(
    () => decryptManagedSettingsValue(
      { key: 'environment-variables', schemaVersion: context.schemaVersion },
      encrypted,
      new Map([[oldKey.id, oldKey]]),
    ),
    /authenticate data/,
  );
  assert.throws(
    () => decryptManagedSettingsValue(
      { key: context.key, schemaVersion: context.schemaVersion + 1 },
      encrypted,
      new Map([[oldKey.id, oldKey]]),
    ),
    /authenticate data/,
  );
});

test('managed settings import legacy domains independently over candidate bootstrap files', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-managed-settings-partial-legacy-'));
  const candidateRoot = path.join(tempRoot, 'candidate');
  const legacyRoot = path.join(tempRoot, 'legacy');
  const candidateSettings = path.join(candidateRoot, 'settings');
  const legacySettings = path.join(legacyRoot, 'settings');
  fs.mkdirSync(candidateSettings, { recursive: true });
  fs.mkdirSync(legacySettings, { recursive: true });

  const routeCandidate = JSON.stringify({ version: 1, count: 2, label: 'candidate-route' });
  const routeLegacy = JSON.stringify({ version: 1, count: 7, label: 'legacy-route' });
  const storageCandidate = JSON.stringify({ version: 1, count: 11, label: 'candidate-storage' });
  const invalidCandidate = JSON.stringify({ version: 1, count: 13, label: 'candidate-invalid-fallback' });
  const directoryCandidate = JSON.stringify({ version: 1, count: 17, label: 'candidate-directory-fallback' });
  fs.writeFileSync(path.join(candidateSettings, 'routes.json'), routeCandidate);
  fs.writeFileSync(path.join(legacySettings, 'routes.json'), routeLegacy);
  fs.writeFileSync(path.join(candidateSettings, 'deployment-storage.json'), storageCandidate);
  fs.writeFileSync(path.join(candidateSettings, 'invalid.json'), invalidCandidate);
  fs.writeFileSync(path.join(legacySettings, 'invalid.json'), '{invalid-json');
  fs.writeFileSync(path.join(candidateSettings, 'directory.json'), directoryCandidate);
  fs.mkdirSync(path.join(legacySettings, 'directory.json'));

  const previousAppDataRoot = process.env.RIVET_APP_DATA_ROOT;
  const previousLegacyRoot = process.env.RIVET_APP_SETTINGS_LEGACY_ROOT;
  process.env.RIVET_APP_DATA_ROOT = candidateRoot;
  process.env.RIVET_APP_SETTINGS_LEGACY_ROOT = legacyRoot;
  const backend = new InMemoryAppSettingsBackend();
  const repositories = [
    createManagedTestRepository('partial-legacy-routes', path.join(candidateSettings, 'routes.json')),
    createManagedTestRepository('partial-legacy-storage', path.join(candidateSettings, 'deployment-storage.json')),
    createManagedTestRepository('partial-legacy-invalid', path.join(candidateSettings, 'invalid.json')),
    createManagedTestRepository('partial-legacy-directory', path.join(candidateSettings, 'directory.json')),
  ];
  const originalConsoleWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    await configureAppSettingsBackendForTests(backend);
    const [routes, storage, invalid, directory] = await Promise.all(
      repositories.map((repository) => repository.initialize()),
    );

    assert.equal(routes.value.nested.label, 'legacy-route');
    assert.equal(storage.value.nested.label, 'candidate-storage');
    assert.equal(invalid.value.nested.label, 'candidate-invalid-fallback');
    assert.equal(directory.value.nested.label, 'candidate-directory-fallback');
    assert.equal(warnings.length, 1);
    assert.equal(fs.readFileSync(path.join(legacySettings, 'routes.json'), 'utf8'), routeLegacy);
    assert.equal(fs.readFileSync(path.join(candidateSettings, 'routes.json'), 'utf8'), routeCandidate);
  } finally {
    console.warn = originalConsoleWarn;
    for (const repository of repositories) repository.dispose();
    await configureAppSettingsBackendForTests(null);
    if (previousAppDataRoot == null) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousAppDataRoot;
    if (previousLegacyRoot == null) delete process.env.RIVET_APP_SETTINGS_LEGACY_ROOT;
    else process.env.RIVET_APP_SETTINGS_LEGACY_ROOT = previousLegacyRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed settings writes stay successful when notification delivery fails', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const errors: unknown[] = [];
  await publishManagedSettingsChange(
    async (text, values) => {
      queries.push({ text, values });
      throw new Error('notification connection reset');
    },
    'oauth',
    12n,
    (error) => errors.push(error),
  );

  assert.deepEqual(queries, [{
    text: 'SELECT pg_notify($1, $2)',
    values: ['rivet_app_settings_changed', JSON.stringify({ key: 'oauth', revision: '12' })],
  }]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /notification connection reset/);
});

test('managed settings revisions are acknowledged only after subscribers refresh successfully', async () => {
  const knownRevisions = new Map<string, bigint>([['oauth', 4n]]);
  let attempts = 0;
  const notify = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('transient decrypt failure');
    }
  };

  assert.equal(await acknowledgeManagedSettingsRevision(knownRevisions, 'oauth', 5n, notify), false);
  assert.equal(knownRevisions.get('oauth'), 4n);
  assert.equal(await acknowledgeManagedSettingsRevision(knownRevisions, 'oauth', 5n, notify), true);
  assert.equal(knownRevisions.get('oauth'), 5n);
  assert.equal(attempts, 2);

  assert.equal(await acknowledgeManagedSettingsRevision(knownRevisions, 'oauth', 3n, notify), true);
  assert.equal(knownRevisions.get('oauth'), 5n);
  assert.equal(attempts, 2);
});
