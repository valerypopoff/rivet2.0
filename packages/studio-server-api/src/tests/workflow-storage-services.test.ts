import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import {
  WorkflowStorageServices,
  type LocalWorkflowResources,
  type ManagedWorkflowResources,
  type WorkflowStorageServiceDependencies,
} from '../routes/workflows/storage-services.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(mode: WorkflowStorageServiceDependencies['mode'] = 'sqlite') {
  const events: string[] = [];
  const local = {
    initialize: async () => {
      events.push('initialize');
    },
    dispose: async () => {
      events.push('close');
    },
    getActiveWriteCount: () => 2,
    getPendingCatalogOperationCount: () => 3,
    cleanupRecordings: async () => {
      events.push('retention');
      return 0;
    },
  };
  const managed = {
    ...local,
    getLLMProfileHealthStore: async () =>
      health as ReturnType<WorkflowStorageServiceDependencies['createProfileHealth']>,
    getEvaluationStore: async () => evaluations as ReturnType<WorkflowStorageServiceDependencies['createEvaluations']>,
    drain: async () => {
      events.push('stop-producers');
    },
  };
  const health = {
    dispose: async () => {
      events.push('close-health');
    },
  };
  const evaluations = {
    dispose: async () => {
      events.push('close-evaluations');
    },
  };
  let constructions = 0;
  const dependencies: WorkflowStorageServiceDependencies = {
    mode,
    createLocal: () => {
      constructions++;
      return local as unknown as LocalWorkflowResources;
    },
    createManaged: () => {
      constructions++;
      return managed as unknown as ManagedWorkflowResources;
    },
    createProfileHealth: () => health as ReturnType<WorkflowStorageServiceDependencies['createProfileHealth']>,
    createEvaluations: () => evaluations as ReturnType<WorkflowStorageServiceDependencies['createEvaluations']>,
    profileHealthExists: async () => false,
    initializeLegacy: async () => {
      events.push('initialize-legacy');
    },
    drainLegacy: async () => {
      events.push('drain-legacy');
    },
    flushRecordings: async () => {
      events.push('flush-recordings');
    },
    flushRecordingOutcomes: async () => {
      events.push('flush-outcomes');
    },
    assertRetentionAllowed: () => {},
  };
  return {
    owner: new WorkflowStorageServices(dependencies),
    dependencies,
    local,
    managed,
    health,
    evaluations,
    events,
    constructions: () => constructions,
  };
}

test('workflow services own single-flight construction and isolate independent installations', async () => {
  const first = fixture();
  const second = fixture();
  const [a, b] = await Promise.all([first.owner.getLocal(), first.owner.getLocal()]);
  assert.equal(a, b);
  assert.equal(first.constructions(), 1);
  assert.notEqual(a, await second.owner.getLocal());
  first.dependencies.mode = 'managed';
  assert.equal(first.owner.mode, 'sqlite', 'an owner cannot be retargeted after construction');
  assert.equal(first.owner.getLocalActiveWriteCount(), 2);
  assert.equal(first.owner.getLocalPendingOperationCount(), 3);
  await Promise.all([first.owner.dispose(), second.owner.dispose()]);
  assert.equal(first.events.filter((event) => event === 'close').length, 1);
});

test('drain waits for late initialization and does not start retention or create resources', async () => {
  const f = fixture();
  const gate = deferred();
  const started = deferred();
  f.local.initialize = async () => {
    f.events.push('initialize');
    started.resolve();
    await gate.promise;
  };
  const initialized = f.owner.initialize();
  const rejected = assert.rejects(initialized, /shutting down/);
  await started.promise;
  const draining = f.owner.dispose();
  await assert.rejects(f.owner.getProfileHealth(), /shutting down/);
  await assert.rejects(f.owner.getEvaluations(), /shutting down/);
  gate.resolve();
  await Promise.all([rejected, draining]);
  assert.deepEqual(f.events, ['initialize', 'flush-recordings', 'flush-outcomes', 'close']);
  assert.equal(f.owner.phase, 'closed');
  assert.throws(() => f.owner.getLocal(), /shutting down/);
});

test('shutdown cancels deferred adapter construction before opening any resources', async () => {
  for (const mode of ['sqlite', 'managed'] as const) {
    const f = fixture(mode);
    const prepared = f.owner.getData();
    const rejected = assert.rejects(prepared, /shutting down/);
    await f.owner.dispose();
    await rejected;
    assert.equal(f.constructions(), 0);
    assert.equal(f.owner.phase, 'closed');
    assert.deepEqual(f.events, ['flush-recordings', 'flush-outcomes']);
  }
});

test('managed shutdown fences producer startup before waiting for initialization', async () => {
  const f = fixture('managed');
  const started = deferred();
  const gate = deferred();
  let stopping = false;
  f.managed.initialize = async () => {
    f.events.push('initialize');
    started.resolve();
    await gate.promise;
    if (!stopping) f.events.push('producer-start');
  };
  f.managed.drain = async () => {
    stopping = true;
    f.events.push('stop-producers');
    await gate.promise;
  };
  const initialized = f.owner.initialize();
  const rejected = assert.rejects(initialized, /shutting down/);
  await started.promise;
  const disposed = f.owner.dispose();
  assert.equal(stopping, true);
  gate.resolve();
  await Promise.all([disposed, rejected]);
  assert.deepEqual(f.events, ['initialize', 'stop-producers', 'flush-recordings', 'flush-outcomes', 'close']);
  assert.equal(f.owner.phase, 'closed');
});

test('shutdown stops producers before persistence, retaining stores until evidence settles', async () => {
  const f = fixture('managed');
  await f.owner.getManaged();
  const health = await f.owner.getProfileHealth();
  const evaluations = await f.owner.getEvaluations();
  f.dependencies.flushRecordings = async () => {
    assert.equal(await f.owner.getProfileHealth(), health);
    assert.equal(await f.owner.getEvaluations(), evaluations);
    assert.equal(await f.owner.getManaged(), f.managed);
    f.events.push('flush-recordings');
  };
  await Promise.all([f.owner.dispose(), f.owner.dispose()]);
  assert.deepEqual(f.events, ['initialize', 'stop-producers', 'flush-recordings', 'flush-outcomes', 'close']);
});

test('explicit drain fences construction and is shared with disposal without closing dependent stores early', async () => {
  const f = fixture('sqlite');
  await f.owner.getLocal();
  const health = await f.owner.getProfileHealth();
  const gate = deferred();
  f.dependencies.flushRecordings = async () => {
    f.events.push('flush-recordings');
    await gate.promise;
  };
  const draining = f.owner.drain();
  assert.equal(f.owner.phase, 'draining');
  assert.equal(f.owner.drain(), draining);
  await assert.rejects(f.owner.getEvaluations(), /shutting down/);
  assert.equal(await f.owner.getProfileHealth(), health);
  const disposing = f.owner.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, ['initialize', 'flush-recordings']);
  gate.resolve();
  await draining;
  await disposing;
  assert.deepEqual(f.events, ['initialize', 'flush-recordings', 'flush-outcomes', 'close', 'close-health']);
  assert.equal(f.owner.phase, 'closed');
  await f.owner.drain();
  assert.equal(f.owner.phase, 'closed', 'a repeated drain must not reopen a closed owner');
});

test('failed initialization is retryable only after confirmed cleanup', async () => {
  const f = fixture();
  f.local.initialize = async () => {
    throw new Error('initialization failed');
  };
  await assert.rejects(f.owner.getLocal(), /initialization failed/);
  f.local.initialize = async () => {};
  await f.owner.getLocal();
  assert.equal(f.constructions(), 2);
  await f.owner.dispose();
});

test('unknown cleanup outcome retains the failed owner and blocks replacement', async () => {
  const f = fixture();
  f.local.initialize = async () => {
    throw new Error('initialization failed');
  };
  let closes = 0;
  f.local.dispose = async () => {
    closes++;
    throw new Error('worker termination unknown');
  };
  await assert.rejects(f.owner.getLocal(), AggregateError);
  await assert.rejects(f.owner.getLocal(), AggregateError);
  assert.equal(f.constructions(), 1);
  await assert.rejects(f.owner.dispose(), /worker termination unknown/);
  assert.equal(closes, 2, 'shutdown must still attempt disposal of the retained owner');
  await assert.rejects(f.owner.getLocal(), AggregateError);
  assert.equal(f.owner.phase, 'draining');
});

test('shutdown waits for retention before closing its catalog', async () => {
  const f = fixture();
  const gate = deferred();
  f.local.cleanupRecordings = async () => {
    f.events.push('retention');
    await gate.promise;
    return 0;
  };
  await f.owner.initialize();
  await Promise.resolve();
  let closed = false;
  const draining = f.owner.dispose().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  gate.resolve();
  await draining;
  assert.ok(f.events.indexOf('retention') < f.events.indexOf('close'));
});

test('a failed recording drain keeps stores open and never detaches the owner', async () => {
  const f = fixture('legacy');
  await f.owner.getProfileHealth();
  f.dependencies.flushRecordings = async () => {
    throw new Error('unsettled recordings');
  };
  const first = f.owner.dispose();
  await assert.rejects(first, /unsettled recordings/);
  assert.equal(f.owner.dispose(), first);
  assert.equal(f.owner.phase, 'draining');
  assert.deepEqual(f.events, ['drain-legacy']);
});

test('operational stores follow the owner mode without constructing local stores in managed mode', async () => {
  for (const mode of ['legacy', 'sqlite', 'managed'] as const) {
    const f = fixture(mode);
    if (mode === 'managed') {
      f.dependencies.createProfileHealth = () => {
        throw new Error('Managed owners must not create a local health database');
      };
      f.dependencies.createEvaluations = () => {
        throw new Error('Managed owners must not create a local Evaluation database');
      };
      await assert.rejects(f.owner.resetLocalProjectHealth('project' as ProjectId), /not selected/);
    }
    const [health, evaluations] = await Promise.all([f.owner.getProfileHealth(), f.owner.getEvaluations()]);
    assert.equal(health, f.health);
    assert.equal(evaluations, f.evaluations);
    assert.equal(await f.owner.getProfileHealth(), health);
    assert.equal(await f.owner.getEvaluations(), evaluations);
    await f.owner.dispose();
    assert.equal(f.events.includes('close-health'), mode !== 'managed');
    assert.equal(f.events.includes('close-evaluations'), mode !== 'managed');
    await assert.rejects(f.owner.getProfileHealth(), /shutting down/);
    await assert.rejects(f.owner.getEvaluations(), /shutting down/);
  }
});

test('synchronous operational-store disposal failures cannot prevent other stores from closing', async () => {
  const f = fixture();
  await f.owner.getLocal();
  await f.owner.getProfileHealth();
  await f.owner.getEvaluations();
  const failure = new Error('Synchronous close failure');
  f.health.dispose = () => {
    throw failure;
  };
  await assert.rejects(f.owner.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.ok(f.events.includes('close'));
  assert.ok(f.events.includes('close-evaluations'));
  assert.equal(f.owner.phase, 'closed');
  assert.throws(() => f.owner.getLocal(), /shutting down/);
});

test('catalog shutdown keeps operational stores usable until accepted SQL operations have settled', async () => {
  const f = fixture();
  await f.owner.getLocal();
  const health = await f.owner.getProfileHealth();
  const evaluations = await f.owner.getEvaluations();
  const gate = deferred();
  f.local.dispose = async () => {
    f.events.push('closing-catalog');
    await gate.promise;
    // Accepted operations may still invoke project deletion hooks during drain.
    assert.equal(await f.owner.getProfileHealth(), health);
    assert.equal(await f.owner.getEvaluations(), evaluations);
    f.events.push('catalog-closed');
  };
  const closing = f.owner.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.owner.phase, 'draining');
  assert.ok(!f.events.includes('close-health'));
  assert.ok(!f.events.includes('close-evaluations'));
  gate.resolve();
  await closing;
  assert.ok(f.events.indexOf('catalog-closed') < f.events.indexOf('close-health'));
  assert.ok(f.events.indexOf('catalog-closed') < f.events.indexOf('close-evaluations'));
});

test('unconfirmed catalog termination keeps operational stores open and the owner fenced', async () => {
  const f = fixture();
  await f.owner.getLocal();
  await f.owner.getProfileHealth();
  await f.owner.getEvaluations();
  f.local.dispose = async () => {
    throw new Error('Catalog termination unknown');
  };
  await assert.rejects(f.owner.dispose(), /termination unknown/);
  assert.equal(f.owner.phase, 'draining');
  assert.ok(!f.events.includes('close-health'));
  assert.ok(!f.events.includes('close-evaluations'));
  await f.owner.getProfileHealth();
  await f.owner.getEvaluations();
  assert.equal(f.constructions(), 1);
});
