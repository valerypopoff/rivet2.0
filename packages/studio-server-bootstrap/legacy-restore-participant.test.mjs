import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { startRestoreParticipant, blocksRestoreServing } from './legacy-restore-participant.mjs';

const settings = {
  storageMode: 'managed',
  databaseMode: 'managed',
  databaseConnectionString: 'postgres://fixture:fixture@127.0.0.1:5432/rivet',
  databaseSslMode: 'disable',
  objectStorageBucket: 'fixture',
  objectStorageRegion: 'us-east-1',
  objectStoragePrefix: 'owned/',
  objectStorageForcePathStyle: true,
  storageAccessKeyId: 'fixture',
  storageAccessKey: 'fixture',
};
test('executor restore lease drains full activity once before releasing and closes its owner', async () => {
  let activity = 1;
  let disposed = 0;
  let released = 0;
  let closed = 0;
  const queries = [];
  const old = globalThis.__rivetLegacyRestoreEditorActivity;
  globalThis.__rivetLegacyRestoreEditorActivity = () => activity;
  const client = Object.assign(new EventEmitter(), {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [] };
    },
    release: () => released++,
  });
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [{ name: null }] }),
    end: async () => {
      closed++;
    },
  };
  try {
    const stop = await startRestoreParticipant(
      settings,
      async () => {
        disposed++;
      },
      () => pool,
    );
    const pending = stop();
    assert.equal(stop(), pending);
    assert.equal(released, 0);
    assert.equal(globalThis.__rivetLegacyRestorePaused, true);
    activity = 0;
    await pending;
    assert.equal(disposed, 1);
    assert.equal(released, 1);
    assert.equal(closed, 1);
    assert.equal(queries.filter((sql) => sql.includes('unlock_shared')).length, 1);
  } finally {
    globalThis.__rivetLegacyRestoreEditorActivity = old;
    delete globalThis.__rivetLegacyRestorePaused;
  }
});
test('executor cannot start under destructive failure and failed connections close their pool', async () => {
  assert.equal(blocksRestoreServing({ phase: 'failed', destructive: true }), true);
  assert.equal(blocksRestoreServing({ phase: 'failed', destructive: false }), false);
  let ended = 0;
  await assert.rejects(
    startRestoreParticipant(
      settings,
      async () => {},
      () => ({
        connect: async () => {
          throw new Error('Unavailable');
        },
        end: async () => {
          ended++;
        },
      }),
    ),
    /Unavailable/,
  );
  assert.equal(ended, 1);
});

test('a drained editor remains fenced through warmup and completion until its supervisor owns the restart', async () => {
  let tick;
  const interval = mock.method(globalThis, 'setInterval', (callback) => {
    tick = callback;
    return { unref() {} };
  });
  let signals = 0;
  const kill = mock.method(process, 'kill', () => {
    signals++;
    return true;
  });
  const previousInstallation = process.env.RIVET_LEGACY_RESTORE_INSTALLATION;
  process.env.RIVET_LEGACY_RESTORE_INSTALLATION = 'fixture';
  let journal = null;
  let drains = 0;
  let unlocks = 0;
  const client = Object.assign(new EventEmitter(), {
    query: async (sql) => {
      if (sql.includes('unlock_shared')) unlocks++;
      return { rows: [] };
    },
    release() {},
  });
  let dispose;
  try {
    dispose = await startRestoreParticipant(
      settings,
      async () => {
        drains++;
      },
      () => ({
        connect: async () => client,
        query: async (sql) => ({
          rows: [
            sql.includes('to_regclass')
              ? { name: 'operation' }
              : sql.includes('deployment')
                ? { deployment: 'fixture' }
                : { journal },
          ],
        }),
        end: async () => {},
      }),
    );
    for (const phase of ['draining', 'restarting', 'completed']) {
      journal = { phase, destructive: phase !== 'draining' };
      tick();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(globalThis.__rivetLegacyRestorePaused, true);
      assert.equal(signals, 0, `${phase} must not race the API's supervisor restart`);
    }
    assert.equal(drains, 1);
    assert.equal(unlocks, 1);
  } finally {
    await dispose?.();
    interval.mock.restore();
    kill.mock.restore();
    if (previousInstallation === undefined) delete process.env.RIVET_LEGACY_RESTORE_INSTALLATION;
    else process.env.RIVET_LEGACY_RESTORE_INSTALLATION = previousInstallation;
    delete globalThis.__rivetLegacyRestorePaused;
  }
});

test('a polling result arriving after disposal cannot signal or restart the executor', async () => {
  let tick;
  const interval = mock.method(globalThis, 'setInterval', (callback) => {
    tick = callback;
    return { unref() {} };
  });
  let signals = 0;
  const kill = mock.method(process, 'kill', () => {
    signals++;
    return true;
  });
  let resolveRead;
  const pending = new Promise((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [] }),
    release: () => {},
  });
  const pool = {
    connect: async () => client,
    query: async () => (++reads === 1 ? { rows: [{ name: null }] } : pending),
    end: async () => {},
  };
  let stop;
  try {
    stop = await startRestoreParticipant(
      settings,
      async () => {},
      () => pool,
    );
    tick();
    await stop();
    resolveRead({ rows: [{ name: null }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signals, 0);
    assert.equal(client.listenerCount('error'), 0);
  } finally {
    resolveRead({ rows: [{ name: null }] });
    await stop?.();
    kill.mock.restore();
    interval.mock.restore();
    delete globalThis.__rivetLegacyRestorePaused;
  }
});

test('losing the serving lease immediately fails the generation instead of gracefully continuing active writes', async () => {
  const oldActivity = globalThis.__rivetLegacyRestoreEditorActivity;
  globalThis.__rivetLegacyRestoreEditorActivity = () => 1;
  let exits = [];
  const exit = mock.method(process, 'exit', (code) => {
    exits.push(code);
  });
  let signals = 0;
  const kill = mock.method(process, 'kill', () => {
    signals++;
    return true;
  });
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [] }),
    release: () => {},
  });
  let stop;
  try {
    stop = await startRestoreParticipant(
      settings,
      async () => {},
      () => ({
        connect: async () => client,
        query: async () => ({ rows: [{ name: null }] }),
        end: async () => {},
      }),
    );
    client.emit('error', new Error('Connection lost; PostgreSQL released the session lock'));
    assert.equal(globalThis.__rivetLegacyRestorePaused, true);
    assert.deepEqual(exits, [1]);
    assert.equal(signals, 0, 'Graceful SIGTERM would leave accepted writes running after losing protection.');
  } finally {
    globalThis.__rivetLegacyRestoreEditorActivity = () => 0;
    await stop?.();
    globalThis.__rivetLegacyRestoreEditorActivity = oldActivity;
    exit.mock.restore();
    kill.mock.restore();
    delete globalThis.__rivetLegacyRestorePaused;
  }
});
