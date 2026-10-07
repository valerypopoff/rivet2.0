import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAsyncStorage } from './indexedDB.js';
import { parseRecoveryCheckpoint, WorkspaceRecoveryStorage, validateRecoveryGroups } from './workspaceRecovery.js';
import { initializeHybridStorage, memoryStorage } from './migrations.js';

// Simulates a persistent host shared by recreated documents. The real memory
// fallback deliberately cannot certify survival across page reloads.
class PersistentTestStorage extends MemoryAsyncStorage {
  override readonly persistsAcrossReload: boolean = true;
}

function session(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test('reload and duplicate documents fork committed recovery without overwriting their source', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  let groups = {
    project: { projectState: { metadata: { id: 'a', title: 'A' }, graphs: {} } },
    graph: { graphState: { nodes: [], connections: [], metadata: { id: 'a-graph' } } },
  };
  const first = new WorkspaceRecoveryStorage(backend, () => groups, { session: tabSession, id: 'first' });
  first.changed();
  await first.setItem('project', '{}');
  const initial = await backend.getItem(first.key);
  const duplicateSession = session();
  duplicateSession.setItem('rivet-workspace-recovery-v1', first.key);
  const reload = new WorkspaceRecoveryStorage(backend, () => groups, { session: tabSession, id: 'reload' });
  const duplicate = new WorkspaceRecoveryStorage(backend, () => ({ project: { edited: 'other window' } }), {
    session: duplicateSession,
    id: 'duplicate',
  });
  assert.equal(await reload.getItem('graph'), JSON.stringify(groups.graph));
  assert.equal(await duplicate.getItem('project'), JSON.stringify(groups.project));
  groups = {
    project: { projectState: { metadata: { id: 'b', title: 'B' }, graphs: {} } },
    graph: { graphState: { nodes: [], connections: [], metadata: { id: 'b-graph' } } },
  };
  reload.changed();
  duplicate.changed();
  await Promise.all([reload.setItem('graph', '{}'), duplicate.setItem('project', '{}')]);
  assert.equal(await backend.getItem(first.key), initial);
  assert.deepEqual(parseRecoveryCheckpoint((await backend.getItem(reload.key))!).groups, groups);
  assert.deepEqual(parseRecoveryCheckpoint((await backend.getItem(duplicate.key))!).groups, {
    project: { edited: 'other window' },
  });
});

test('recovery failure rejects, leaves the previous pointer intact, and can be retried', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  await backend.setItem('project', '{"legacy":true}');
  let fail = true;
  const setItem = backend.setItem.bind(backend);
  backend.setItem = async (key, value) => {
    if (fail) throw new Error('quota exceeded');
    await setItem(key, value);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { recovered: true }, graph: {} }), {
    session: tabSession,
    id: 'retry',
  });
  assert.equal(await recovery.getItem('project'), '{"legacy":true}');
  recovery.changed();
  await assert.rejects(recovery.setItem('project', '{}'), /quota exceeded/);
  assert.equal(recovery.getHealth().status, 'unavailable');
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  fail = false;
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().status, 'saved');
  assert.equal(await backend.getItem('project'), '{"legacy":true}');
});

test('an older commit does not mark newer edits durable', async () => {
  const backend = new PersistentTestStorage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = backend.setItem.bind(backend);
  backend.setItem = async (key, value) => {
    await gate;
    await write(key, value);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: {} }), { id: 'pending' });
  recovery.changed();
  const pending = recovery.setItem('project', '{}');
  recovery.changed();
  release();
  await pending;
  assert.equal(recovery.getHealth().status, 'pending');
  assert.equal(recovery.getHealth().committedRevision, 1);
  await recovery.setItem('graph', '{}');
  assert.equal(recovery.getHealth().status, 'saved');
});

test('a checkpoint serialization failure is visible and leaves committed recovery intact', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const group: Record<string, unknown> = { valid: true };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: group }), {
    session: tabSession,
    id: 'serialize',
  });
  await recovery.setItem('project', '{}');
  const committed = await backend.getItem(recovery.key);
  group.circular = group;
  recovery.changed();
  await assert.rejects(recovery.setItem('graph', '{}'), /circular/i);
  assert.equal(recovery.getHealth().status, 'unavailable');
  assert.equal(await backend.getItem(recovery.key), committed);
  delete group.circular;
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().status, 'saved');
});

test('corrupt or missing selected recovery never falls back to legacy data', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  await backend.setItem('project', '{"legacy":true}');
  tabSession.setItem('rivet-workspace-recovery-v1', 'workspace-recovery/v1/bad');
  await backend.setItem('workspace-recovery/v1/bad', '{"version":9}');
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession, id: 'current' });
  await assert.rejects(recovery.getItem('project'), /Invalid workspace recovery/);
  assert.equal((await recovery.listRecoveries())[0]?.invalid, true);
  await recovery.selectRecovery(null);
  const empty = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession, id: 'empty' });
  assert.equal(await empty.getItem('project'), null);
  assert.equal(await backend.getItem('project'), '{"legacy":true}');
  await backend.removeItem('workspace-recovery/v1/bad');
  tabSession.setItem('rivet-workspace-recovery-v1', 'workspace-recovery/v1/bad');
  const missing = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession, id: 'missing' });
  await assert.rejects(missing.getItem('project'), /checkpoint is missing/);
});

test('a checkpoint never combines a missing group with legacy graph state', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  await backend.setItem('graph', '{"oldGraph":true}');
  const original = new WorkspaceRecoveryStorage(backend, () => ({ project: { current: true } }), {
    session: tabSession,
    id: 'coherent',
  });
  await original.setItem('project', '{}');
  const reload = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession, id: 'coherent-reload' });
  assert.equal(await reload.getItem('graph'), null);
  assert.equal(await reload.getItem('project'), '{"current":true}');
});

test('bootstrap does not fill an empty selected checkpoint from legacy localStorage', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const legacy = session();
  legacy.setItem('graph', '{"legacyGraph":true}');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: legacy, configurable: true });
  try {
    const original = new WorkspaceRecoveryStorage(backend, () => ({ project: {} }), {
      session: tabSession,
      id: 'bootstrap-source',
    });
    await original.setItem('project', '{}');
    const reload = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession, id: 'bootstrap-reload' });
    memoryStorage.set('graph', { previous: true });
    await initializeHybridStorage('graph', reload);
    assert.equal(memoryStorage.has('graph'), false);
  } finally {
    memoryStorage.delete('graph');
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('an in-flight checkpoint cannot overwrite an explicit recovery selection', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  await backend.setItem(
    'workspace-recovery/v1/other',
    JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: {} }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = backend.setItem.bind(backend);
  backend.setItem = async (key, value) => {
    if (key === 'workspace-recovery/v1/retired') await gate;
    await write(key, value);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { old: true } }), {
    session: tabSession,
    id: 'retired',
  });
  const pending = recovery.setItem('project', '{}');
  await recovery.selectRecovery('workspace-recovery/v1/other');
  release();
  await pending;
  const selectedKey = tabSession.getItem('rivet-workspace-recovery-v1')!;
  assert.notEqual(selectedKey, recovery.key);
  assert.equal(await backend.getItem(selectedKey), await backend.getItem('workspace-recovery/v1/other'));
  await assert.rejects(recovery.setItem('project', '{}'), /Reload before editing/);
});

test('read-back failure never publishes a recovery reference or a saved acknowledgement', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const write = backend.setItem.bind(backend);
  backend.setItem = async () => {};
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { legacy: true } }), {
    session: tabSession,
    id: 'verified-import',
  });
  recovery.changed();
  await assert.rejects(recovery.setItem('project', '{}'), /read-back verification failed/);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  assert.equal(recovery.getHealth().committedRevision, 0);
  assert.equal(recovery.getHealth().status, 'unavailable');
  await assert.rejects(recovery.selectRecovery(null), /read-back verification failed/);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  backend.setItem = write;
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().status, 'saved');
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), recovery.key);
});

test('malformed workspace authorities fail closed instead of becoming empty or clean defaults', () => {
  const project = { metadata: { id: 'a', title: 'A' }, graphs: {} };
  const valid = { project: { projectState: project }, graph: { graphState: { nodes: [], connections: [] } } };
  validateRecoveryGroups(valid);
  const invalidGroups: Array<Record<string, Record<string, unknown>>> = [
    { project: { projectState: null } },
    { project: { projectState: { metadata: { id: 'a' } } } },
    { project: { projectState: project, projectDataState: { bad: 42 } } },
    { project: { openedProjectSnapshotsState: { b: { project } } } },
    { project: { projectsState: { openedProjects: {}, openedProjectsSortedIds: ['missing'] } } },
    { project: { projectUnsavedChangesState: { a: 'false' } } },
    { ...valid, graph: { graphState: { nodes: null, connections: [] } } },
    { graph: valid.graph },
  ];
  for (const groups of invalidGroups) {
    assert.throws(() => validateRecoveryGroups(groups), /Invalid workspace recovery/);
  }
});

test('unavailable session storage is explicit while the committed checkpoint remains discoverable', async () => {
  const backend = new PersistentTestStorage();
  const blocked = session();
  blocked.getItem = () => {
    throw new Error('blocked');
  };
  blocked.setItem = () => {
    throw new Error('blocked');
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: {} }), { session: blocked, id: 'blocked' });
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().reloadAvailable, false);
  assert.equal(recovery.getHealth().status, 'saved');
  assert.equal((await recovery.listRecoveries())[0]!.key, recovery.key);
});

test('automatic reload recovery becomes available again after a transient session-storage failure', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const write = tabSession.setItem;
  let blocked = true;
  tabSession.setItem = (key, value) => {
    if (blocked) throw new Error('session storage unavailable');
    write(key, value);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: {} }), { session: tabSession });
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().reloadAvailable, false);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  blocked = false;
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().status, 'saved');
  assert.equal(recovery.getHealth().reloadAvailable, true);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), recovery.key);
});

test('a replaced backend writer cannot overwrite its replacement or redirect reload after late IO', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const first = new WorkspaceRecoveryStorage(backend, () => ({ project: { tenant: 'first' } }), {
    session: tabSession,
  });
  const second = new WorkspaceRecoveryStorage(backend, () => ({ project: { tenant: 'second' } }), {
    session: tabSession,
  });
  assert.notEqual(first.key, second.key);
  const write = backend.setItem.bind(backend);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.setItem = async (key, value) => {
    if (key === first.key) await gate;
    await write(key, value);
  };
  const pending = first.setItem('project', '{}');
  first.setSelected(false);
  await second.setItem('project', '{}');
  release();
  await pending;
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), second.key);
  assert.equal(parseRecoveryCheckpoint((await backend.getItem(second.key))!).groups.project!.tenant, 'second');
});

test('reinitializing an already-used backend restores its own latest checkpoint, not the original legacy import', async () => {
  const backend = new PersistentTestStorage();
  await backend.setItem('project', '{"legacy":true}');
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { edited: true } }));
  assert.equal(await recovery.getItem('project'), '{"legacy":true}');
  await recovery.setItem('project', '{}');
  assert.equal(recovery.hasSelectedCheckpoint, true);
  assert.equal(await recovery.getItem('project'), '{"edited":true}');
  assert.equal(await recovery.getItem('graph'), null);
});

test('transient checkpoint reads can retry without falling back to stale legacy data', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const key = 'workspace-recovery/v1/read-retry';
  await backend.setItem(
    key,
    JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: { project: { current: true } } }),
  );
  await backend.setItem('project', '{"stale":true}');
  tabSession.setItem('rivet-workspace-recovery-v1', key);
  const read = backend.getItem.bind(backend);
  let blocked = true;
  backend.getItem = async (key) => {
    if (blocked) throw new Error('temporary database failure');
    return read(key);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  await assert.rejects(recovery.getItem('project'), /temporary database failure/);
  blocked = false;
  assert.equal(await recovery.getItem('project'), '{"current":true}');
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), key);
});

test('empty or malformed selected references are not missing-data permission to import legacy state', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  await backend.setItem('project', '{"stale":true}');
  for (const key of ['', 'unrecognized', 'workspace-recovery/v1/']) {
    tabSession.setItem('rivet-workspace-recovery-v1', key);
    const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
    await assert.rejects(recovery.getItem('project'), /Invalid recovery reference|checkpoint is missing/);
    assert.equal(await backend.getItem('project'), '{"stale":true}');
    assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), key);
  }
});

test('an inaccessible reload reference never authorizes a legacy import and can be retried', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const key = 'workspace-recovery/v1/reference-retry';
  await backend.setItem(
    key,
    JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: { project: { current: true } } }),
  );
  await backend.setItem('project', '{"stale":true}');
  tabSession.setItem('rivet-workspace-recovery-v1', key);
  const read = tabSession.getItem;
  let blocked = true;
  tabSession.getItem = (key) => {
    if (blocked) throw new Error('session storage blocked');
    return read(key);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  await assert.rejects(recovery.getItem('project'), /recovery reference is unavailable/);
  assert.equal(await backend.getItem('project'), '{"stale":true}');
  blocked = false;
  assert.equal(await recovery.getItem('project'), '{"current":true}');
});

test('an inaccessible session-storage object is unknown authority, not a fresh empty workspace', async () => {
  const backend = new PersistentTestStorage();
  await backend.setItem('project', '{"stale":true}');
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { sessionUnavailable: true });
  await assert.rejects(recovery.getItem('project'), /recovery reference is unavailable/);
  assert.equal(await backend.getItem('project'), '{"stale":true}');
});

test('a temporarily inaccessible session-storage object can be reacquired without importing stale legacy data', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const key = 'workspace-recovery/v1/reacquired-session';
  const raw = JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: { project: { selected: true } } });
  await backend.setItem(key, raw);
  await backend.setItem('project', '{"stale":true}');
  tabSession.setItem('rivet-workspace-recovery-v1', key);
  let blocked = true;
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { edited: true } }), {
    sessionUnavailable: true,
    resolveSession: () => {
      if (blocked) throw new Error('Session access blocked');
      return tabSession;
    },
  });
  await assert.rejects(recovery.getItem('project'), /recovery reference is unavailable/);
  blocked = false;
  assert.equal(await recovery.getItem('project'), '{"selected":true}');
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), key);
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().reloadAvailable, true);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), recovery.key);
  assert.equal(await backend.getItem(key), raw);
});

test('a late failed source read cannot erase a newer committed checkpoint', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const key = 'workspace-recovery/v1/old-read';
  tabSession.setItem('rivet-workspace-recovery-v1', key);
  const read = backend.getItem.bind(backend);
  let rejectRead!: (error: Error) => void;
  backend.getItem = async (requested) => {
    if (requested === key)
      return new Promise<string>((_resolve, reject) => {
        rejectRead = reject;
      });
    return read(requested);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { edited: true } }), {
    session: tabSession,
  });
  const failed = assert.rejects(recovery.getItem('project'), /old read failed/);
  await recovery.setItem('project', '{}');
  rejectRead(new Error('old read failed'));
  await failed;
  assert.equal(await recovery.getItem('project'), '{"edited":true}');
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), recovery.key);
});

test('a late older recovery choice cannot replace the newer explicit selection', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const first = 'workspace-recovery/v1/first-choice';
  const second = 'workspace-recovery/v1/second-choice';
  const record = JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: {} });
  await backend.setItem(first, record);
  await backend.setItem(second, record);
  const read = backend.getItem.bind(backend);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.getItem = async (key) => {
    if (key === first) await gate;
    return read(key);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  const stale = assert.rejects(recovery.selectRecovery(first), /Recovery selection changed/);
  await recovery.selectRecovery(second);
  release();
  await stale;
  const selectedKey = tabSession.getItem('rivet-workspace-recovery-v1')!;
  assert.notEqual(selectedKey, first);
  assert.notEqual(selectedKey, second);
  assert.equal(await backend.getItem(selectedKey), await read(second));
});

test('switching providers invalidates an in-flight recovery choice even if the original provider is reselected', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  const key = 'workspace-recovery/v1/delayed-choice';
  const record = JSON.stringify({ version: 1, revision: 0, updatedAt: '', groups: {} });
  await backend.setItem(key, record);
  const read = backend.getItem.bind(backend);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.getItem = async (key) => {
    await gate;
    return read(key);
  };
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  const stale = assert.rejects(recovery.selectRecovery(key), /Recovery selection changed/);
  recovery.setSelected(false);
  recovery.setSelected(true);
  release();
  await stale;
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  assert.equal(recovery.retired, false);
  await recovery.selectRecovery(key);
  assert.notEqual(tabSession.getItem('rivet-workspace-recovery-v1'), key);
  assert.equal(await read(tabSession.getItem('rivet-workspace-recovery-v1')!), record);
});

test('memory-only storage never advertises reload safety or publishes a dead reload reference', async () => {
  const backend = new MemoryAsyncStorage();
  const tabSession = session();
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({ project: { temporary: true } }), {
    session: tabSession,
  });
  assert.equal(recovery.persistsAcrossReload, false);
  assert.equal(recovery.getHealth().reloadAvailable, false);
  await recovery.setItem('project', '{}');
  assert.equal(recovery.getHealth().reloadAvailable, false);
  assert.equal(tabSession.getItem('rivet-workspace-recovery-v1'), null);
  await assert.rejects(recovery.selectRecovery(null), /Memory-only recovery/);
  assert.equal(recovery.retired, false);
});

test('selecting the current writer freezes its bytes against an already queued checkpoint', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  let groups = { project: { selected: 'original' } };
  const recovery = new WorkspaceRecoveryStorage(backend, () => groups, { session: tabSession });
  await recovery.setItem('project', '{}');
  const original = await backend.getItem(recovery.key);
  const write = backend.setItem.bind(backend);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.setItem = async (key, value) => {
    if (key === recovery.key) await gate;
    await write(key, value);
  };
  groups = { project: { selected: 'newer' } };
  const pending = recovery.setItem('project', '{}');
  await recovery.selectRecovery(recovery.key);
  const selectedKey = tabSession.getItem('rivet-workspace-recovery-v1')!;
  assert.notEqual(selectedKey, recovery.key);
  release();
  await pending;
  assert.equal(await backend.getItem(selectedKey), original);
  assert.equal(parseRecoveryCheckpoint((await backend.getItem(recovery.key))!).groups.project!.selected, 'newer');
  const reload = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  assert.equal(await reload.getItem('project'), '{"selected":"original"}');
});

test('selecting another live window freezes its checkpoint without retiring that independent writer', async () => {
  const backend = new PersistentTestStorage();
  const tabSession = session();
  let groups = { project: { selected: 'original' } };
  const other = new WorkspaceRecoveryStorage(backend, () => groups);
  await other.setItem('project', '{}');
  const original = await backend.getItem(other.key);
  const recovery = new WorkspaceRecoveryStorage(backend, () => ({}), { session: tabSession });
  await recovery.selectRecovery(other.key);
  const selectedKey = tabSession.getItem('rivet-workspace-recovery-v1')!;
  groups = { project: { selected: 'other window edited later' } };
  await other.setItem('project', '{}');
  assert.equal(other.retired, false);
  assert.equal(await backend.getItem(selectedKey), original);
  assert.notEqual(await backend.getItem(other.key), original);
});
