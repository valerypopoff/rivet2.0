import assert from 'node:assert/strict';
// test-style: fixture-read: Read only generated local TLS certificates used by the real HTTP/WebSocket client, never implementation text.
import test from 'node:test';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createFaultTransport, classifyRequest } from './qualification/fault-transport.mjs';

import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
import { verifyStagingTls } from './lib/reusable-staging-prerequisites.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
const { WebSocketServer, WebSocket } = createRequire(
  new URL('../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');
const namespace = 'rivet-staging-rivet-q-123-1',
  release = 'rivet-qualification';
const journalName = releaseOperationJournalName(release),
  scope = { namespace, release, journalName };
const metrics = '/apis/metrics.k8s.io/v1beta1/namespaces/rivet-staging-rivet-q-123-1/pods';
const scale =
  '/apis/apps/v1/namespaces/rivet-staging-rivet-q-123-1/statefulsets/rivet-qualification-ha-execution/scale';
const certificates = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-private-tls-fixture-'));
const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(certificates, 'key.pem'),
    '-out',
    path.join(certificates, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ],
  { stdio: 'pipe' },
);
const tls = {
  key: await fs.readFile(path.join(certificates, 'key.pem')),
  cert: await fs.readFile(path.join(certificates, 'cert.pem')),
};
test.after(async () => {
  assert.equal(path.dirname(certificates), path.resolve(os.tmpdir()));
  assert.ok(path.basename(certificates).startsWith('rivet-private-tls-fixture-'));
  await fs.rm(certificates, { recursive: true });
});
async function fixture(fn, { execOutput, execStderr, execStatus = 'Success' } = {}) {
  let writes = 0,
    reads = 0,
    current = { mode: 'pass', rv: 1 };
  const upstream = https.createServer(tls, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    if (req.url === metrics) {
      reads++;
      res.end(
        JSON.stringify({
          kind: 'PodMetricsList',
          items: [
            {
              metadata: { name: 'worker' },
              timestamp: new Date().toISOString(),
              containers: [{ usage: { cpu: '100m' } }],
            },
          ],
        }),
      );
    } else if (req.url === scale && req.method === 'GET')
      res.end(
        JSON.stringify({
          metadata: { uid: 'actual-workload-uid', resourceVersion: String(writes) },
          spec: { replicas: 2 + writes },
        }),
      );
    else if (req.url === scale && req.method === 'PATCH') {
      const patch = JSON.parse(body);
      assert.equal(patch[0].value, 'actual-workload-uid');
      assert.equal(patch[1].value, String(writes));
      assert.equal(patch[2].value, 2 + writes);
      assert.equal(patch[3].value, 3 + writes);
      writes++;
      res.end(
        JSON.stringify({
          metadata: { uid: 'actual-workload-uid', resourceVersion: String(writes) },
          spec: { replicas: 2 + writes },
        }),
      );
    } else {
      res.writeHead(501);
      res.end('{"kind":"Status","reason":"NotModeled"}');
    }
  });
  const ws = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) =>
    ws.handleUpgrade(req, socket, head, (client) => {
      assert.equal(req.headers.authorization, 'Bearer local-test-only');
      const output = Buffer.from(execOutput ?? '{"state":"serving"}'),
        cut = output.indexOf(Buffer.from('é')) + 1;
      if (execStderr) client.send(Buffer.concat([Buffer.from([2]), Buffer.from(execStderr)]));
      if (cut > 0) client.send(Buffer.concat([Buffer.from([1]), output.subarray(0, cut)]));
      client.send(Buffer.concat([Buffer.from([1]), cut > 0 ? output.subarray(cut) : output]));
      client.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: execStatus }))]));
      client.close();
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createFaultTransport({
    ...scope,
    maxReplicas: 7,
    tls,
    upstream: `https://127.0.0.1:${upstream.address().port}`,
    upstreamCa: tls.cert,
    readControl: async () => structuredClone(current),
    replaceControl: async (before, after) => {
      assert.equal(before.rv, current.rv, 'real control resourceVersion conflict');
      current = { ...structuredClone(after), rv: current.rv + 1 };
      return structuredClone(current);
    },
    timeoutMs: 2000,
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const origin = `https://127.0.0.1:${proxy.server.address().port}`;
  const client = createKubernetesTransport({
    origin,
    token: () => 'local-test-only',
    ca: () => tls.cert,
    WebSocketClass: WebSocket,
    timeoutMs: 3000,
  });
  try {
    await fn({
      client,
      origin,
      mode: (mode) => {
        current = { mode, rv: current.rv + 1 };
      },
      state: () => current,
      counts: () => ({ writes, reads }),
    });
  } finally {
    await proxy.close();
    for (const client of ws.clients) client.terminate();
    ws.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}
test('phase diagnostics remain private while explicit exit status and split UTF-8 output stay authoritative', async () => {
  const route = `/api/v1/namespaces/${namespace}/pods/${release}-ha-execution-0/exec`,
    options = { execOutput: '{"label":"étape"}', execStderr: 'private progress' };
  await fixture(async (f) => {
    const chunks = [];
    assert.deepEqual(JSON.parse(await f.client.exec(route, ['node', 'fixture'], { onStderr: (c) => chunks.push(c) })), {
      label: 'étape',
    });
    assert.equal(Buffer.concat(chunks).toString(), 'private progress');
    await assert.rejects(f.client.exec(route, ['node', 'fixture']), /successful exit/);
  }, options);
  await fixture(
    async (f) => {
      await assert.rejects(f.client.exec(route, ['node', 'fixture'], { onStderr: () => {} }), /successful exit/);
    },
    { ...options, execStatus: 'Failure' },
  );
});

test('fixture uses source-owned journal identity and rejects foreign namespaces, encoded paths and arbitrary writes', () => {
  assert.equal(journalName, releaseOperationJournalName(release));
  assert.equal(
    classifyRequest('GET', `/api/v1/namespaces/rivet-staging-rivet-q-123-1/configmaps/${journalName}`, scope),
    'json',
  );
  for (const [method, route] of [
    ['DELETE', '/api/v1/namespaces/default'],
    ['GET', '//foreign.invalid/'],
    ['GET', '/api/v1/namespaces/rivet-staging-rivet-q-123-1/pods%2Fsecret'],
    ['PUT', scale],
    ['GET', '/api/v1/namespaces/production/pods'],
  ])
    assert.throws(() => classifyRequest(method, route, scope));
});
test('actual strict-TLS Kubernetes client sees missing and stale metric observations without upstream mutation', async () =>
  fixture(async (f) => {
    assert.equal((await f.client.json('GET', metrics)).kind, 'PodMetricsList');
    f.mode('metrics-missing');
    await assert.rejects(f.client.json('GET', metrics), /503/);
    assert.equal(f.state().missingResponses, 1);
    assert.deepEqual(f.counts(), { writes: 0, reads: 1 });
    f.mode('metrics-stale');
    const result = await f.client.json('GET', metrics);
    assert.ok(Date.now() - Date.parse(result.items[0].timestamp) >= 600000);
    assert.equal(result.items[0].containers[0].usage.cpu, '100m');
    assert.equal(f.state().staleResponses, 1);
    f.mode('pass');
    assert.ok(Date.now() - Date.parse((await f.client.json('GET', metrics)).items[0].timestamp) < 10000);
  }));
test('one accepted scale response is really lost, recorded durably before socket close and never replayed by proxy', async () =>
  fixture(async (f) => {
    f.mode('lose-scale-ack-once');
    const patch = [
      { op: 'test', path: '/metadata/uid', value: 'actual-workload-uid' },
      { op: 'test', path: '/metadata/resourceVersion', value: '0' },
      { op: 'test', path: '/spec/replicas', value: 2 },
      { op: 'replace', path: '/spec/replicas', value: 3 },
    ];
    await assert.rejects(f.client.json('PATCH', scale, patch, 'application/json-patch+json'));
    assert.equal(f.counts().writes, 1);
    assert.equal(f.state().scaleAttempt.state, 'accepted-response-suppressed');
    assert.deepEqual(f.state().scaleAttempt.identity, {
      uid: 'actual-workload-uid',
      resourceVersion: '1',
      replicas: 3,
    });
    await f.client.json('GET', metrics);
    assert.equal(f.counts().writes, 1);
    assert.equal((await f.client.json('GET', scale)).spec.replicas, 3);
    const next = structuredClone(patch);
    next[1].value = '1';
    next[2].value = 3;
    next[3].value = 4;
    const result = await f.client.json('PATCH', scale, next, 'application/json-patch+json');
    assert.equal(result.spec.replicas, 4);
    assert.equal(f.counts().writes, 2);
    assert.deepEqual(
      f.state().scaleWrites.map(({ from, to }) => [from, to]),
      [
        [2, 3],
        [3, 4],
      ],
    );
  }));
test('real authenticated Kubernetes WebSocket exec crosses both verified TLS connections', async () =>
  fixture(async (f) => {
    const output = await f.client.exec(
      '/api/v1/namespaces/rivet-staging-rivet-q-123-1/pods/rivet-qualification-ha-execution-0/exec',
      ['node', '/opt/rivet/retire-backend.mjs'],
    );
    assert.deepEqual(JSON.parse(output), { state: 'serving' });
  }));
test('transport rejects an untrusted public/system CA chain rather than disabling TLS', async () =>
  fixture(async (f) => {
    const client = createKubernetesTransport({
      origin: f.origin,
      token: () => 'local-test-only',
      ca: () => Buffer.from('not a trusted CA'),
    });
    await assert.rejects(client.json('GET', metrics));
    assert.deepEqual(f.counts(), { writes: 0, reads: 0 });
  }));

test('public staging TLS prerequisite verifies trust and hostname without sending HTTP or credentials', async () =>
  fixture(async (f) => {
    await verifyStagingTls(f.origin, { ca: tls.cert });
    await assert.rejects(verifyStagingTls(f.origin));
    await assert.rejects(
      verifyStagingTls(f.origin.replace('127.0.0.1', 'localhost'), {
        ca: tls.cert,
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
      }),
      /hostname|altnames/i,
    );
    assert.deepEqual(f.counts(), { writes: 0, reads: 0 });
  }));

test('public staging TLS prerequisite bounds a peer that accepts TCP but never completes TLS', async (t) => {
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of connections) socket.destroy();
    server.close();
  });
  await assert.rejects(verifyStagingTls(`https://127.0.0.1:${server.address().port}`, { timeoutMs: 100 }), /timed out/);
});
