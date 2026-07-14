import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runWithAppSettingsSnapshot,
  SettingsRevisionConflictError,
  VersionedSettingsRepository,
  type SettingsRepositoryDescriptor,
} from '../app-settings/settings-repository.js';

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
