import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAsyncStorage } from './indexedDB.js';
import { WorkspaceRecoveryDataError, WorkspaceRecoveryStorage } from './workspaceRecovery.js';
import { retryWorkspaceInitialization, startWorkspaceRecoveryRetry } from './workspaceRecoveryRetry.js';

class PersistentTestStorage extends MemoryAsyncStorage {
  override readonly persistsAcrossReload: boolean = true;
}

test('default retry timers do not invoke native browser APIs with an invalid receiver', (t) => {
  let scheduled = 0;
  t.mock.method(globalThis, 'setTimeout', function (this: unknown) {
    assert.ok(this === undefined || this === globalThis);
    scheduled++;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  t.mock.method(globalThis, 'clearTimeout', function (this: unknown) {
    assert.ok(this === undefined || this === globalThis);
  });
  const recovery = new WorkspaceRecoveryStorage(new PersistentTestStorage(), () => ({}));
  const retry = startWorkspaceRecoveryRetry(
    recovery,
    async () => {},
    () => {},
  );
  try {
    recovery.failed();
    assert.equal(scheduled, 1);
  } finally {
    retry.stop();
  }
});

function fixture() {
  const backend = new PersistentTestStorage();
  const values = new Map<string, string>();
  const session = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  } satisfies Storage;
  let data = 'original';
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { data } }), { session });
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  const timers = {
    schedule: ((callback: () => void, delay: number) => {
      tasks.set(++id, { callback, delay });
      return id;
    }) as typeof setTimeout,
    cancel: ((key: number) => tasks.delete(key)) as typeof clearTimeout,
  };
  const warnings: boolean[] = [];
  let calls = 0;
  const retry = startWorkspaceRecoveryRetry(
    recovery,
    async () => {
      calls++;
      await recovery.setItem('project', '{}');
    },
    (warning) => warnings.push(warning),
    timers,
  );
  return {
    backend,
    session,
    recovery,
    retry,
    tasks,
    warnings,
    calls: () => calls,
    edit: (next: string) => {
      data = next;
      recovery.changed();
    },
    next: async () => {
      const [key, task] = [...tasks][0]!;
      tasks.delete(key);
      task.callback();
      // The recovery queue and read-back verification span multiple microtasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return task.delay;
    },
  };
}

test('automatic recovery retries the latest edits without exposing a temporary failure', async () => {
  const f = fixture();
  try {
    const write = f.backend.setItem.bind(f.backend);
    f.backend.setItem = async () => {
      throw new Error('Temporary failure');
    };
    await assert.rejects(f.recovery.setItem('project', '{}'));
    f.edit('latest');
    f.backend.setItem = write;
    assert.equal(await f.next(), 250);
    assert.equal(f.calls(), 1);
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(f.warnings.some(Boolean), false);
    assert.equal(JSON.parse((await f.backend.getItem(f.recovery.key))!).groups.project.data, 'latest');
    assert.equal(f.tasks.size, 0);
  } finally {
    f.retry.stop();
  }
});

test('persistent failures back off and later recover even without another edit', async () => {
  const f = fixture();
  try {
    const write = f.backend.setItem.bind(f.backend);
    f.backend.setItem = async () => {
      throw new Error('Quota');
    };
    await assert.rejects(f.recovery.setItem('project', '{}'));
    assert.equal(await f.next(), 250);
    assert.equal(await f.next(), 1_000);
    assert.equal(await f.next(), 2_500);
    assert.equal(f.warnings.at(-1), true);
    f.backend.setItem = write;
    assert.equal(await f.next(), 30_000);
    assert.equal(f.warnings.at(-1), false);
    assert.equal(f.tasks.size, 0);
    assert.equal(f.recovery.getHealth().reloadAvailable, true);
  } finally {
    f.retry.stop();
  }
});

test('pointer-only failure retries automatically and does not overlap attempts', async () => {
  const f = fixture();
  try {
    const write = f.session.setItem;
    f.session.setItem = () => {
      throw new Error('Session unavailable');
    };
    await f.recovery.setItem('project', '{}');
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(f.recovery.getHealth().reloadAvailable, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = f.backend.setItem.bind(f.backend);
    f.backend.setItem = async (key, value) => {
      await gate;
      await put(key, value);
    };
    f.retry.retryNow();
    f.retry.retryNow();
    await Promise.resolve();
    assert.equal(f.calls(), 1);
    assert.equal(f.tasks.size, 0);
    f.session.setItem = write;
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.recovery.getHealth().reloadAvailable, true);
    assert.equal(f.warnings.some(Boolean), false);
  } finally {
    f.retry.stop();
  }
});

test('stopping automatic recovery cancels timers and ignores an in-flight failure', async () => {
  const f = fixture();
  f.recovery.failed();
  let fail!: (error: Error) => void;
  f.backend.setItem = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  f.retry.retryNow();
  await Promise.resolve();
  f.retry.stop();
  const previous = [...f.warnings];
  fail(new Error('Late failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.warnings, previous);
  assert.equal(f.tasks.size, 0);
  f.retry.retryNow();
  assert.equal(f.calls(), 1);
});

test('retired and memory-only recovery cannot trigger background writes', async () => {
  for (const ephemeral of [false, true]) {
    const backend = ephemeral ? new MemoryAsyncStorage() : new PersistentTestStorage();
    const recovery = new WorkspaceRecoveryStorage(backend, () => ({}));
    if (!ephemeral) {
      // Retire through the real explicit selection protocol.
      const session = { getItem: () => null, setItem: () => {} } as unknown as Storage;
      const retired = new WorkspaceRecoveryStorage(backend, () => ({}), { session });
      await retired.selectRecovery(null);
      recovery.setSelected(false);
      let writes = 0;
      const retry = startWorkspaceRecoveryRetry(
        retired,
        async () => {
          writes++;
        },
        () => {},
      );
      retired.failed();
      retry.retryNow();
      retry.stop();
      assert.equal(writes, 0);
    } else {
      let writes = 0;
      const retry = startWorkspaceRecoveryRetry(
        recovery,
        async () => {
          writes++;
        },
        () => {},
      );
      recovery.failed();
      retry.retryNow();
      retry.stop();
      assert.equal(writes, 0);
    }
  }
});

test('bootstrap retries transient IO but preserves invalid authority and cancels obsolete owners', async () => {
  let calls = 0;
  const delays: number[] = [];
  await retryWorkspaceInitialization(
    async () => {
      if (++calls < 3) throw new Error('Transient read');
    },
    () => true,
    async (delay) => {
      delays.push(delay);
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 1_000]);
  calls = 0;
  await assert.rejects(
    retryWorkspaceInitialization(
      async () => {
        calls++;
        throw new WorkspaceRecoveryDataError('Corrupt checkpoint retained');
      },
      () => true,
    ),
    /Corrupt/,
  );
  assert.equal(calls, 1);
  let current = true;
  calls = 0;
  await retryWorkspaceInitialization(
    async () => {
      calls++;
      throw new Error('Old read');
    },
    () => current,
    async () => {
      current = false;
    },
  );
  assert.equal(calls, 1);
});
