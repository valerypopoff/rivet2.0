import test from 'node:test';
// test-style: fixture-read: Reads only fresh local HTTP fixture journals and receipts, not implementation source.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
import { prepareStagingActor, stagingActorJob, stagingActorRole } from './lib/reusable-staging-coordinator.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';
import { providerProgressStep, observeProviderProgress } from './lib/provider-progress.mjs';
import {
  acknowledgeProviderPhase,
  acknowledgeProviderFailure,
  registerProviderWorker,
} from './qualification/provider-entry.mjs';
import {
  writeProviderPhaseReceipt,
  readProviderPhaseReceipt,
  describeProviderPhaseReceipt,
  providerPhaseReceiptLimit,
} from './lib/provider-phase-receipt.mjs';
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const startedAt = Date.now();
const operation = {
  operationId: 'rivet-q-123-1',
  startedAt: new Date(startedAt).toISOString(),
  expiresAt: new Date(startedAt + 7200000).toISOString(),
  candidate: { source: { sha: 'a'.repeat(40) } },
  projectId: 'staging-project',
  projectNumber: '123456789',
  staging: { clusterUid: 'staging-cluster' },
};
operation.inputHash = qualificationHash(operation);
const settings = {
  actorImage: `ghcr.io/example/actor@sha256:${'b'.repeat(64)}`,
  runnerNamespace: 'staging-runners',
  controlNamespace: 'staging-control',
  projectId: operation.projectId,
  projectNumber: operation.projectNumber,
  clusterUid: 'staging-cluster',
  inClusterServer: 'https://10.1.0.1/',
  context: 'isolated-staging',
};

async function fixture(t, operationOverride = operation) {
  const operation = operationOverride;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-coordinator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'driver'),
    privateDirectory = path.join(directory, 'private');
  await fs.mkdir(bundle);
  await fs.mkdir(privateDirectory);
  const actorResults = path.join(directory, 'actor-results');
  const code = Buffer.from('// local protocol fixture');
  await fs.writeFile(path.join(bundle, 'provider.mjs'), code);
  const manifest = {
    protocol: 1,
    suite: 'compact-seven-v1',
    provider: 'gke',
    scope: 'isolated-provider',
    entrypoint: 'provider.mjs',
    files: { 'provider.mjs': sha(code) },
  };
  await fs.writeFile(path.join(bundle, 'driver.json'), JSON.stringify(manifest));
  const state = {
    job: null,
    deleted: false,
    uid: 'actor-pod',
    preflightSha: operation.candidate.source.sha,
    commands: [],
    progress: [],
    losePhase: false,
    loseCreate: false,
    creates: 0,
    deletes: 0,
    registry: {
      protocol: 1,
      operation: structuredClone(operation),
      actor: { namespace: settings.runnerNamespace, name: 'actor', uid: 'actor-pod' },
      namespace: `rivet-staging-${operation.operationId}`,
      release: 'rivet-qualification',
      closed: true,
      phase: 'cleaned',
      cleanupVerified: true,
      workers: [],
    },
  };
  const pod = () => ({
    metadata: { name: 'actor', uid: state.uid, ownerReferences: [{ uid: 'job-uid' }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  });
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/version') return json(200, { gitVersion: 'v1.36.4' });
    if (req.url === '/api/v1/namespaces/kube-system') return json(200, { metadata: { uid: settings.clusterUid } });
    const fixtureNamespace = `/api/v1/namespaces/rivet-staging-${operation.operationId}`;
    if (req.url === fixtureNamespace)
      return json(200, { metadata: { uid: state.namespaceUid ?? 'fixture-namespace' } });
    if (req.url === `${fixtureNamespace}/pods`) {
      state.workloadReads = (state.workloadReads ?? 0) + 1;
      await state.beforeWorkloadRead?.();
      return json(200, { items: state.fixturePods ?? [] });
    }
    if (req.url === `/api/v1/namespaces/${settings.controlNamespace}/configmaps/${operation.operationId}`)
      return json(200, {
        metadata: {
          uid: state.registryUid ?? 'operation-registry',
          resourceVersion: '1',
          namespace: settings.controlNamespace,
          labels: { 'rivet.dev/qualification-operation': operation.operationId },
        },
        data: { record: JSON.stringify(state.registry) },
      });
    if (req.url.includes('/jobs')) {
      if (req.method === 'POST') {
        const parts = [];
        for await (const part of req) parts.push(part);
        state.job = JSON.parse(Buffer.concat(parts));
        state.job.metadata.uid = 'job-uid';
        state.creates++;
        if (state.loseCreate) {
          res.destroy();
          return;
        }
        return json(201, state.job);
      }
      if (req.method === 'DELETE') {
        const parts = [];
        for await (const part of req) parts.push(part);
        assert.equal(JSON.parse(Buffer.concat(parts)).preconditions.uid, 'job-uid');
        state.deletes++;
        if (state.failDelete) return json(500, { message: 'actor deletion failed' });
        state.deleted = true;
        return json(200, {});
      }
      return json(state.job ? 200 : 404, state.job ?? {});
    }
    if (req.url.includes('labelSelector=')) return json(200, { items: [pod()] });
    if (req.url.endsWith('/pods/actor')) {
      await state.beforeActorRead?.();
      return json(state.deleted ? 404 : 200, pod());
    }
    return json(404, {});
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => {
    const chunks = [];
    socket.on('message', async (data) => {
      if (data[0] === 0) {
        chunks.push(data.subarray(1));
        return;
      }
      if (data[0] !== 255) return;
      const payload = JSON.parse(Buffer.concat(chunks)),
        command = new URL(req.url, 'http://local').searchParams.getAll('command');
      const phase = command.at(-1);
      state.commands.push({ phase, payload });
      if (state.loseExport && phase === 'export') {
        socket.close(1012);
        return;
      }
      if (state.losePhase && phase === 'prepare') {
        socket.close(1012);
        return;
      }
      if (state.hangPhase && phase === 'prepare') {
        state.deleted = true; // The API loses the exact actor while exec stays open.
        return;
      }
      if (phase === 'receipt') {
        if (state.loseReceiptReads > 0) {
          state.loseReceiptReads--;
          socket.close(1012);
          return;
        }
        try {
          assert.equal(payload.actorUid, state.uid);
          const bytes = await readProviderPhaseReceipt(actorResults, payload.phase, payload.workerId, payload.receipt);
          for (let offset = 0; offset < bytes.length; offset += 65536)
            socket.send(Buffer.concat([Buffer.from([1]), bytes.subarray(offset, offset + 65536)]));
          socket.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
        } catch {
          socket.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Failure"}')]));
        }
        socket.close();
        return;
      }
      if (state.durablePhase === phase) {
        const worker = { id: '123:456', phase, closed: false };
        state.registry.workers.push(worker);
        const finish = async () => {
          await state.beforePhaseFinish?.(state.registry, worker);
          const result = {
            protocol: 1,
            ...Object.fromEntries(
              ['operationId', 'inputHash', 'projectId', 'projectNumber'].map((k) => [k, operation[k]]),
            ),
            value: state.resultLength ? 'x'.repeat(state.resultLength) : 'complete ✓',
          };
          state.mutateProducedResult?.(result);
          const receipt = await writeProviderPhaseReceipt(
            actorResults,
            phase,
            worker.id,
            Buffer.from(JSON.stringify(result)),
          );
          await acknowledgeProviderPhase(
            { change: async (fn) => fn(state.registry) },
            phase,
            worker.id,
            result,
            receipt,
          );
          await state.mutatePhaseReceipt?.(state.registry, actorResults);
        };
        if (state.delayedPhase) {
          const timer = setTimeout(
            () =>
              finish().catch((error) => {
                state.fixtureError = error;
              }),
            80,
          );
          t.after(() => clearTimeout(timer));
        } else if (!state.keepWorkerActive) await finish();
        if (state.closePhaseSocket) socket.close(1012);
        return;
      }
      if (phase === 'verifyCleanup' && state.loseCleanupStatus) {
        const result = {
          protocol: 1,
          ...Object.fromEntries(
            ['operationId', 'inputHash', 'projectId', 'projectNumber'].map((k) => [k, operation[k]]),
          ),
          inventoryComplete: true,
          inventoryHash: qualificationHash([]),
          resources: [],
          uncertainWrites: 0,
        };
        state.registry.workers.push({ id: '123:456', phase, closed: false });
        // Cross the same acknowledgement boundary used by the real provider.
        await acknowledgeProviderPhase({ change: async (fn) => fn(state.registry) }, phase, '123:456', result);
        state.mutateReceipt?.(state.registry);
        socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(result))]));
        if (state.closeCleanupSocket) socket.close(1012);
        return; // Command finished; the status channel never acknowledges it.
      }
      const result =
        phase === 'preflight'
          ? { sourceSha: state.preflightSha, offlineFixturePassed: true }
          : phase === 'install'
            ? { installed: true, files: Object.fromEntries(Object.entries(payload.files).map(([n, f]) => [n, f.hash])) }
            : phase === 'armExpiry'
              ? { identity: 'operation-registry' }
              : phase === 'export'
                ? {
                    files: [
                      {
                        name: 'receipt.json',
                        hash: sha(Buffer.from('{}')),
                        bytes: Buffer.from('{}').toString('base64'),
                      },
                    ],
                  }
                : { phase };
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(result))]));
      socket.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
      if (!state.keepSocketOpen) socket.close();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const api = createKubernetesTransport({
    origin: `http://127.0.0.1:${server.address().port}`,
    allowLoopbackHttp: true,
    token: () => 'coordinator-credential-never-in-actor',
    WebSocketClass: WebSocket,
    timeoutMs: 2000,
  });
  const options = {
    api,
    settings,
    bundle,
    digest: qualificationHash(manifest),
    privateDirectory,
    actorWatchIntervalMs: 10,
    onProgress: (status) => state.progress.push(status),
    wait: async (label, check) => {
      if (label.includes('Ready'))
        assert.equal(
          JSON.parse(await fs.readFile(path.join(privateDirectory, 'actor-job.json'), 'utf8')).uid,
          'job-uid',
        );
      const result = await check();
      assert.ok(result, `${label} must be acknowledged`);
      return result;
    },
  };
  return {
    state,
    options,
    origin: `http://127.0.0.1:${server.address().port}`,
    prepare: () => prepareStagingActor(operation, options),
  };
}

test('hosted coordinator crosses real HTTP/WebSocket stdin/EOF boundaries, journals before admission and closes once after cleanup', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  assert.equal(f.state.commands[0].payload.kubernetesVersion, 'v1.36.4');
  const installed = f.state.commands.find((c) => c.phase === 'install').payload.files;
  const config = JSON.parse(Buffer.from(installed['kubeconfig.json'].bytes, 'base64'));
  assert.equal(config.users[0].user.tokenFile, '/var/run/secrets/kubernetes.io/serviceaccount/token');
  assert.ok(!JSON.stringify(installed).includes('coordinator-credential'));
  assert.deepEqual(await actor.driver.prepare(), { phase: 'prepare' });
  await assert.rejects(actor.driver.prepare(), /Never replay/);
  await actor.close({ cleanupVerified: false });
  assert.equal(f.state.deleted, false);
  await Promise.all([actor.close({ cleanupVerified: true }), actor.close({ cleanupVerified: true })]);
  assert.equal(f.state.deleted, true);
  assert.equal(f.state.commands.filter((c) => c.phase === 'export').length, 1);
  assert.equal(f.state.creates, 1);
});

test('lost remote phase acknowledgement is never replayed or treated as safe deletion', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  f.state.losePhase = true;
  await assert.rejects(actor.driver.prepare(), /outcome is unknown/);
  await assert.rejects(actor.driver.prepare(), /Never replay/);
  await actor.close({ cleanupVerified: false });
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
  assert.equal(f.state.deleted, false);
});

test('verified cleanup removes the exact actor even if export or persistence fails, without replay', async (t) => {
  for (const fault of ['export', 'persist', 'export-and-delete']) {
    const f = await fixture(t);
    let persistFailed = false;
    f.options.persist = async () => {
      if (fault === 'persist' && f.state.commands.some((c) => c.phase === 'export')) {
        persistFailed = true;
        throw Error('diagnostic persistence failed');
      }
    };
    const actor = await f.prepare();
    f.state.loseExport = fault.startsWith('export');
    f.state.failDelete = fault === 'export-and-delete';
    const closing = actor.close({ cleanupVerified: true });
    await assert.rejects(closing, (error) => {
      if (f.state.failDelete) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /unknown/);
        assert.match(error.errors[1].message, /500/);
      } else assert.match(error.message, fault === 'persist' ? /diagnostic persistence failed/ : /unknown/);
      return true;
    });
    assert.equal(actor.close({ cleanupVerified: true }), closing);
    assert.equal(f.state.commands.filter((c) => c.phase === 'export').length, 1);
    assert.equal(f.state.deletes, 1);
    assert.equal(f.state.deleted, !f.state.failDelete);
    assert.equal(persistFailed, fault === 'persist');
  }
});

test('actor removal refuses a replacement Job after verified cleanup', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  f.state.job.metadata.uid = 'replacement-job';
  await assert.rejects(actor.close({ cleanupVerified: true }));
  assert.equal(f.state.deletes, 0);
});

test('remote cleanup shares one deadline through export; expiry fences dispatch but still removes a verified actor', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const expiry of ['none', 'verifyCleanup', 'export']) {
    const f = await fixture(t),
      actor = await f.prepare(),
      timeouts = [];
    const assertTimeouts = (budgets) => {
      assert.equal(timeouts.length, budgets.length);
      timeouts.forEach((ms, i) =>
        assert.ok(ms > 0 && ms <= budgets[i], 'RPC may consume only the remaining shared allowance'),
      );
    };
    f.options.api.withTimeout = (timeoutMs) => {
      return {
        ...f.options.api,
        exec: (...args) => {
          timeouts.push(timeoutMs);
          return f.options.api.exec(...args);
        },
      };
    };
    await actor.driver.settle();
    now += 59 * 60000;
    await actor.driver.cleanup();
    if (expiry === 'verifyCleanup') {
      now += 60000;
      await assert.rejects(actor.driver.verifyCleanup(), /cleanup deadline exceeded/);
      assert.ok(!f.state.commands.some((c) => c.phase === 'verifyCleanup'));
      await actor.close({ cleanupVerified: false });
      assert.ok(!f.state.commands.some((c) => c.phase === 'export'));
      assertTimeouts([3600000, 60000]);
    } else {
      await actor.driver.verifyCleanup();
      if (expiry === 'export') {
        now += 60000;
        await assert.rejects(actor.close({ cleanupVerified: true }), /cleanup deadline exceeded/);
        assert.ok(!f.state.commands.some((c) => c.phase === 'export'));
        assertTimeouts([3600000, 60000, 60000]);
      } else {
        await actor.close({ cleanupVerified: true });
        assertTimeouts([3600000, 60000, 60000, 60000]);
      }
    }
    assert.equal(f.state.deletes, expiry === 'verifyCleanup' ? 0 : 1);
    assert.equal(f.state.deleted, expiry !== 'verifyCleanup');
  }
});

test('a successful Kubernetes status completes each real RPC without waiting for a retained socket', async (t) => {
  const f = await fixture(t);
  f.state.keepSocketOpen = true;
  const actor = await f.prepare();
  assert.deepEqual(await actor.driver.prepare(), { phase: 'prepare' });
  assert.deepEqual(await actor.driver.verifyCleanup(), { phase: 'verifyCleanup' });
  await actor.close({ cleanupVerified: true });
  assert.equal(f.state.deleted, true);
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
  assert.equal(f.state.commands.filter((c) => c.phase === 'verifyCleanup').length, 1);
});

test('lost final exec status uses the exact durable cleanup receipt without replaying the command', async (t) => {
  for (const closeCleanupSocket of [false, true]) {
    const f = await fixture(t),
      actor = await f.prepare();
    await actor.driver.armExpiry();
    f.state.loseCleanupStatus = true;
    f.state.closeCleanupSocket = closeCleanupSocket;
    const result = await actor.driver.verifyCleanup();
    assert.equal(result.inventoryComplete, true);
    assert.equal(result.inputHash, operation.inputHash);
    await actor.close({ cleanupVerified: true });
    assert.equal(f.state.commands.filter((c) => c.phase === 'verifyCleanup').length, 1);
    assert.equal(f.state.deleted, true);
  }
});

test('each long phase recovers its immutable result after lost status without replaying a command', async (t) => {
  for (const phase of ['prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup']) {
    for (const delayed of [false, true]) {
      const f = await fixture(t),
        actor = await f.prepare();
      await actor.driver.armExpiry();
      f.state.registry.closed = ['settle', 'cleanup'].includes(phase);
      f.state.durablePhase = phase;
      f.state.delayedPhase = delayed;
      f.state.closePhaseSocket = delayed;
      const result = await actor.driver[phase]();
      assert.equal(result.value, 'complete ✓');
      assert.equal(result.inputHash, operation.inputHash);
      assert.equal(f.state.fixtureError, undefined);
      assert.equal(f.state.commands.filter((c) => c.phase === phase).length, 1);
      assert.ok(f.state.commands.some((c) => c.phase === 'receipt'));
      await assert.rejects(actor.driver[phase](), /Never replay/);
    }
  }
});

test('phase recovery rejects altered bytes, rebound identities, missing receipts and failed workers', async (t) => {
  for (const mutate of [
    (r, s) => {
      s.registryUid = 'replacement';
    },
    (r) => {
      r.actor.uid = 'replacement';
    },
    (r) => {
      r.operation.inputHash = 'foreign';
    },
    (r) => {
      r.closed = true;
    },
    (r) => {
      r.workers.push({ ...r.workers[0] });
    },
    (r) => {
      r.workers[0].failed = true;
    },
    (r) => {
      delete r.workers[0].receipt;
    },
    (r) => {
      r.workers[0].id = '124:457';
    },
    async (r, s, dir) => {
      const file = path.join(dir, 'phase-receipts', 'prepare-123-456.json');
      const bytes = await fs.readFile(file);
      bytes[bytes.length - 3] ^= 1;
      await fs.writeFile(file, bytes); // Same size; the checksum must reject it.
    },
  ]) {
    const f = await fixture(t),
      actor = await f.prepare();
    await actor.driver.armExpiry();
    f.state.registry.closed = false;
    f.state.durablePhase = 'prepare';
    f.state.closePhaseSocket = true;
    f.state.mutatePhaseReceipt = (r, dir) => mutate(r, f.state, dir);
    await assert.rejects(actor.driver.prepare());
    await assert.rejects(actor.driver.prepare(), /Never replay/);
    assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
    assert.equal(f.state.deleted, false);
  }
});

test('valid receipt bytes cannot recover a result for another operation', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.durablePhase = 'prepare';
  f.state.closePhaseSocket = true;
  f.state.mutateProducedResult = (result) => {
    result.inputHash = 'foreign';
  };
  await assert.rejects(actor.driver.prepare());
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
});

test('a lost read-only receipt transfer retries once while the modifying phase is never replayed', async (t) => {
  for (const losses of [1, 2]) {
    const f = await fixture(t),
      actor = await f.prepare();
    await actor.driver.armExpiry();
    f.state.registry.closed = false;
    f.state.durablePhase = 'prepare';
    f.state.loseReceiptReads = losses;
    const running = actor.driver.prepare();
    if (losses === 1) assert.equal((await running).value, 'complete ✓');
    else await assert.rejects(running, /unknown/);
    assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
    assert.equal(f.state.commands.filter((c) => c.phase === 'receipt').length, 2);
  }
});

test('a receipt near its file limit remains transferable through bounded exec frames and status', async (t) => {
  const f = await fixture(t);
  f.options.api.withTimeout = (timeoutMs) =>
    createKubernetesTransport({
      origin: f.origin,
      allowLoopbackHttp: true,
      WebSocketClass: WebSocket,
      token: () => 'local-only',
      timeoutMs: Math.min(timeoutMs, 10000),
    });
  const actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.durablePhase = 'prepare';
  f.state.resultLength = providerPhaseReceiptLimit - 1024;
  const result = await actor.driver.prepare();
  assert.equal(result.value.length, f.state.resultLength);
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
});

test('a slow diagnostic read cannot hide phase completion behind the original deadline', async (t) => {
  let now = Date.now(),
    advanced = false;
  t.mock.method(Date, 'now', () => now);
  const input = { ...operation, expiresAt: new Date(now + 1000).toISOString() };
  delete input.inputHash;
  input.inputHash = qualificationHash(input);
  const f = await fixture(t, input);
  f.options.stallAfterMs = 20;
  const releasePhase = Promise.withResolvers(),
    releaseSnapshot = Promise.withResolvers();
  const snapshotStarted = Promise.withResolvers(),
    completed = Promise.withResolvers();
  f.options.onProgress = (status) => {
    f.state.progress.push(status);
    if (status.step === 'frontend' && !advanced) {
      advanced = true;
      now += 21;
    }
    if (status.phase === 'prepare' && status.state === 'command-completed') completed.resolve();
  };
  const actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.registry.namespaceUid = 'fixture-namespace';
  f.state.durablePhase = 'prepare';
  f.state.beforePhaseFinish = async (record, worker) => {
    await providerProgressStep(
      { change: async (fn) => fn(record) },
      'prepare',
      worker.id,
      now + 1000,
    )('frontend', () => releasePhase.promise);
  };
  f.state.beforeWorkloadRead = async () => {
    snapshotStarted.resolve();
    await releaseSnapshot.promise;
  };
  const running = actor.driver.prepare(),
    settled = running.catch(() => {});
  let timer;
  try {
    const cutoff = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Completion was hidden by diagnostic I/O')), 2000);
    });
    await Promise.race([snapshotStarted.promise, cutoff]);
    releasePhase.resolve();
    await Promise.race([completed.promise, cutoff]);
  } finally {
    clearTimeout(timer);
    releaseSnapshot.resolve();
    releasePhase.resolve();
    await settled;
  }
  assert.equal((await running).value, 'complete ✓');
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
});

test('phase failure is reported before private evidence upload can block', async (t) => {
  const f = await fixture(t);
  const uploading = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.options.persist = async () => {
    if (f.state.commands.some((c) => c.phase === 'prepare')) {
      uploading.resolve();
      await release.promise;
    }
  };
  const actor = await f.prepare();
  f.state.losePhase = true;
  const running = actor.driver.prepare(),
    settled = running.catch(() => {});
  try {
    await uploading.promise;
    assert.ok(f.state.progress.some((s) => s.phase === 'prepare' && s.state === 'failed'));
  } finally {
    release.resolve();
    await settled;
  }
  await assert.rejects(running, /unknown/);
});

test('private evidence failure preserves the original command failure for diagnosis', async (t) => {
  const f = await fixture(t);
  f.options.persist = async () => {
    if (f.state.commands.some((c) => c.phase === 'prepare')) throw Error('private evidence unavailable');
  };
  const actor = await f.prepare();
  f.state.losePhase = true;
  await assert.rejects(actor.driver.prepare(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /unknown/);
    assert.match(error.errors[1].message, /private evidence unavailable/);
    return true;
  });
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
});

test('actor identity reads consume the original RPC deadline before exec dispatch', async (t) => {
  const now = Date.now();
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => elapsed);
  const input = { ...operation, expiresAt: new Date(now + 1000).toISOString() };
  delete input.inputHash;
  input.inputHash = qualificationHash(input);
  const f = await fixture(t, input),
    actor = await f.prepare();
  const timeouts = [];
  const identityBudgets = [];
  f.options.api.withTimeout = (ms) => ({
    json: (...args) => {
      identityBudgets.push(ms);
      return f.options.api.json(...args);
    },
    exec: (...args) => {
      timeouts.push(ms);
      return f.options.api.exec(...args);
    },
  });
  f.state.beforeActorRead = () => {
    elapsed = 400;
  };
  assert.deepEqual(await actor.driver.prepare(), { phase: 'prepare' });
  assert.deepEqual(timeouts, [600]);
  assert.deepEqual(identityBudgets, [1000]);
});

test('a slow real phase reports its exact wait and captures private readiness diagnostics while the command continues once', async (t) => {
  const f = await fixture(t);
  f.options.progressIntervalMs = 20;
  f.options.stallAfterMs = 50;
  const actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.registry.namespaceUid = 'fixture-namespace';
  f.state.registry.testPhases = { prepare: { state: 'intent' } };
  f.state.fixturePods = [
    {
      metadata: { name: 'fixture-proxy', uid: 'proxy-uid' },
      spec: { containers: [{ env: [{ name: 'KEY', value: 'PRIVATE_ENV_SECRET' }] }] },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'Ready', status: 'False', message: 'PRIVATE_READINESS_REASON' }],
      },
    },
  ];
  const release = Promise.withResolvers();
  f.state.durablePhase = 'prepare';
  f.state.beforePhaseFinish = async (record, worker) => {
    const step = providerProgressStep({ change: async (fn) => fn(record) }, 'prepare', worker.id, Date.now() + 600000);
    await step('frontend', () => release.promise);
  };
  const running = actor.driver.prepare();
  const failure = running.catch(() => {}); // Always observe rejection if a test assertion fails first.
  try {
    const deadline = performance.now() + 4000;
    let text, diagnostic;
    while (performance.now() < deadline) {
      const file = (await fs.readdir(f.options.privateDirectory)).find((name) =>
        name.startsWith('phase-prepare-diagnostic-'),
      );
      if (file) {
        text = await fs.readFile(path.join(f.options.privateDirectory, file), 'utf8');
        try {
          diagnostic = JSON.parse(text);
          break;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(diagnostic, 'A running stalled step must produce its diagnostic before command completion');
    assert.equal(diagnostic.worker.progress.step, 'frontend');
    assert.equal(diagnostic.registry.testPhase.state, 'intent');
    assert.equal(diagnostic.pods[0].conditions[0].message, 'PRIVATE_READINESS_REASON');
    assert.ok(!text.includes('PRIVATE_ENV_SECRET'));
    assert.ok(!JSON.stringify(f.state.progress).includes('PRIVATE_'));
    assert.ok(f.state.progress.some((s) => s.step === 'frontend' && s.diagnostic === 'no-step-progress'));
    assert.equal(f.state.registry.workers[0].closed, false);
  } finally {
    release.resolve();
    await failure;
  }
  assert.equal((await running).value, 'complete ✓');
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
  assert.ok(f.state.progress.some((s) => s.phase === 'prepare' && s.state === 'command-completed'));
});

test('unchanged heartbeats do not reset progress; warnings are bounded and diagnostic failure cannot replay or fail valid work', async () => {
  let now = 1000,
    snapshots = 0;
  const logs = [],
    worker = {
      id: '123:456',
      closed: false,
      progress: { step: 'upgrade', sequence: 1, deadlineAt: 301000, private: 'PRIVATE' },
    };
  const report = observeProviderProgress({
    phase: 'upgrade',
    deadlineAt: 601000,
    log: (s) => logs.push(s),
    now: () => now,
    snapshot: async () => {
      snapshots++;
      throw Error('PRIVATE');
    },
  });
  await report({ worker });
  now += 29999;
  await report({ worker });
  assert.equal(logs.length, 1);
  now += 1;
  await report({ worker });
  assert.equal(logs.length, 2, 'Unchanged steps still report every thirty seconds');
  now = 121000;
  worker.heartbeat = now;
  await report({ worker });
  await report.flush();
  assert.equal(snapshots, 1);
  assert.ok(logs.some((s) => s.diagnostic === 'snapshot-incomplete'));
  assert.equal(logs.at(-1).lastProgressAt, new Date(1000).toISOString());
  now += 180001;
  await report({ worker });
  assert.equal(snapshots, 1, 'One snapshot per unchanged step');
  assert.equal(logs.at(-1).diagnostic, 'step-deadline');
  assert.equal(worker.closed, false, 'A diagnostic cannot kill a valid protected wait');
  worker.progress = { step: 'finalization', sequence: 2, deadlineAt: 501000 };
  await report({ worker });
  assert.equal(logs.at(-1).lastProgressAt, new Date(now).toISOString());
  worker.progress = { step: { private: 'PRIVATE' }, sequence: 3, deadlineAt: -Number.MAX_SAFE_INTEGER };
  await report({ worker });
  assert.equal(logs.at(-1).step, 'starting');
  assert.equal(logs.at(-1).deadlineAt, new Date(601000).toISOString());
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
});

test('private phase receipts bind UTF-8 bytes, forbid overwrite and reject invalid identities and metadata', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-phase-receipt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify({ message: 'complete ✓' }));
  const receipt = await writeProviderPhaseReceipt(directory, 'prepare', '123:456', bytes);
  assert.equal(receipt.bytes, bytes.length);
  assert.deepEqual(await readProviderPhaseReceipt(directory, 'prepare', '123:456', receipt), bytes);
  await assert.rejects(writeProviderPhaseReceipt(directory, 'prepare', '123:456', bytes), { code: 'EEXIST' });
  for (const [phase, id, value] of [
    ['../prepare', '123:456', receipt],
    ['prepare', '../123:456', receipt],
    ['prepare', '123:456', { ...receipt, protocol: 2 }],
    ['prepare', '123:456', { ...receipt, bytes: providerPhaseReceiptLimit + 1 }],
    ['prepare', '123:456', { ...receipt, sha256: 'foreign' }],
  ])
    await assert.rejects(readProviderPhaseReceipt(directory, phase, id, value));
  assert.throws(() => describeProviderPhaseReceipt(Buffer.alloc(0)));
});

test('a disconnected active worker is bounded by the original phase deadline and is never replayed', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now); // Setup latency cannot consume the timeout being tested.
  const input = { ...operation, expiresAt: new Date(now + 400).toISOString() };
  delete input.inputHash;
  input.inputHash = qualificationHash(input);
  const f = await fixture(t, input),
    actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.durablePhase = 'prepare';
  f.state.closePhaseSocket = true;
  f.state.keepWorkerActive = true;
  await assert.rejects(actor.driver.prepare(), /deadline exceeded/);
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
  assert.equal(f.state.registry.workers[0].closed, false);
});

test('failure acknowledgement cannot overwrite success or close a different phase worker', async () => {
  const record = { workers: [{ id: '123:456', phase: 'prepare', closed: false }] };
  const state = { change: async (fn) => fn(record) };
  await assert.rejects(acknowledgeProviderFailure(state, 'upgrade', '123:456'));
  assert.equal(record.workers[0].closed, false);
  await acknowledgeProviderFailure(state, 'prepare', '123:456');
  assert.equal(record.workers[0].failed, true);
  record.workers[0] = { id: '123:456', phase: 'prepare', closed: true, receipt: { sha256: 'success' } };
  await acknowledgeProviderFailure(state, 'prepare', '123:456');
  assert.equal(record.workers[0].failed, undefined);
  assert.equal(record.workers[0].receipt.sha256, 'success');
});

test('actor loss still stops observation promptly after the phase connection is already gone', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.registry.closed = false;
  f.state.durablePhase = 'prepare';
  f.state.keepWorkerActive = true;
  f.state.closePhaseSocket = true;
  const timer = setInterval(() => {
    if (f.state.registry.workers.length) f.state.deleted = true;
  }, 25);
  try {
    await assert.rejects(actor.driver.prepare(), /actor|Actor/);
  } finally {
    clearInterval(timer);
  }
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
});

test('cleanup receipt recovery rejects rebound identity, active writers and foreign results', async (t) => {
  for (const mutate of [
    (r, state) => {
      state.registryUid = 'replacement';
    },
    (r) => {
      r.actor.uid = 'other-actor';
    },
    (r) => {
      r.cleanupReceipt.result.inputHash = 'foreign';
    },
    (r) => {
      r.workers[0].closed = false;
    },
    (r) => {
      r.workers[0].phase = 'upgrade';
    },
    (r) => {
      r.cleanupVerified = false;
    },
  ]) {
    const f = await fixture(t),
      actor = await f.prepare();
    await actor.driver.armExpiry();
    f.state.loseCleanupStatus = true;
    f.state.mutateReceipt = (r) => mutate(r, f.state);
    await assert.rejects(actor.driver.verifyCleanup());
    await assert.rejects(actor.driver.verifyCleanup(), /Never replay/);
    await actor.close({ cleanupVerified: false });
    assert.equal(f.state.deleted, false);
  }
});

test('a lost cleanup status without a durable receipt remains unknown and cannot delete the actor', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  await actor.driver.armExpiry();
  f.state.loseCleanupStatus = true;
  f.state.closeCleanupSocket = true;
  f.state.mutateReceipt = (r) => {
    delete r.cleanupReceipt;
  };
  await assert.rejects(actor.driver.verifyCleanup(), /unknown/);
  await assert.rejects(actor.driver.verifyCleanup(), /Never replay/);
  await actor.close({ cleanupVerified: false });
  assert.equal(f.state.deleted, false);
});

test('a failed phase closes only after exact process absence; concurrent workers and denied reads remain fenced', async () => {
  const actor = { uid: 'actor' },
    prior = { id: '123:456', pid: 123, startTicks: '456', phase: 'upgrade', closed: false },
    worker = { id: '124:457', pid: 124, startTicks: '457', phase: 'settle', closed: false };
  const stat = (ticks) => `123 (phase process) ${[...Array(19).fill('0'), ticks].join(' ')}`;
  for (const mode of ['absent', 'reused', 'alive', 'denied', 'raced']) {
    let record = { actor, workers: [structuredClone(prior)] };
    const state = {
      read: async () => ({ record: structuredClone(record) }),
      change: async (fn) => {
        if (mode === 'raced') record.workers.push({ ...worker, id: 'concurrent' });
        const next = structuredClone(record);
        fn(next);
        record = next;
      },
    };
    const read = async () => {
      if (mode === 'absent') throw Object.assign(Error('gone'), { code: 'ENOENT' });
      if (mode === 'denied') throw Object.assign(Error('denied'), { code: 'EACCES' });
      return stat(['reused', 'raced'].includes(mode) ? '999' : '456');
    };
    const running = registerProviderWorker(state, actor, worker, read);
    if (['absent', 'reused'].includes(mode)) {
      await running;
      assert.equal(record.workers[0].closed, true);
      assert.deepEqual(record.workers[1], worker);
    } else {
      await assert.rejects(running);
      assert.equal(record.workers[0].closed, false);
      assert.ok(!record.workers.some((w) => w.id === worker.id));
    }
  }
});

test('source mismatch and actor replacement stop before another remote action', async (t) => {
  const first = await fixture(t);
  first.state.preflightSha = 'c'.repeat(40);
  await assert.rejects(first.prepare());
  assert.equal(first.state.commands.length, 1);
  const second = await fixture(t),
    actor = await second.prepare();
  second.state.uid = 'replacement';
  await assert.rejects(actor.driver.prepare(), /Actor was replaced/);
  assert.equal(second.state.commands.length, 2);
  const [file] = (await fs.readdir(second.options.privateDirectory)).filter((name) =>
    name.startsWith('phase-prepare-diagnostic-'),
  );
  const diagnostic = JSON.parse(await fs.readFile(path.join(second.options.privateDirectory, file), 'utf8'));
  assert.equal(diagnostic.actorUid, 'actor-pod');
  assert.equal(diagnostic.actor.actualUid, 'replacement', 'Failure diagnostics must re-read the remote actor');
});

test('an uncertain Job create is not retried and its finite deadline remains independent of the hosted runner', async (t) => {
  const f = await fixture(t);
  f.state.loseCreate = true;
  await assert.rejects(f.prepare());
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.job.spec.backoffLimit, 0);
  assert.equal(f.state.job.spec.activeDeadlineSeconds, 10800);
  assert.equal(f.state.commands.length, 0);
  assert.ok((await fs.stat(path.join(f.options.privateDirectory, 'actor-create-intent.json'))).size > 0);
});

test('actor manifest has only in-cluster identity, pinned image and finite lifetime; probe RBAC includes scale and eviction', () => {
  const job = stagingActorJob(operation, settings),
    container = job.spec.template.spec.containers[0];
  assert.equal(container.image, settings.actorImage);
  assert.equal(job.spec.template.metadata.annotations['cluster-autoscaler.kubernetes.io/safe-to-evict'], 'false');
  assert.equal(job.spec.activeDeadlineSeconds, 10800, 'Eviction protection never extends the absolute lifetime');
  assert.deepEqual(container.env.map((e) => e.name).sort(), [
    'KUBECONFIG',
    'POD_NAME',
    'POD_UID',
    'RIVET_QUALIFICATION_SOURCE_ROOT',
  ]);
  const rules = stagingActorRole('fixture').rules;
  assert.ok(rules.some((r) => r.resources.includes('deployments/scale') && r.verbs.includes('patch')));
  assert.ok(rules.some((r) => r.resources.includes('pods/eviction') && r.verbs.includes('create')));
  assert.throws(() => stagingActorJob(operation, { ...settings, actorImage: 'actor:latest' }));
});

test('actor loss closes a silent real exec promptly and never replays the phase or deletes an unverified actor', async (t) => {
  const f = await fixture(t),
    actor = await f.prepare();
  f.state.hangPhase = true;
  await assert.rejects(actor.driver.prepare(), /aborted/);
  assert.equal(f.state.commands.filter((c) => c.phase === 'prepare').length, 1);
  await assert.rejects(actor.driver.prepare(), /Never replay/);
  await actor.close({ cleanupVerified: false });
  assert.equal(f.state.creates, 1);
  const logs = await fs.readdir(f.options.privateDirectory);
  const loss = JSON.parse(
    await fs.readFile(
      path.join(
        f.options.privateDirectory,
        logs.find((n) => n.startsWith('actor-loss-')),
      ),
      'utf8',
    ),
  );
  assert.equal(loss.expectedPodUid, 'actor-pod');
  assert.equal(loss.outcome, 'unknown-no-replay');
});
