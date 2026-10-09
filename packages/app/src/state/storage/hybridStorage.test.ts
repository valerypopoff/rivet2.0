import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allInitializeStoreFns,
  configureHybridStorageBackend,
  createHybridStorage,
  flushHybridStorageGroup,
  initializeWorkspaceRecovery,
} from './hybridStorage';
import { MemoryAsyncStorage } from './indexedDB.js';
import { initializeHybridStorage, memoryStorage } from './migrations.js';

describe('createHybridStorage', () => {
  it('continuous workspace edits checkpoint periodically and retain the final trailing edit', async (t) => {
    const oldMemory = new Map(memoryStorage);
    memoryStorage.clear();
    const backend = new MemoryAsyncStorage();
    const previous = configureHybridStorageBackend(backend);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    try {
      const { storage } = createHybridStorage('project');
      // There is never a full second of idle time in this editing burst.
      for (let edit = 0; edit < 10; edit++) {
        storage.setItem('marker', edit);
        t.mock.timers.tick(500);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const keys = await backend.listKeys('workspace-recovery/');
      assert.equal(keys.length, 1, 'Continuous edits must not postpone recovery indefinitely');
      assert.equal(JSON.parse((await backend.getItem(keys[0]!))!).groups.project.marker, 9);
      storage.setItem('marker', 'final');
      t.mock.timers.tick(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(JSON.parse((await backend.getItem(keys[0]!))!).groups.project.marker, 'final');
    } finally {
      configureHybridStorageBackend(previous);
      memoryStorage.clear();
      for (const [key, value] of oldMemory) memoryStorage.set(key, value);
    }
  });

  it('recovery checkpoints serialize the coherent workspace without separately serializing the project group', async (t) => {
    const oldMemory = new Map(memoryStorage);
    memoryStorage.clear();
    const backend = new MemoryAsyncStorage();
    const previous = configureHybridStorageBackend(backend);
    try {
      const { storage } = createHybridStorage('project');
      storage.setItem('marker', 'retained');
      const group = memoryStorage.get('project');
      const stringify = t.mock.method(JSON, 'stringify');
      await flushHybridStorageGroup('project');
      assert.equal(stringify.mock.calls.filter((call) => call.arguments[0] === group).length, 0);
      const key = (await backend.listKeys('workspace-recovery/'))[0]!;
      assert.equal(JSON.parse((await backend.getItem(key))!).groups.project.marker, 'retained');
    } finally {
      configureHybridStorageBackend(previous);
      memoryStorage.clear();
      for (const [key, value] of oldMemory) memoryStorage.set(key, value);
    }
  });
  it('a replaced backend cannot hydrate over its replacement after a delayed startup read', async () => {
    const key = 'grouped-stale-hydration';
    const before = new Set(allInitializeStoreFns);
    createHybridStorage(key);
    const initialize = [...allInitializeStoreFns].find((fn) => !before.has(fn))!;
    let release!: (value: string) => void;
    const first = new MemoryAsyncStorage();
    first.getItem = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const second = new MemoryAsyncStorage();
    await second.setItem(key, '{"selected":"second"}');
    const previous = configureHybridStorageBackend(first);
    try {
      const pending = initialize();
      configureHybridStorageBackend(second);
      await initialize();
      release('{"selected":"first"}');
      await pending;
      assert.deepEqual(memoryStorage.get(key), { selected: 'second' });
    } finally {
      configureHybridStorageBackend(previous);
      memoryStorage.delete(key);
    }
  });

  it('cancelled hydration ignores a late error and does not erase the currently selected group', async () => {
    const key = 'cancelled-hydration';
    const backend = new MemoryAsyncStorage();
    let fail!: (error: Error) => void;
    backend.getItem = () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      });
    memoryStorage.set(key, { selected: 'current' });
    let current = true;
    try {
      const pending = initializeHybridStorage(key, backend, () => current);
      assert.deepEqual(memoryStorage.get(key), { selected: 'current' });
      current = false;
      fail(new Error('obsolete storage read failed'));
      await pending;
      assert.deepEqual(memoryStorage.get(key), { selected: 'current' });
    } finally {
      memoryStorage.delete(key);
    }
  });

  it('malformed stored groups fail closed without discarding the previous in-memory authority', async () => {
    const key = 'invalid-hydration';
    const backend = new MemoryAsyncStorage();
    memoryStorage.set(key, { retained: true });
    try {
      for (const invalid of ['', 'null', 'false', '0', '[]']) {
        await backend.setItem(key, invalid);
        await assert.rejects(initializeHybridStorage(key, backend));
        assert.deepEqual(memoryStorage.get(key), { retained: true });
        assert.equal(await backend.getItem(key), invalid);
      }
    } finally {
      memoryStorage.delete(key);
    }
  });

  it('queued recovery captures the backend and workspace before reconfiguration', async () => {
    const oldMemory = new Map(memoryStorage);
    const first = new MemoryAsyncStorage();
    const second = new MemoryAsyncStorage();
    const write = first.setItem.bind(first);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.setItem = async (key, value) => {
      await gate;
      await write(key, value);
    };
    memoryStorage.clear();
    const previous = configureHybridStorageBackend(first);
    try {
      const { storage } = createHybridStorage('project');
      storage.setItem('marker', 'first');
      const pendingFirst = flushHybridStorageGroup('project');
      storage.setItem('marker', 'second');
      const pendingSecond = flushHybridStorageGroup('project');
      configureHybridStorageBackend(second);
      storage.setItem('marker', 'replacement');
      await flushHybridStorageGroup('project');
      release();
      await Promise.all([pendingFirst, pendingSecond]);
      const oldKey = (await first.listKeys('workspace-recovery/'))[0]!;
      const newKey = (await second.listKeys('workspace-recovery/'))[0]!;
      assert.equal(JSON.parse((await first.getItem(oldKey))!).groups.project.marker, 'second');
      assert.equal(JSON.parse((await second.getItem(newKey))!).groups.project.marker, 'replacement');
    } finally {
      release();
      configureHybridStorageBackend(previous);
      memoryStorage.clear();
      for (const [key, value] of oldMemory) memoryStorage.set(key, value);
    }
  });
  it('legacy import verifies a complete envelope and keeps original groups when interrupted', async () => {
    const oldMemory = new Map(memoryStorage);
    const backend = new MemoryAsyncStorage();
    const project = { projectState: { metadata: { id: 'a', title: 'A' }, graphs: {} } };
    const graph = { graphState: { nodes: [], connections: [] } };
    await backend.setItem('project', JSON.stringify(project));
    await backend.setItem('graph', JSON.stringify(graph));
    memoryStorage.clear();
    const previous = configureHybridStorageBackend(backend);
    try {
      // Import all groups first; no partial checkpoint has been published.
      const recovery = (await import('./hybridStorage.js')).getWorkspaceRecoveryStorage();
      await initializeHybridStorage('project', recovery);
      await initializeHybridStorage('graph', recovery);
      const read = backend.getItem.bind(backend);
      backend.getItem = async (key) => (key.startsWith('workspace-recovery/') ? null : read(key));
      await assert.rejects(initializeWorkspaceRecovery(), /read-back verification failed/);
      assert.equal(await backend.getItem('project'), JSON.stringify(project));
      assert.equal(await backend.getItem('graph'), JSON.stringify(graph));
      backend.getItem = read;
      await initializeWorkspaceRecovery();
      const checkpoint = JSON.parse((await backend.getItem(recovery.key))!);
      assert.deepEqual(checkpoint.groups, { project, graph });
    } finally {
      configureHybridStorageBackend(previous);
      memoryStorage.clear();
      for (const [key, value] of oldMemory) memoryStorage.set(key, value);
    }
  });
  it('explicit flush rejects backend errors and the next flush retries the latest snapshot', async () => {
    let fail = true;
    const writes: string[] = [];
    const { storage } = createHybridStorage('failed-flush', {
      getItem: async () => null,
      setItem: async (_key, value) => {
        if (fail) throw new Error('quota exceeded');
        writes.push(value);
      },
      removeItem: async () => {},
    });
    storage.setItem('value', 1);
    await assert.rejects(flushHybridStorageGroup('failed-flush'), /quota exceeded/);
    storage.setItem('value', 2);
    fail = false;
    await flushHybridStorageGroup('failed-flush');
    assert.deepEqual(writes, ['{"value":2}']);
  });
  it('buffers values in memory for grouped keys', () => {
    const writes: Array<{ key: string; value: string }> = [];
    const { storage } = createHybridStorage('grouped', {
      getItem: async () => null,
      setItem: async (key, value) => {
        writes.push({ key, value });
      },
      removeItem: async () => {},
    });

    storage.setItem('alpha', { value: 1 });
    storage.setItem('beta', { value: 2 });

    assert.deepEqual(storage.getItem('alpha', null), { value: 1 });
    assert.deepEqual(storage.getItem('beta', null), { value: 2 });
    assert.equal(writes.length, 0);
  });

  it('flushHybridStorageGroup immediately persists the latest grouped snapshot', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    const { storage } = createHybridStorage('grouped-flush', {
      getItem: async () => null,
      setItem: async (key, value) => {
        writes.push({ key, value });
      },
      removeItem: async () => {},
    });

    storage.setItem('alpha', { value: 1 });
    storage.setItem('beta', { value: 2 });

    await flushHybridStorageGroup('grouped-flush');

    assert.deepEqual(writes, [
      {
        key: 'grouped-flush',
        value: JSON.stringify({
          alpha: { value: 1 },
          beta: { value: 2 },
        }),
      },
    ]);
  });

  it('flushing after rapid writes persists the latest value and cancels stale debounced writes', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    const { storage } = createHybridStorage('grouped-cancel', {
      getItem: async () => null,
      setItem: async (key, value) => {
        writes.push({ key, value });
      },
      removeItem: async () => {},
    });

    storage.setItem('alpha', { value: 1 });
    storage.setItem('alpha', { value: 2 });

    await flushHybridStorageGroup('grouped-cancel');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(writes, [
      {
        key: 'grouped-cancel',
        value: JSON.stringify({
          alpha: { value: 2 },
        }),
      },
    ]);
  });

  it('registering the same grouped key more than once remains safe and flushes the latest state', async () => {
    const writesA: Array<{ key: string; value: string }> = [];
    const writesB: Array<{ key: string; value: string }> = [];
    const first = createHybridStorage('grouped-shared', {
      getItem: async () => null,
      setItem: async (key, value) => {
        writesA.push({ key, value });
      },
      removeItem: async () => {},
    });
    const second = createHybridStorage('grouped-shared', {
      getItem: async () => null,
      setItem: async (key, value) => {
        writesB.push({ key, value });
      },
      removeItem: async () => {},
    });

    first.storage.setItem('alpha', { value: 1 });
    second.storage.setItem('beta', { value: 2 });

    await flushHybridStorageGroup('grouped-shared');

    assert.deepEqual(writesA, []);
    assert.deepEqual(writesB, [
      {
        key: 'grouped-shared',
        value: JSON.stringify({
          alpha: { value: 1 },
          beta: { value: 2 },
        }),
      },
    ]);
  });

  it('registering the same grouped key more than once only registers one initialize function', () => {
    const initialSize = allInitializeStoreFns.size;

    createHybridStorage('grouped-init-shared', {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
    createHybridStorage('grouped-init-shared', {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });

    assert.equal(allInitializeStoreFns.size, initialSize + 1);
  });

  it('can persist grouped keys immediately when debouncing is disabled', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    const { storage } = createHybridStorage(
      'grouped-immediate',
      {
        getItem: async () => null,
        setItem: async (key, value) => {
          writes.push({ key, value });
        },
        removeItem: async () => {},
      },
      { debounceMs: 0 },
    );

    storage.setItem('alpha', { value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(writes, [
      {
        key: 'grouped-immediate',
        value: JSON.stringify({
          alpha: { value: 1 },
        }),
      },
    ]);
  });

  it('can swap the async storage backend before hosted initialization', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    createHybridStorage('grouped-host-storage');

    const previousBackend = configureHybridStorageBackend({
      getItem: async () => null,
      setItem: async (key, value) => {
        writes.push({ key, value });
      },
      removeItem: async () => {},
    });

    try {
      const { storage } = createHybridStorage('grouped-host-storage');
      storage.setItem('alpha', { value: 1 });
      await flushHybridStorageGroup('grouped-host-storage');

      assert.deepEqual(writes, [
        {
          key: 'grouped-host-storage',
          value: JSON.stringify({
            alpha: { value: 1 },
          }),
        },
      ]);
    } finally {
      configureHybridStorageBackend(previousBackend);
    }
  });

  it('resets hosted storage controllers to the built-in backend when storage is omitted', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    createHybridStorage('grouped-host-storage-reset');

    const previousBackend = configureHybridStorageBackend({
      getItem: async () => null,
      setItem: async (key, value) => {
        writes.push({ key, value });
      },
      removeItem: async () => {},
    });

    try {
      const { storage } = createHybridStorage('grouped-host-storage-reset');
      storage.setItem('alpha', { value: 1 });
      await flushHybridStorageGroup('grouped-host-storage-reset');

      configureHybridStorageBackend(undefined);
      storage.setItem('beta', { value: 2 });
      await flushHybridStorageGroup('grouped-host-storage-reset');

      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0], {
        key: 'grouped-host-storage-reset',
        value: JSON.stringify({
          alpha: { value: 1 },
        }),
      });
    } finally {
      configureHybridStorageBackend(previousBackend);
    }
  });
});
