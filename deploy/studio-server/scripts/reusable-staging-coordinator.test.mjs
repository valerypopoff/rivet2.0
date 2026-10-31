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
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const operation = {
  operationId: 'rivet-q-123-1',
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7200000).toISOString(),
  candidate: { source: { sha: 'a'.repeat(40) } },
};
const settings = {
  actorImage: `ghcr.io/example/actor@sha256:${'b'.repeat(64)}`,
  runnerNamespace: 'staging-runners',
  clusterUid: 'staging-cluster',
  inClusterServer: 'https://10.1.0.1/',
  context: 'isolated-staging',
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-coordinator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'driver'),
    privateDirectory = path.join(directory, 'private');
  await fs.mkdir(bundle);
  await fs.mkdir(privateDirectory);
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
    losePhase: false,
    loseCreate: false,
    creates: 0,
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
        state.deleted = true;
        return json(200, {});
      }
      return json(state.job ? 200 : 404, state.job ?? {});
    }
    if (req.url.includes('labelSelector=')) return json(200, { items: [pod()] });
    if (req.url.endsWith('/pods/actor')) return json(state.deleted ? 404 : 200, pod());
    return json(404, {});
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => {
    const chunks = [];
    socket.on('message', (data) => {
      if (data[0] === 0) {
        chunks.push(data.subarray(1));
        return;
      }
      if (data[0] !== 255) return;
      const payload = JSON.parse(Buffer.concat(chunks)),
        command = new URL(req.url, 'http://local').searchParams.getAll('command');
      const phase = command.at(-1);
      state.commands.push({ phase, payload });
      if (state.losePhase && phase === 'prepare') {
        socket.close(1012);
        return;
      }
      const result =
        phase === 'preflight'
          ? { sourceSha: state.preflightSha, offlineFixturePassed: true }
          : phase === 'install'
            ? { installed: true, files: Object.fromEntries(Object.entries(payload.files).map(([n, f]) => [n, f.hash])) }
            : phase === 'export'
              ? {
                  files: [
                    { name: 'receipt.json', hash: sha(Buffer.from('{}')), bytes: Buffer.from('{}').toString('base64') },
                  ],
                }
              : { phase };
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(result))]));
      socket.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
      socket.close();
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
  return { state, options, prepare: () => prepareStagingActor(operation, options) };
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
