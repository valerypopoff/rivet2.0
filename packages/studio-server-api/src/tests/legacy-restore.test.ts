import assert from 'node:assert/strict';
// test-style: fixture-read: Reads only test-owned temporary backup and runtime artifacts, never implementation text.
import { test, mock } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { validateLegacyArchivePath } from '../legacy-restore/archive.js';
import {
  validateRestoreObjectKey,
  clearRestoreTables,
  clearRestoreObjects,
  captureRestoreObjects,
  assertRestoreTableBoundary,
  LEGACY_RESTORE_TABLES,
} from '../legacy-restore/scope.js';
import {
  restoreBlocksServing,
  restoreOperationSchema,
  LegacyRestoreControl,
  acquireRestoreServingLease,
} from '../legacy-restore/control.js';
import type { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { prepareLegacyArchive, resetRestoreScratch } from '../legacy-restore/archive.js';
import { isNativeExecutableHeader, assertPortableRuntimeTree } from '../legacy-restore/native-runtime.js';
import {
  legacyRestoreRequestBarrier,
  setLegacyRestoreWorkspaceEpoch,
  setLegacyRestorePaused,
  setLegacyRestoreWarmup,
  buildRestoreSettings,
  LegacyRestoreService,
} from '../legacy-restore/service.js';
import { normalizeExtractedRuntimeLayout } from '../legacy-restore/runtime-layout.js';
import { restoreValidationFailureMessage } from '../legacy-restore/import-worker.js';
import {
  createRuntimeLibraryDirectoryArchive,
  assertRuntimeLibraryArchiveSpace,
} from '../scripts/migrate-runtime-libraries.js';
import { retainOrdinaryReceiveDeadline } from '../legacy-restore/receive-deadline.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('schema preparation checks existing installation ownership without changing DDL', async () => {
  for (const state of ['empty', 'owned', 'foreign', 'partial']) {
    const control = new LegacyRestoreControl({}, 'fixture');
    const statements: string[] = [];
    const query = mock.method(control.pool, 'query', async (sql: string) => {
      statements.push(sql);
      if (sql.includes('to_regclass'))
        return {
          rows: [
            {
              installation: state === 'empty' ? null : 'installation',
              operation: state === 'empty' || state === 'partial' ? null : 'operation',
            },
          ],
        };
      return { rows: [{ deployment: state === 'owned' ? 'docker/test' : 'foreign' }] };
    });
    try {
      if (state === 'empty' || state === 'owned') await control.assertDeploymentIfInitialized('docker/test');
      else await assert.rejects(control.assertDeploymentIfInitialized('docker/test'));
      assert.ok(statements.every((sql) => sql.startsWith('SELECT')));
    } finally {
      query.mock.restore();
      await control.dispose();
    }
  }
});
test('deployment migration holds coordinator ownership through DDL and binding, and rejects unfinished restores', async () => {
  for (const state of ['new', 'completed', 'failed-restore', 'foreign', 'ddl-failure', 'binding-failure']) {
    const control = new LegacyRestoreControl({}, 'fixture');
    const events: string[] = [];
    const patches = [
      mock.method(control, 'lock', async () => {
        events.push('lock');
        return {} as never;
      }),
      mock.method(control, 'unlock', async () => {
        events.push('unlock');
      }),
      mock.method(control, 'assertDeploymentIfInitialized', async () => {
        events.push('ownership');
        if (state === 'foreign') throw Error('foreign');
        return state !== 'new';
      }),
      mock.method(
        control,
        'read',
        async () => ({ phase: state === 'failed-restore' ? 'failed' : 'completed' }) as never,
      ),
      mock.method(control, 'initialize', async () => {
        events.push('binding');
        if (state === 'binding-failure') throw Error('binding failure');
      }),
    ];
    try {
      const migrate = () =>
        control.withDeploymentMigration('docker/owned', async () => {
          events.push('ddl');
          if (state === 'ddl-failure') throw Error('ddl failure');
          return 'migrated';
        });
      if (['new', 'completed'].includes(state)) {
        assert.equal(await migrate(), 'migrated');
        assert.deepEqual(events, ['lock', 'ownership', 'ddl', 'binding', 'unlock']);
      } else {
        await assert.rejects(migrate());
        assert.equal(events.at(-1), 'unlock');
        assert.equal(events.filter((event) => event === 'unlock').length, 1);
        if (['foreign', 'failed-restore'].includes(state)) assert.equal(events.includes('ddl'), false);
        if (state === 'ddl-failure') assert.equal(events.includes('binding'), false);
      }
    } finally {
      for (const patch of patches) patch.mock.restore();
      await control.dispose();
    }
  }
});

test('serving-only single-connection coordinators cannot deadlock by attempting deployment migration', async () => {
  const control = new LegacyRestoreControl({}, 'fixture', 1);
  try {
    await assert.rejects(
      control.withDeploymentMigration('docker/test', async () => {
        throw Error('Must not run');
      }),
      /two-connection/,
    );
  } finally {
    await control.dispose();
  }
});

test('capacity rejection identifies the remedy without exposing arbitrary validation details', () => {
  assert.match(
    restoreValidationFailureMessage(new Error('Insufficient restore scratch space for the runtime-library artifact.')),
    /Increase the dedicated restore storage.*Nothing was deleted/,
  );
  assert.match(
    restoreValidationFailureMessage(new Error('private database or archive details')),
    /^Backup validation failed/,
  );
  assert.doesNotMatch(restoreValidationFailureMessage(new Error('private database or archive details')), /private/);
});

test('runtime migration uses dedicated restore scratch without changing its source or leaving temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-artifact-'));
  try {
    const current = path.join(root, 'current');
    const scratch = path.join(root, 'scratch');
    await fs.mkdir(path.join(current, 'node_modules'), { recursive: true });
    await fs.mkdir(scratch);
    await fs.writeFile(path.join(current, 'package.json'), '{"private":true}');
    const archive = await createRuntimeLibraryDirectoryArchive(current, scratch);
    assert.ok(archive.length > 0);
    assert.deepEqual(await fs.readdir(scratch), []);
    assert.equal(await fs.readFile(path.join(current, 'package.json'), 'utf8'), '{"private":true}');
    await assert.rejects(createRuntimeLibraryDirectoryArchive(current, path.join(root, 'missing')));
    const space = mock.method(fs, 'statfs', async () => ({ bavail: 1n, bsize: 1024n }));
    try {
      await assert.rejects(assertRuntimeLibraryArchiveSpace(current, scratch), /Insufficient restore scratch/);
      assert.deepEqual(await fs.readdir(scratch), [], 'capacity rejection must precede temporary artifact creation');
    } finally {
      space.mock.restore();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy restore archive names are confined to declared domains', () => {
  assert.equal(validateLegacyArchivePath('./workflows/example.rivet-project'), 'workflows/example.rivet-project');
  assert.equal(validateLegacyArchivePath('backup.json'), 'backup.json');
  for (const name of [
    '/workflows/a',
    '../workflows/a',
    'workflows/../outside',
    'C:/workflows/a',
    'workflows\\a',
    'other/a',
    'workflows//a',
    'workflows/a\0b',
    '././workflows/a',
    'backup.json/secret',
  ]) {
    assert.throws(() => validateLegacyArchivePath(name));
  }
});

test('verified completion survives transient secret-erasure failure and recovery retries erasure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-complete-'));
  const id = randomUUID();
  let operation = {
    id,
    phase: 'restarting' as import('../legacy-restore/control.js').RestorePhase,
    destructive: true,
    createdAt: new Date().toISOString(),
    bytes: 1,
    message: 'Verified',
  };
  let attempts = 0;
  let restarts = 0;
  const control = {
    lock: async () => ({}),
    unlock: async () => {},
    read: async () => operation,
    write: async (value: typeof operation) => {
      operation = value;
    },
    forgetPayload: async () => {
      if (++attempts === 1) throw new Error('Temporary database failure');
    },
  };
  const service = new LegacyRestoreService(control as unknown as LegacyRestoreControl, {} as never, root, {
    drain: async () => {},
    restart: async () => {
      restarts++;
    },
  });
  try {
    await fs.mkdir(path.join(root, id));
    const completion = service.complete();
    assert.equal(service.complete(), completion);
    await completion;
    assert.equal(operation.phase, 'completed');
    assert.equal(restarts, 1);
    await service.recover();
    assert.equal(attempts, 2);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await service.dispose();
    setLegacyRestorePaused(false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lost restart acknowledgement cannot overwrite completed or replacement-operation checkpoints', async () => {
  for (const replacement of ['completed', 'new-operation', 'awaiting-confirmation'] as const) {
    const original = {
      id: randomUUID(),
      phase: 'restarting' as import('../legacy-restore/control.js').RestorePhase,
      destructive: true,
      createdAt: new Date().toISOString(),
      bytes: 1,
      message: 'Verified',
    };
    let operation = original;
    let handled!: () => void;
    const handling = new Promise<void>((resolve) => {
      handled = resolve;
    });
    let writes = 0;
    const service = new LegacyRestoreService(
      {
        read: async () => operation,
        lock: async () => ({}),
        unlock: async () => {
          handled();
        },
        write: async () => {
          writes++;
        },
      } as unknown as LegacyRestoreControl,
      {} as never,
      '',
      {
        drain: async () => assert.fail('Restart recovery must not drain.'),
        restart: async () => {
          operation =
            replacement === 'new-operation'
              ? { ...original, id: randomUUID(), phase: 'validating', destructive: false }
              : { ...original, phase: replacement, destructive: replacement === 'completed' };
          throw new Error('Acknowledgement lost');
        },
      },
    );
    try {
      setLegacyRestorePaused(true);
      setLegacyRestoreWarmup(false);
      service.observe(original);
      await handling;
      assert.equal(writes, 0);
      assert.notEqual(operation.phase, 'failed');
    } finally {
      await service.dispose();
      setLegacyRestorePaused(false);
      setLegacyRestoreWarmup(false);
    }
  }
});

test('shutdown waits for accepted finalization and restart happens only after releasing its coordinator', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-finalizing-'));
  const id = randomUUID();
  let operation = {
    id,
    phase: 'restarting',
    destructive: true,
    bytes: 1,
    createdAt: new Date().toISOString(),
    message: 'Verified',
  };
  let committing!: () => void;
  const committedStart = new Promise<void>((resolve) => {
    committing = resolve;
  });
  let commit!: () => void;
  const allowed = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let locked = false;
  let restarts = 0;
  const service = new LegacyRestoreService(
    {
      lock: async () => {
        locked = true;
        return {};
      },
      unlock: async () => {
        locked = false;
      },
      read: async () => operation,
      write: async (value: typeof operation) => {
        committing();
        await allowed;
        operation = value;
      },
      forgetPayload: async () => {},
    } as unknown as LegacyRestoreControl,
    {} as never,
    root,
    {
      drain: async () => {},
      restart: async () => {
        assert.equal(locked, false);
        restarts++;
      },
    },
  );
  try {
    await fs.mkdir(path.join(root, id));
    const complete = service.complete();
    await committedStart;
    assert.equal(service.complete(), complete);
    let disposed = false;
    const stopping = service.dispose().then(() => {
      disposed = true;
    });
    assert.equal(service.complete(), complete, 'An accepted finalization remains joinable during shutdown.');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(locked, true);
    commit();
    await complete;
    await stopping;
    assert.equal(operation.phase, 'completed');
    assert.equal(restarts, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    commit();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shutdown aborts an unaccepted upload and waits for its failed checkpoint and lock release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-upload-'));
  const oldRoot = process.env.RIVET_APP_DATA_ROOT;
  process.env.RIVET_APP_DATA_ROOT = root;
  let operation: import('../legacy-restore/control.js').RestoreOperation | null = null;
  const phases: string[] = [];
  let uploaded!: () => void;
  const uploading = new Promise<void>((resolve) => {
    uploaded = resolve;
  });
  let unlock!: () => void;
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let released = false;
  const control = {
    lock: async () => ({}),
    unlock: async () => {
      await release;
      released = true;
    },
    read: async () => operation,
    write: async (value: NonNullable<typeof operation>) => {
      operation = value;
      phases.push(value.phase);
      if (value.phase === 'uploading') uploaded();
    },
  };
  const service = new LegacyRestoreService(
    control as unknown as LegacyRestoreControl,
    {
      databaseUrl: 'postgres://fixture:fixture@127.0.0.1/rivet',
      objectStorageBucket: 'fixture',
      objectStoragePrefix: 'owned/',
    } as never,
    root,
    {
      drain: async () => assert.fail('Unaccepted uploads must not drain.'),
      restart: async () => assert.fail('Unaccepted uploads must not restart.'),
    },
  );
  const input = new PassThrough();
  try {
    const rejected = assert.rejects(service.upload(input), { name: 'AbortError' });
    await uploading;
    await assert.rejects(service.upload(new PassThrough()), /already active/);
    let disposed = false;
    const stopping = service.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(released, false);
    unlock();
    await stopping;
    await rejected;
    assert.equal(input.destroyed, true);
    assert.deepEqual(phases, ['uploading', 'failed']);
    assert.equal(released, true);
  } finally {
    unlock();
    await service.dispose();
    if (oldRoot === undefined) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = oldRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shutdown racing retry admission cannot advance the durable checkpoint', async () => {
  let locked!: () => void;
  const acquired = new Promise<object>((resolve) => {
    locked = () => resolve({});
  });
  let writes = 0;
  let releases = 0;
  const control = {
    lock: () => acquired,
    unlock: async () => {
      releases++;
    },
    read: async () => assert.fail('Admission must be rechecked before reading or writing.'),
    write: async () => {
      writes++;
    },
  };
  const service = new LegacyRestoreService(control as unknown as LegacyRestoreControl, {} as never, '', {
    drain: async () => {},
    restart: async () => {},
  });
  const rejected = assert.rejects(service.retry(randomUUID()), /stopping/);
  await service.dispose();
  locked();
  await rejected;
  assert.equal(writes, 0);
  assert.equal(releases, 1);
});

test('confirmation waits for the advertised validator handoff and still rechecks shutdown admission', async () => {
  const operation = {
    id: randomUUID(),
    phase: 'awaiting-confirmation',
    destructive: false,
    archiveDigest: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    bytes: 1,
    message: 'Ready',
  };
  let locks = 0;
  let releases = 0;
  let settled!: () => void;
  const validation = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const service = new LegacyRestoreService(
    {
      read: async () => operation,
      lock: async () => {
        locks++;
        return {};
      },
      unlock: async () => {
        releases++;
      },
      write: async () => assert.fail('Shutdown must fence confirmation.'),
    } as unknown as LegacyRestoreControl,
    {} as never,
    '',
    {
      drain: async () => assert.fail('Shutdown must fence confirmation.'),
      restart: async () => {},
    },
  );
  // Controlled worker-completion seam: the public journal is ready, but its owned task has not exited yet.
  (service as unknown as { task: Promise<void> }).task = validation;
  const confirmation = assert.rejects(
    service.start(operation.id, operation.archiveDigest, 'RESTORE LEGACY BACKUP'),
    /stopping/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locks, 0);
  const stopping = service.dispose();
  settled();
  await stopping;
  await confirmation;
  assert.equal(locks, 1);
  assert.equal(releases, 1);
});

test('failed advisory-lock queries discard the connection rather than pooling an uncertain lease', async () => {
  const control = new LegacyRestoreControl({}, 'fixture');
  const releases: (boolean | undefined)[] = [];
  const client = {
    query: async () => {
      throw new Error('Lost acknowledgement');
    },
    release: (destroy?: boolean) => {
      releases.push(destroy);
    },
  };
  Object.defineProperty(control, 'pool', { value: { connect: async () => client } });
  await assert.rejects(control.lock(), /Lost acknowledgement/);
  await assert.rejects(control.unlock(client as never), /Lost acknowledgement/);
  const servingClient = {
    ...client,
    query: async (sql: string) => {
      if (sql.includes('unlock_shared')) throw new Error('Lost acknowledgement');
      return { rows: [] };
    },
  };
  const release = await acquireRestoreServingLease({ connect: async () => servingClient } as never);
  await assert.rejects(release(), /Lost acknowledgement/);
  await assert.rejects(release(), /Lost acknowledgement/); // Coalesced release does not return the client twice.
  assert.deepEqual(releases, [true, true, true]);
});

test('restore control schema and deployment identity initialize atomically, while existing owners remain read-only', async () => {
  const queries: string[] = [];
  const control = new LegacyRestoreControl({}, 'fixture');
  let present = false;
  let failBinding = true;
  let rolledBack = false;
  let releases = 0;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('INSERT') && failBinding) throw new Error('Interrupted binding');
      if (sql === 'ROLLBACK') rolledBack = true;
      return { rows: sql.startsWith('SELECT deployment') ? [{ deployment: 'fixture' }] : [] };
    },
    release: () => {
      releases++;
    },
  };
  Object.defineProperty(control, 'pool', {
    value: {
      connect: async () => client,
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            sql.startsWith('SELECT deployment')
              ? { deployment: 'fixture' }
              : { installation: present ? 'installation' : null, operation: present ? 'operation' : null },
          ],
        };
      },
    },
  });
  await assert.rejects(control.initialize('fixture'), /Interrupted binding/);
  assert.equal(rolledBack, true);
  assert.equal(queries.includes('COMMIT'), false);
  failBinding = false;
  queries.length = 0;
  await control.initialize('fixture');
  assert.equal(queries[1], 'BEGIN');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(releases, 2);
  present = true;
  queries.length = 0;
  await control.initialize('fixture');
  assert.equal(queries.length, 2);
  assert.equal(
    queries.some((sql) => /CREATE|INSERT|BEGIN/.test(sql)),
    false,
  );
  await assert.rejects(control.initialize('foreign'), /different Rivet deployment/);
});

test('idle recovery observes predecessor completion without restarting warmup or replaying failed writes', async () => {
  let operation: import('../legacy-restore/control.js').RestoreOperation = {
    id: randomUUID(),
    phase: 'restarting',
    destructive: true,
    createdAt: new Date().toISOString(),
    bytes: 1,
    message: 'Verified',
  };
  let restarts = 0;
  let restartFinished!: () => void;
  let restart = new Promise<void>((resolve) => {
    restartFinished = resolve;
  });
  const createService = () =>
    new LegacyRestoreService(
      {
        read: async () => operation,
        write: async () => assert.fail('Observing terminal progress must not replay writes.'),
      } as unknown as LegacyRestoreControl,
      {} as never,
      '',
      {
        drain: async () => assert.fail('Terminal reconciliation must not drain again.'),
        restart: async () => {
          restarts++;
          await restart;
        },
      },
    );
  let service = createService();
  try {
    setLegacyRestorePaused(true);
    setLegacyRestoreWarmup(true);
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 0);
    setLegacyRestoreWarmup(false);
    service.observe(operation);
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1);
    restartFinished();
    await new Promise((resolve) => setImmediate(resolve));
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1, 'an acknowledged restart must not be requested again before this generation exits');
    operation = { ...operation, phase: 'failed', destructive: true };
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1); // Destructive failures require explicit operator retry.
    operation = { ...operation, destructive: false };
    restart = Promise.resolve();
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1, 'a supervisor-owned generation no longer admits recovery work');
    await assert.rejects(service.retry(operation.id), /stopping/);
    await service.dispose();
    service = createService();
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 2, 'a new owner may recover a predecessor that failed before deletion');
    await service.dispose();
    service = createService();
    setLegacyRestorePaused(false);
    let validations = 0;
    (service as unknown as { worker(id: string): Promise<void> }).worker = async () => {
      validations++;
      operation = { ...operation, phase: 'awaiting-confirmation' };
    };
    operation = { ...operation, phase: 'validating' };
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(validations, 1);
    assert.equal(restarts, 2, 'A new validation must not be mistaken for terminal serving recovery.');
    service.observe(operation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 2, 'Waiting for confirmation is not a terminal recovery checkpoint.');
  } finally {
    restartFinished();
    await service.dispose();
    setLegacyRestorePaused(false);
    setLegacyRestoreWarmup(false);
  }
});

test('extended restore uploads retain short ordinary-body deadlines and remove completed request timers', async () => {
  const req = Object.assign(new EventEmitter(), {
    complete: false,
    method: 'POST',
    url: '/api/projects/save',
    destroy: () => {
      destroyed++;
    },
  });
  let destroyed = 0;
  let status = 0;
  const res = {
    headersSent: false,
    writeHead: (value: number) => {
      status = value;
      return res;
    },
    end: (done: () => void) => done(),
  };
  retainOrdinaryReceiveDeadline(req as never, res as never, 10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(status, 408);
  assert.equal(destroyed, 1);
  req.url = '/api/legacy-restore/upload';
  status = 0;
  retainOrdinaryReceiveDeadline(req as never, res as never, 10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(status, 0);
  req.url = '/api/projects/save';
  retainOrdinaryReceiveDeadline(req as never, res as never, 10);
  req.emit('end');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(status, 0);
  assert.equal(req.listenerCount('close'), 0);
});

test('restore preserves deployment connections and admin OAuth without discarding unrelated source settings', () => {
  const source = ['deployment storage', 'web app auth', 'environment variables'].map((key) => ({
    key,
    schemaVersion: 1,
    value: { from: 'source' },
    sourceHash: null,
  }));
  const current = source.map((row) => ({ ...row, value: { from: 'destination' } }));
  assert.deepEqual(
    buildRestoreSettings(source, current, 'key').map((row) => row.value.from),
    ['destination', 'source', 'source'],
  );
  assert.deepEqual(
    buildRestoreSettings(source, current, 'oauth').map((row) => row.value.from),
    ['destination', 'destination', 'source'],
  );
  assert.throws(() => buildRestoreSettings(source, [], 'key'), /incomplete/);
});

test('restore object inventory never accepts a bucket sweep or sibling namespace', () => {
  assert.equal(
    validateRestoreObjectKey('owned/workflows/', 'project/revisions/revision/project.rivet-project', 'workflow'),
    'owned/workflows/project/revisions/revision/project.rivet-project',
  );
  assert.equal(
    validateRestoreObjectKey('runtime-libraries/', 'releases/release-123/release.tar', 'runtime'),
    'runtime-libraries/releases/release-123/release.tar',
  );
  for (const prefix of ['', '/', '../', 'owned/../', 'owned\\/', 'owned//'])
    assert.throws(() =>
      validateRestoreObjectKey(prefix, 'project/revisions/revision/project.rivet-project', 'workflow'),
    );
  for (const name of [
    '../outside',
    'project/revisions/../project.rivet-project',
    'arbitrary/secret',
    'project\\revisions/x/project.rivet-project',
  ])
    assert.throws(() => validateRestoreObjectKey('owned/', name, 'workflow'));
});

test('restore never deletes potentially shared runtime archives, including inventories from an earlier checkpoint', async () => {
  // No S3 configuration: retaining this inventory must not even create a storage client.
  await clearRestoreObjects({} as never, [
    { key: 'runtime-libraries/releases/vm-migration-same-content/release.tar', etag: 'captured' },
  ]);
  await assert.rejects(
    clearRestoreObjects({} as never, [{ key: 'runtime-libraries/../outside', etag: 'captured' }]),
    /Unrecognized|Unsafe/,
  );
});

test('new deletion inventories do not inspect retained runtime archives or create an idle S3 client', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('pg_catalog.pg_tables')
        ? { rows: [{ tablename: 'runtime_library_releases' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  };
  // Deliberately no storage credentials: with no workflow artifacts, no HEAD/client is needed.
  assert.deepEqual(await captureRestoreObjects(pool as never, { objectStoragePrefix: 'owned/' } as never), []);
  assert.equal(
    queries.some((sql) => sql.includes('FROM public.runtime_library_releases')),
    false,
  );
});

test('retry preparation finishing after shutdown cannot advance the checkpoint', async () => {
  const id = randomUUID();
  let payloadReady!: () => void;
  const preparing = new Promise<void>((resolve) => {
    payloadReady = resolve;
  });
  let payloadFinished!: (value: Record<string, unknown>) => void;
  const payload = new Promise<Record<string, unknown>>((resolve) => {
    payloadFinished = resolve;
  });
  let released = 0;
  const service = new LegacyRestoreService(
    {
      lock: async () => ({}),
      unlock: async () => {
        released++;
      },
      read: async () => ({ id, phase: 'failed', destructive: true }),
      payload: () => {
        payloadReady();
        return payload;
      },
      write: async () => assert.fail('A closing owner must not accept prepared work.'),
    } as unknown as LegacyRestoreControl,
    {} as never,
    '',
    { drain: async () => {}, restart: async () => {} },
  );
  const rejected = assert.rejects(service.retry(id), /stopping/);
  await preparing;
  await service.dispose();
  payloadFinished({ resumePhase: 'clearing' });
  await rejected;
  assert.equal(released, 1);
});

test('restore maintenance never reopens partially cleared data after failure', () => {
  const base = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    bytes: 1,
    message: 'Restore',
    destructive: false,
  };
  for (const phase of ['uploading', 'validating', 'awaiting-confirmation', 'completed', 'cancelled'] as const)
    assert.equal(restoreBlocksServing({ ...base, phase }), false);
  for (const phase of ['draining', 'clearing', 'importing', 'verifying', 'restarting'] as const)
    assert.equal(restoreBlocksServing({ ...base, phase }), true);
  assert.equal(restoreBlocksServing({ ...base, phase: 'failed' }), false);
  assert.equal(restoreBlocksServing({ ...base, phase: 'failed', destructive: true }), true);
  assert.throws(() => restoreOperationSchema.parse({ ...base, phase: 'completed', password: 'secret' }));
  assert.throws(() => restoreOperationSchema.parse({ ...base, phase: 'completed' }));
  assert.throws(() => restoreOperationSchema.parse({ ...base, phase: 'awaiting-confirmation', destructive: true }));
});

test('restore table clearing uses a closed list, keeps schema/control data and never cascades', async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes('pg_tables') ? [{ tablename: 'workflows' }, { tablename: 'workflow_revisions' }] : [],
        rowCount: 0,
      };
    },
    release: () => {
      released = true;
    },
  };
  await clearRestoreTables({ connect: async () => client } as unknown as Pool);
  assert.equal(
    queries.some((sql) => sql === 'TRUNCATE TABLE public."workflow_revisions", public."workflows" RESTRICT'),
    true,
  );
  assert.equal(
    queries.some((sql) => /CASCADE|DROP\s/i.test(sql)),
    false,
  );
  assert.equal(
    LEGACY_RESTORE_TABLES.some((t) => /restore_control|schema_migrations/.test(t)),
    false,
  );
  assert.equal(released, true);
});

test('failed rollback discards an uncertain transaction connection without masking its original failure', async () => {
  for (const failedStep of ['TRUNCATE', 'COMMIT']) {
    const releases: (boolean | undefined)[] = [];
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith(failedStep)) throw new Error('Clearing failed');
        if (sql === 'ROLLBACK') throw new Error('Rollback acknowledgement lost');
        return sql.includes('pg_catalog.pg_tables')
          ? { rows: [{ tablename: 'workflows' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
      release: (destroy?: boolean) => {
        releases.push(destroy);
      },
    };
    await assert.rejects(clearRestoreTables({ connect: async () => client } as never), /Clearing failed/);
    assert.deepEqual(releases, [true]);
  }
});

test('foreign table dependencies or triggers abort before deletion', async () => {
  for (const offending of ['pg_constraint', 'pg_trigger', 'pg_inherits']) {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.includes('pg_tables') ? [{ tablename: 'workflows' }] : [],
          rowCount: sql.includes(offending) ? 1 : 0,
        };
      },
      release: () => undefined,
    };
    await assert.rejects(
      clearRestoreTables({ connect: async () => client } as unknown as Pool),
      /dependencies or triggers/,
    );
    assert.equal(
      queries.some((sql) => sql.startsWith('TRUNCATE')),
      false,
    );
    assert.equal(queries.includes('ROLLBACK'), true);
    await assert.rejects(assertRestoreTableBoundary(client as never, ['workflows']));
  }
});

test('archive inspection rejects duplicate entries and never extracts unknown roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-test-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    await fs.mkdir(source);
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, 'backup.json'), '{}');
    const duplicate = path.join(root, 'duplicate.tar.gz');
    await tar.c({ file: duplicate, cwd: source, gzip: true }, ['backup.json', 'backup.json']);
    await assert.rejects(prepareLegacyArchive(duplicate, destination));
    assert.deepEqual(await fs.readdir(destination), []);
    await fs.mkdir(path.join(source, 'outside'));
    await fs.writeFile(path.join(source, 'outside', 'sentinel'), 'unrelated');
    const outside = path.join(root, 'outside.tar.gz');
    await tar.c({ file: outside, cwd: source, gzip: true }, ['outside']);
    await assert.rejects(prepareLegacyArchive(outside, destination));
    assert.deepEqual(await fs.readdir(destination), []);
    assert.equal(await fs.readFile(path.join(source, 'outside', 'sentinel'), 'utf8'), 'unrelated');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('interrupted extraction rebuilds only verified UUID-owned scratch and rejects changed archives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-scratch-'));
  const id = randomUUID();
  const owner = path.join(root, id);
  const scratch = path.join(owner, 'source');
  const archive = path.join(owner, 'archive.tar.gz');
  try {
    await fs.mkdir(scratch, { recursive: true });
    await fs.writeFile(path.join(scratch, 'partial'), 'partial extraction');
    await fs.writeFile(path.join(root, 'sentinel'), 'keep');
    await fs.writeFile(archive, 'original bytes');
    const hash = createHash('sha256').update('original bytes').digest('hex');
    await assert.rejects(resetRestoreScratch(archive, scratch, id, root, 'a'.repeat(64)), /changed/);
    assert.equal(await fs.readFile(path.join(scratch, 'partial'), 'utf8'), 'partial extraction');
    await assert.rejects(resetRestoreScratch(archive, root, id, root, hash), /ownership/);
    await resetRestoreScratch(archive, scratch, id, root, hash);
    assert.deepEqual(await fs.readdir(scratch), []);
    await fs.rmdir(scratch); // Crash between removal and recreation is also resumable.
    await resetRestoreScratch(archive, scratch, id, root, hash);
    assert.equal(await fs.readFile(path.join(root, 'sentinel'), 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('portable runtime preflight rejects native binaries before destructive authorization', async () => {
  for (const hex of ['7f454c46', '4d5a0000', 'cffaedfe', 'cafebabe'])
    assert.equal(isNativeExecutableHeader(Buffer.from(hex, 'hex')), true);
  assert.equal(isNativeExecutableHeader(Buffer.from('module.exports=1')), false);
  assert.equal(isNativeExecutableHeader(Buffer.from('0061736d', 'hex')), false); // WebAssembly is portable.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-native-'));
  try {
    await fs.writeFile(path.join(root, 'module.js'), 'module.exports=1');
    await assertPortableRuntimeTree(root);
    await fs.writeFile(path.join(root, 'opaque-binary'), Buffer.from('7f454c46', 'hex'));
    await assert.rejects(assertPortableRuntimeTree(root), /platform-certified/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a valid old runtime layout is normalized only within the verified copy and ambiguous layouts are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restore-layout-'));
  try {
    const active = path.join(root, 'releases', 'legacy-1');
    await fs.mkdir(path.join(active, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(active, 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'active-release'), 'legacy-1');
    await fs.chmod(path.join(root, 'releases'), 0o500);
    await normalizeExtractedRuntimeLayout(root);
    assert.equal(await fs.readFile(path.join(root, 'current', 'package.json'), 'utf8'), '{}');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'releases'))).mode & 0o700, 0o700);
    await fs.writeFile(path.join(root, 'active-release'), '../outside');
    await assert.rejects(normalizeExtractedRuntimeLayout(root), /identity/);
    await fs.writeFile(path.join(root, 'active-release'), 'legacy-1');
    await assert.rejects(normalizeExtractedRuntimeLayout(root), /Ambiguous/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('old browser documents cannot mutate a restored workspace, while recovery remains accessible', () => {
  const previous = process.env.RIVET_LEGACY_RESTORE_ENABLED;
  process.env.RIVET_LEGACY_RESTORE_ENABLED = '1';
  const id = randomUUID();
  setLegacyRestoreWorkspaceEpoch(id);
  setLegacyRestorePaused(false);
  const check = (path: string, epoch?: string) => {
    let code = 0;
    let continued = false;
    const request = {
      method: 'POST',
      path,
      get: (name: string) =>
        name === 'Sec-Fetch-Site' ? 'same-origin' : name === 'X-Rivet-Workspace-Epoch' ? epoch : undefined,
    };
    const response = {
      status: (value: number) => {
        code = value;
        return response;
      },
      json: () => response,
    };
    legacyRestoreRequestBarrier(request as never, response as never, () => {
      continued = true;
    });
    return { code, continued };
  };
  try {
    assert.deepEqual(check('/api/projects/save', 'initial'), { code: 409, continued: false });
    assert.deepEqual(check('/api/legacy-restore/retry', 'initial'), { code: 0, continued: true });
    // Do not leave the active-request counter incremented: use a read-free control route for positive admission.
    assert.deepEqual(check('/api/config', id), { code: 0, continued: true });
  } finally {
    if (previous === undefined) delete process.env.RIVET_LEGACY_RESTORE_ENABLED;
    else process.env.RIVET_LEGACY_RESTORE_ENABLED = previous;
  }
});
