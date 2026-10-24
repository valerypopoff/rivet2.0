import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';
import type { ManagedWorkflowOperationsFactory } from '../routes/workflows/managed/operations.js';
import { S3ManagedWorkflowBlobStore, type ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import { acquireManagedPostgresPool, getManagedPostgresPoolMetrics } from '../managed-postgres-pool.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import { createManagedWorkflowContext } from '../routes/workflows/managed/context.js';

const config: ManagedWorkflowStorageConfig = {
  databaseMode: 'managed',
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  databaseSslMode: 'disable',
  objectStorageBucket: 'fixture',
  objectStorageRegion: 'fixture',
  objectStorageEndpoint: null,
  objectStorageAccessKeyId: 'fixture',
  objectStorageSecretAccessKey: 'fixture',
  objectStoragePrefix: '',
  objectStorageForcePathStyle: true,
};

test('context shutdown settles every object client and retains all cleanup failures', async (t) => {
  const previous = process.env.RIVET_MANAGED_MAINTENANCE_ENABLED;
  process.env.RIVET_MANAGED_MAINTENANCE_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.RIVET_MANAGED_MAINTENANCE_ENABLED;
    else process.env.RIVET_MANAGED_MAINTENANCE_ENABLED = previous;
  });
  const before = getManagedPostgresPoolMetrics();
  const failures = [new Error('workflow object-client close failed'), new Error('library object-client close failed')];
  let closes = 0;
  const dispose = S3ManagedWorkflowBlobStore.prototype.dispose;
  t.mock.method(S3ManagedWorkflowBlobStore.prototype, 'dispose', function (this: S3ManagedWorkflowBlobStore) {
    dispose.call(this);
    const failure = failures[closes++];
    if (failure) throw failure;
  });
  const context = createManagedWorkflowContext({ ...config, databaseUrl: config.databaseUrl + '-shutdown' });
  let actualFailure: unknown;
  await assert.rejects(context.dispose(), (error) => {
    actualFailure = error;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    return true;
  });
  await assert.rejects(context.dispose(), (error) => error === actualFailure);
  assert.equal(closes, 2, 'a throwing first client must not strand the second or cause a repeated close');
  assert.deepEqual(getManagedPostgresPoolMetrics(), before, 'the pool release must also be acknowledged');

  failures.pop();
  closes = 0;
  const singleFailureContext = createManagedWorkflowContext(config);
  await assert.rejects(singleFailureContext.dispose(), (error) => error === failures[0]);
  assert.equal(closes, 2, 'single failures retain their identity without skipping the other client');
  assert.deepEqual(getManagedPostgresPoolMetrics(), before);
});

test('invalid context configuration fails before acquiring persistence resources', async () => {
  const env = process.env;
  const before = getManagedPostgresPoolMetrics();
  const cases = [
    { env: { RIVET_MANAGED_MAINTENANCE_ENABLED: 'invalid' }, endpoint: null, expected: /boolean/ },
    {
      env: { RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE: 'invalid' },
      endpoint: null,
      expected: /STALE_UPLOAD_RETENTION_MODE/,
    },
    {
      env: { RIVET_MANAGED_EVALUATION_RETENTION_MODE: 'invalid' },
      endpoint: null,
      expected: /EVALUATION_RETENTION_MODE/,
    },
    {
      env: { RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE: 'invalid' },
      endpoint: null,
      expected: /WEB_APP_ACTION_RETENTION_MODE/,
    },
    { env: {}, endpoint: 'not-a-url', expected: /Invalid URL/ },
  ];
  try {
    for (const scenario of cases) {
      process.env = {
        ...env,
        RIVET_MANAGED_MAINTENANCE_ENABLED: 'true',
        RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE: 'audit',
        RIVET_MANAGED_EVALUATION_RETENTION_MODE: 'audit',
        RIVET_MANAGED_WEB_APP_ACTION_RETENTION_MODE: 'audit',
        ...scenario.env,
      };
      assert.throws(
        () => new ManagedWorkflowBackend({ ...config, objectStorageEndpoint: scenario.endpoint }),
        scenario.expected,
      );
      assert.deepEqual(getManagedPostgresPoolMetrics(), before, 'failed configuration must not strand a pool lease');
    }
  } finally {
    process.env = env;
  }
});

test('a fenced pool acquisition disposes only newly constructed object-store clients', async (t) => {
  const previous = process.env.RIVET_MANAGED_MAINTENANCE_ENABLED;
  process.env.RIVET_MANAGED_MAINTENANCE_ENABLED = 'true';
  const lease = acquireManagedPostgresPool(getManagedDbPoolConfig(config));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const end = lease.pool.end.bind(lease.pool);
  t.mock.method(lease.pool, 'end', () => gate.then(() => end()));
  const closing = lease.release();
  t.after(async () => {
    finish();
    await closing;
    if (previous === undefined) delete process.env.RIVET_MANAGED_MAINTENANCE_ENABLED;
    else process.env.RIVET_MANAGED_MAINTENANCE_ENABLED = previous;
  });
  let disposed = 0;
  let cleanupFailure: Error | undefined;
  const dispose = S3ManagedWorkflowBlobStore.prototype.dispose;
  t.mock.method(S3ManagedWorkflowBlobStore.prototype, 'dispose', function (this: S3ManagedWorkflowBlobStore) {
    disposed++;
    dispose.call(this);
    if (cleanupFailure) {
      const error = cleanupFailure;
      cleanupFailure = undefined;
      throw error;
    }
  });
  assert.throws(() => new ManagedWorkflowBackend(config), /clos|unconfirmed/i);
  assert.equal(disposed, 2, 'both context-owned object clients are cleaned before reporting the failed acquisition');
  const failure = new Error('fixture object-client cleanup failure');
  cleanupFailure = failure;
  assert.throws(
    () => new ManagedWorkflowBackend(config),
    (error) => error instanceof AggregateError && error.errors.includes(failure) && error.errors.length === 2,
  );
  assert.equal(disposed, 4, 'one cleanup failure must not prevent cleanup of the other owned client');
  let injectedDisposals = 0;
  assert.throws(
    () =>
      new ManagedWorkflowBackend(config, {
        dispose() {
          injectedDisposals++;
        },
      } as ManagedWorkflowBlobStore),
    /clos|unconfirmed/i,
  );
  assert.equal(injectedDisposals, 0, 'a failed constructor has not taken ownership of an injected object store');
});

test('serving composition owns operational producers and settles them before persistence disposal', async (t) => {
  const events: string[] = [];
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });

  let constructions = 0;
  const stores = { profileHealth: {}, evaluations: {} };
  const createOperations: ManagedWorkflowOperationsFactory = (input) => {
    constructions++;
    assert.deepEqual(Object.keys(input.sources).sort(), [
      'createProjectReferenceLoader',
      'loadSubgraphTarget',
      'validateSubgraphTarget',
    ]);
    assert.equal(input.backgroundTasks, true);
    return {
      ...stores,
      coordinator: {
        beginRetirement() {
          events.push('retire');
        },
        async drainAcceptedWork() {
          events.push('settle');
        },
        async stop() {
          events.push('stop');
          await stopped;
        },
      },
    } as ReturnType<ManagedWorkflowOperationsFactory>;
  };
  const backend = new ManagedWorkflowBackend(
    config,
    {
      dispose() {
        events.push('close-persistence');
      },
    } as ManagedWorkflowBlobStore,
    { createOperations },
  );
  t.mock.method(backend, 'initialize', async () => {});
  assert.equal(constructions, 0, 'read-only construction must not allocate operational resources');
  backend.beginRetirement();
  await Promise.all([
    backend.getHostedEvaluationCoordinator(),
    backend.getEvaluationStore(),
    backend.getLLMProfileHealthStore(),
  ]);
  assert.equal(constructions, 1);
  await backend.drainAcceptedWork();
  const disposing = backend.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['retire', 'settle', 'stop']);
  assert.equal(await backend.getEvaluationStore(), stores.evaluations, 'accepted shutdown writes retain their store');
  assert.equal(await backend.getLLMProfileHealthStore(), stores.profileHealth);
  release();
  await disposing;
  assert.deepEqual(events, ['retire', 'settle', 'stop', 'close-persistence']);
  // Offline adapters deliberately have no producer factory or serving stores.
  const offline = new ManagedWorkflowBackend(config, { dispose() {} } as ManagedWorkflowBlobStore, {
    migrationMode: 'verify',
  });
  // These must reject before initialization: the deliberately unreachable DB
  // is not needed merely to report a missing serving capability.
  await assert.rejects(offline.getEvaluationStore(), /outside serving composition/);
  await assert.rejects(offline.getLLMProfileHealthStore(), /outside serving composition/);
  await assert.rejects(offline.getHostedEvaluationCoordinator(), /migration mode/);
  offline.beginRetirement();
  await offline.drainAcceptedWork();
  await offline.dispose();
  assert.equal(constructions, 1);
});

test('failed operational construction leaves a reachable persistence owner that releases its pool', async (t) => {
  const before = getManagedPostgresPoolMetrics();
  const failure = new Error('Operational configuration is invalid');
  let attempts = 0;
  const backend = new ManagedWorkflowBackend(config, { dispose() {} } as ManagedWorkflowBlobStore, {
    createOperations() {
      attempts++;
      throw failure;
    },
  });
  t.after(() => backend.dispose());
  assert.equal(attempts, 0);
  await assert.rejects(backend.initialize(), (error) => error === failure);
  assert.equal(attempts, 1);
  assert.equal(getManagedPostgresPoolMetrics().pools, before.pools + 1);
  await backend.dispose();
  assert.deepEqual(getManagedPostgresPoolMetrics(), before);
});

test('a getter awaiting initialization cannot allocate operational resources after drain', async (t) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let constructions = 0;
  const backend = new ManagedWorkflowBackend(config, { dispose() {} } as ManagedWorkflowBlobStore, {
    createOperations() {
      constructions++;
      throw new Error('Must not construct during drain');
    },
  });
  t.after(() => backend.dispose());
  t.mock.method(backend, 'initialize', () => ready);
  const getter = backend.getEvaluationStore();
  await backend.drain();
  release();
  await assert.rejects(getter, /shutting down/);
  assert.equal(constructions, 0);
});

test('context cleanup retains a failed pool-close acknowledgement alongside the client failure', async (t) => {
  const poolFailure = new Error('Pool close acknowledgement lost');
  const clientFailure = new Error('Object client close failed');
  let closes = 0;
  const fixture = { ...config, databaseUrl: config.databaseUrl + '-close-acknowledgement' };
  const unexpectedStorage = async () => assert.fail('Disposal must not perform object I/O');
  const context = createManagedWorkflowContext(fixture, {
    putText: unexpectedStorage,
    getText: unexpectedStorage,
    delete: unexpectedStorage,
    dispose() {
      closes++;
      throw clientFailure;
    },
  });
  const end = context.pool.end.bind(context.pool);
  t.mock.method(context.pool, 'end', async () => {
    // Close the real unused fixture pool before simulating a lost acknowledgement.
    // Its registry entry must nevertheless remain fenced until process recovery.
    await end();
    throw poolFailure;
  });
  let failure: unknown;
  await assert.rejects(context.dispose(), (error) => {
    failure = error;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [poolFailure, clientFailure]);
    return true;
  });
  await assert.rejects(context.dispose(), (error) => error === failure);
  assert.equal(closes, 1);
  assert.throws(() => acquireManagedPostgresPool(getManagedDbPoolConfig(fixture)), /clos|unconfirmed/i);
});
