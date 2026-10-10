import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { createCatalogWorker } from '../local-metadata/catalog-worker-client.js';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { configureStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';

function controlledCatalogWorker() {
  const messages: Array<{ id: number; method: string }> = [];
  const worker = Object.assign(new EventEmitter(), {
    postMessage(message: { id: number; method: string }) {
      messages.push(message);
    },
    ref() {},
    unref() {},
    terminate: async () => 0,
  });
  const options = { databasePath: 'selected/catalog.sqlite', artifactRoot: 'selected/objects' };
  let startedOptions: unknown;
  const catalog = createCatalogWorker(options, (_entry, config) => {
    startedOptions = config?.workerData.options;
    return worker as unknown as Worker;
  });
  const finish = (index: number) => worker.emit('message', { id: messages[index]!.id, value: undefined });
  return {
    catalog,
    messages,
    finish,
    options,
    get startedOptions() {
      return startedOptions;
    },
  };
}

test('worker metrics count queued work and clear reservations only after termination', async () => {
  const metrics = configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  try {
    const { catalog, finish } = controlledCatalogWorker();
    const first = catalog.checkHealth();
    const second = catalog.listFolders();
    assert.match(metrics.render(), /rivet_catalog_worker_pending_operations\{profile="control"\} 2/);
    assert.match(metrics.render(), /rivet_catalog_worker_active_operations\{profile="control"\} 1/);
    finish(0);
    await first;
    finish(1);
    await second;
    const closing = catalog.close();
    finish(2);
    await closing;
    assert.match(metrics.render(), /rivet_catalog_worker_pending_operations\{profile="control"\} 0/);
    assert.match(metrics.render(), /rivet_catalog_worker_instances\{profile="control"\} 0/);
    assert.doesNotMatch(metrics.render(), /selected\/|catalog.sqlite/);
  } finally {
    resetStudioMetricsForTests();
  }
});

test('closing an unused catalog does not initialize a worker just to shut it down', async () => {
  let starts = 0;
  const catalog = createCatalogWorker({ databasePath: 'unused', artifactRoot: 'unused' }, () => {
    starts++;
    throw new Error('must not start');
  });
  await catalog.close();
  await catalog.close();
  await catalog.waitForIdle();
  assert.equal(starts, 0);
  await assert.rejects(catalog.listFolders(), /closing/);
});

test('bounded admission rejects excess operations but always admits shutdown', async () => {
  const { catalog, finish, messages } = controlledCatalogWorker();
  const accepted = Array.from({ length: 64 }, () => catalog.checkHealth());
  await assert.rejects(catalog.checkHealth(), /queue is full/);
  assert.equal(catalog.getPendingOperationCount(), 64);
  const closing = catalog.close();
  assert.equal(catalog.getPendingOperationCount(), 65);
  for (let index = 0; index < 65; index++) finish(index);
  await Promise.all([...accepted, closing]);
  assert.equal(messages.length, 65);
  assert.equal(catalog.getPendingOperationCount(), 0);
});

test('queued cancellation releases admission capacity without dispatching a write', async () => {
  const { catalog, messages, finish } = controlledCatalogWorker();
  const active = catalog.checkHealth();
  const controller = new AbortController();
  const queued = catalog.withSignal(controller.signal).importFolder('canceled');
  const rejected = assert.rejects(queued, /cancel before dispatch/);
  const next = catalog.listFolders();
  assert.equal(catalog.getPendingOperationCount(), 3);
  controller.abort(new Error('cancel before dispatch'));
  await rejected;
  assert.equal(catalog.getPendingOperationCount(), 2);
  assert.deepEqual(
    messages.map((message) => message.method),
    ['checkHealth'],
  );
  let idle = false;
  const draining = catalog.waitForIdle().then(() => {
    idle = true;
  });
  finish(0);
  await active;
  assert.equal(idle, false);
  assert.deepEqual(
    messages.map((message) => message.method),
    ['checkHealth', 'listFolders'],
  );
  finish(1);
  await Promise.all([next, draining]);
  assert.equal(idle, true);
  const closed = catalog.close();
  finish(2);
  await closed;
});

test('dispatched work ignores cancellation and keeps drain pending until its outcome is known', async () => {
  const { catalog, finish } = controlledCatalogWorker();
  const controller = new AbortController();
  let settled = false;
  const active = catalog
    .withSignal(controller.signal)
    .importFolder('committed')
    .then(() => {
      settled = true;
    });
  controller.abort(new Error('too late to cancel safely'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(catalog.getPendingOperationCount(), 1);
  const stopWaiting = new AbortController();
  const draining = catalog.waitForIdle(stopWaiting.signal);
  stopWaiting.abort(new Error('stop waiting, not the write'));
  await assert.rejects(draining, /stop waiting, not the write/);
  assert.equal(catalog.getPendingOperationCount(), 1);
  finish(0);
  await active;
  assert.equal(settled, true);
  await catalog.waitForIdle();
  const closed = catalog.withSignal(controller.signal).close();
  finish(1);
  await closed;
});

test('worker generation is captured at construction and pre-aborted calls do not start it', async () => {
  const fixture = controlledCatalogWorker();
  fixture.options.databasePath = 'other/catalog.sqlite';
  fixture.options.artifactRoot = 'other/objects';
  await assert.rejects(
    fixture.catalog.withSignal(AbortSignal.abort(new Error('already canceled'))).checkHealth(),
    /already canceled/,
  );
  assert.equal(fixture.startedOptions, undefined);
  const ready = fixture.catalog.initialize();
  assert.deepEqual(fixture.startedOptions, {
    databasePath: 'selected/catalog.sqlite',
    artifactRoot: 'selected/objects',
  });
  fixture.finish(0);
  await ready;
  const closed = fixture.catalog.close();
  fixture.finish(1);
  await closed;
});

test('catalog worker owns SQL operations and preserves atomic publication and lifecycle errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-catalog-worker-'));
  const options = { databasePath: path.join(root, 'catalog.sqlite'), artifactRoot: path.join(root, 'objects') };
  const seed = new LocalWorkflowCatalog(options);
  seed.initialize();
  seed.close();
  const catalog = createCatalogWorker(options);
  try {
    await catalog.initialize({ requireExisting: true });
    await catalog.importFolder('folder');
    assert.deepEqual(await catalog.readStructure(), { expectedFolders: ['folder'], expectedProjectPaths: [] });
    await catalog.checkHealth();
    // A lock on another connection must not block the main thread's heartbeat.
    const blocker = new DatabaseSync(options.databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    const pending = catalog.importFolder('second');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    blocker.exec('ROLLBACK');
    blocker.close();
    await pending;
    assert.deepEqual(await catalog.listFolders(), ['folder', 'second']);
    await assert.rejects(catalog.importFolder('../escape'), /path|invalid/i);
    await catalog.checkHealth();
    const contents = createBlankProjectFile('Captured');
    const snapshot = {
      workflowId: loadProjectFromString(contents).metadata.id,
      relativePath: 'Captured.rivet-project',
      fileName: 'Captured.rivet-project',
      name: 'Captured',
      updatedAt: '2026-10-10T00:00:00.000Z',
      contents,
      datasetsContents: null,
      endpointName: '',
      endpointAccess: 'public' as const,
      endpointStatus: 'unpublished' as const,
      publicationVersion: '0',
      publishedEndpointName: '',
      publishedVersionId: null,
      lastPublishedAt: null,
      publishedContents: null,
      publishedDatasetsContents: null,
      publishedVersions: [],
      publishedWebApps: [],
    };
    const ahead = catalog.importFolder('ahead');
    const captured = catalog.importProject(snapshot);
    snapshot.relativePath = 'Changed.rivet-project';
    snapshot.name = 'Changed';
    await Promise.all([ahead, captured]);
    assert.equal((await catalog.readProject('Captured.rivet-project'))?.name, 'Captured');
    assert.equal(await catalog.readProject('Changed.rivet-project'), null);
    const burst = Array.from({ length: 66 }, (_, index) => catalog.importFolder(`queued-${index}`));
    const outcomes = await Promise.allSettled(burst);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 64);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'local_storage_busy');
    // Close is admitted even when the ordinary queue is full, and drains it.
    const accepted = Array.from({ length: 64 }, (_, index) => catalog.importFolder(`drained-${index}`));
    const closed = catalog.close();
    await Promise.all([...accepted, closed]);
    const durable = new LocalWorkflowCatalog(options);
    try {
      durable.initialize({ requireExisting: true });
      assert.equal(durable.listFolders().filter((folder) => folder.startsWith('drained-')).length, 64);
    } finally {
      durable.close();
    }
    await catalog.close();
    await catalog.close();
    await assert.rejects(catalog.listFolders(), /closing/);
  } finally {
    await catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const failClose of [false, true])
  test(`${failClose ? 'failed' : 'normal'} close waits for worker termination acknowledgement`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-catalog-worker-close-'));
    const options = { databasePath: path.join(root, 'catalog.sqlite'), artifactRoot: path.join(root, 'objects') };
    let releaseTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminationStarted!: () => void;
    const terminating = new Promise<void>((resolve) => {
      terminationStarted = resolve;
    });
    const catalog = createCatalogWorker(options, (entry, workerOptions) => {
      const worker = new Worker(entry, workerOptions);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => {
        terminationStarted();
        const code = await terminate();
        await terminationGate;
        return code;
      };
      if (failClose) {
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message, transferList) => {
          if (message.method === 'close') {
            // Simulate a close RPC failure while the actual worker still owns SQL.
            queueMicrotask(() =>
              worker.emit('message', {
                id: message.id,
                error: { message: 'Injected close failure', name: 'Error', properties: {} },
              }),
            );
          } else postMessage(message, transferList);
        };
      }
      return worker;
    });
    try {
      await catalog.initialize();
      let finished = false;
      let drained = false;
      const closing = catalog.close();
      const idle = catalog.waitForIdle().then(() => {
        drained = true;
      });
      void closing.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await terminating;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false, 'catalog close acknowledgement alone is not worker shutdown');
      assert.equal(drained, false, 'maintenance drain must also wait for normal worker shutdown');
      assert.equal(catalog.getPendingOperationCount(), 1, 'close remains pending until termination acknowledgement');
      await assert.rejects(catalog.importFolder('after-close'), /closing/);
      releaseTermination();
      if (failClose) await assert.rejects(closing, /Injected close failure/);
      else await closing;
      await idle;
      assert.equal(catalog.getPendingOperationCount(), 0);
      assert.equal(finished, true);
      if (!failClose) await catalog.close();
    } finally {
      releaseTermination();
      await catalog.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('worker loss fences pending leases until termination and never replays queued writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-catalog-worker-loss-'));
  const options = { databasePath: path.join(root, 'catalog.sqlite'), artifactRoot: path.join(root, 'objects') };
  let worker!: Worker;
  let starts = 0;
  let releaseTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => {
    releaseTermination = resolve;
  });
  const catalog = createCatalogWorker(options, (entry, workerOptions) => {
    starts += 1;
    worker = new Worker(entry, workerOptions);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = async () => {
      const code = await terminate();
      await terminationGate;
      return code;
    };
    return worker;
  });
  try {
    await catalog.initialize();
    const active = catalog.importFolder('uncertain');
    const queued = catalog.importFolder('never-dispatched');
    const outcomes = Promise.allSettled([active, queued]);
    let finished = false;
    let drained = false;
    const idle = catalog.waitForIdle().then(() => {
      drained = true;
    });
    void outcomes.then(() => {
      finished = true;
    });
    worker.emit('error', new Error('Injected worker loss'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(finished, false, 'write leases must remain pending until worker termination completes');
    assert.equal(drained, false, 'catalog drain must also await worker termination');
    assert.equal(catalog.getPendingOperationCount(), 2);
    await assert.rejects(catalog.listFolders(), { code: 'local_storage_worker_unavailable', status: 503 });
    const closing = catalog.close();
    releaseTermination();
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.equal(outcome.reason.code, 'local_storage_worker_unavailable');
        assert.match(outcome.reason.message, /outcome may be unknown/);
      }
    }
    await closing;
    await idle;
    assert.equal(catalog.getPendingOperationCount(), 0);
    assert.equal(starts, 1, 'a failed worker is never silently restarted');
    const durable = new LocalWorkflowCatalog(options);
    try {
      durable.initialize({ requireExisting: true });
      assert.equal(durable.listFolders().includes('never-dispatched'), false);
    } finally {
      durable.close();
    }
  } finally {
    releaseTermination();
    await catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const failurePath of ['worker-loss', 'close'] as const)
  test(`${failurePath}: a rejected termination request cannot release drain before actual exit`, async () => {
    let terminationStarted!: () => void;
    const terminating = new Promise<void>((resolve) => {
      terminationStarted = resolve;
    });
    const messages: Array<{ id: number; method: string }> = [];
    const worker = Object.assign(new EventEmitter(), {
      postMessage(message: { id: number; method: string }) {
        messages.push(message);
      },
      ref() {},
      unref() {},
      terminate: async () => {
        terminationStarted();
        throw new Error('termination request failed');
      },
    });
    const catalog = createCatalogWorker(
      { databasePath: 'controlled/catalog.sqlite', artifactRoot: 'controlled/objects' },
      () => worker as unknown as Worker,
    );
    const active = catalog.importFolder('unknown-outcome');
    const activeResult = Promise.allSettled([active]);
    let closing: Promise<void>;
    if (failurePath === 'worker-loss') {
      worker.emit('error', new Error('injected worker error'));
      closing = catalog.close();
    } else {
      closing = catalog.close();
      worker.emit('message', { id: messages[0]!.id });
      await active;
      worker.emit('message', { id: messages[1]!.id });
    }
    const closeResult = assert.rejects(closing, /termination request failed/);
    let drained = false;
    let closed = false;
    const idle = catalog.waitForIdle().then(() => {
      drained = true;
    });
    void closing.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    try {
      await terminating;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false);
      assert.equal(closed, false);
      assert.equal(catalog.getPendingOperationCount(), 1);
      // Repeated shutdown errors are contained, but do not confirm termination.
      worker.emit('error', new Error('another shutdown error'));
      assert.equal(catalog.getPendingOperationCount(), 1);
      const controller = new AbortController();
      const abandonedWait = catalog.waitForIdle(controller.signal);
      controller.abort(new Error('drain timed out'));
      await assert.rejects(abandonedWait, /drain timed out/);
      assert.equal(catalog.getPendingOperationCount(), 1);
    } finally {
      worker.emit('exit', 1);
    }
    await Promise.all([idle, closeResult]);
    assert.equal(catalog.getPendingOperationCount(), 0);
    assert.equal(drained, true);
    const outcomes = await activeResult;
    if (failurePath === 'worker-loss') {
      assert.equal(outcomes[0]!.status, 'rejected');
      if (outcomes[0]!.status === 'rejected')
        assert.equal(outcomes[0]!.reason.code, 'local_storage_worker_unavailable');
    } else assert.equal(outcomes[0]!.status, 'fulfilled');
    assert.equal(worker.listenerCount('error'), 0);
    assert.equal(worker.listenerCount('exit'), 0);
  });

test('an already-confirmed worker exit fails pending jobs without waiting for a second exit event', async () => {
  let terminationRequests = 0;
  const worker = Object.assign(new EventEmitter(), {
    postMessage() {},
    ref() {},
    unref() {},
    terminate: async () => {
      terminationRequests++;
      throw new Error('already exited');
    },
  });
  const catalog = createCatalogWorker(
    { databasePath: 'controlled/catalog.sqlite', artifactRoot: 'controlled/objects' },
    () => worker as unknown as Worker,
  );
  const pending = catalog.importFolder('unknown-outcome');
  const rejected = assert.rejects(pending, { code: 'local_storage_worker_unavailable' });
  worker.emit('exit', 1);
  await Promise.all([rejected, catalog.close(), catalog.waitForIdle()]);
  assert.equal(catalog.getPendingOperationCount(), 0);
  assert.equal(terminationRequests, 0);
  assert.equal(worker.listenerCount('exit'), 0);
  assert.equal(worker.listenerCount('error'), 0);
});

test('synchronous termination failure also waits for confirmed exit', async () => {
  const worker = Object.assign(new EventEmitter(), {
    postMessage() {},
    ref() {},
    unref() {},
    terminate() {
      throw new Error('synchronous termination failure');
    },
  });
  const catalog = createCatalogWorker(
    { databasePath: 'controlled/catalog.sqlite', artifactRoot: 'controlled/objects' },
    () => worker as unknown as Worker,
  );
  const pending = catalog.importFolder('unknown-outcome');
  const rejected = assert.rejects(pending, { code: 'local_storage_worker_unavailable' });
  worker.emit('error', new Error('worker unavailable'));
  const closing = assert.rejects(catalog.close(), /synchronous termination failure/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(catalog.getPendingOperationCount(), 1);
  worker.emit('exit', 1);
  await Promise.all([rejected, closing, catalog.waitForIdle()]);
  assert.equal(catalog.getPendingOperationCount(), 0);
});
