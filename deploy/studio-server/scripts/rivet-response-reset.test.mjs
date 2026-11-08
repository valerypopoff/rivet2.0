import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runRivetResponseReset } from './lib/rivet-response-reset.mjs';
import {
  rivetResetResources,
  completeRivetResetResources,
  createRivetResetProxy,
  rivetResetPhases,
} from './lib/rivet-response-reset-resources.mjs';
import { diagnosticLabel } from './lib/connection-reset-diagnostic.mjs';

const namespace = 'rivet-reset-123456abcdef';
const apiImage = 'ghcr.io/valerypopoff/rivet2.0-studio-server/api@sha256:' + 'a'.repeat(64);
const sources = {
  'runtime.mjs': 'backend',
  'diagnostic.mjs': 'mutation',
  'transport.mjs': 'transport',
  'real-diagnostic.mjs': 'real-client',
  'error.mjs': 'safe-status-error',
};
const prepared = () =>
  rivetResetResources({ namespace, apiImage, sources, tls: { cert: 'test-certificate', key: 'test-key' } });

test('the repaired diagnostic retains both API backends on the exact HTTP port without exposing proxy/client', () => {
  const bundle = rivetResetResources({
    namespace,
    apiImage,
    sources,
    tls: { cert: 'test-certificate', key: 'test-key' },
    retainBackend: true,
  });
  const reference = bundle.items.find((r) => r.kind === 'Service' && r.metadata.name === 'execution-connections');
  const publicRoute = bundle.items.find((r) => r.kind === 'Service' && r.metadata.name === 'execution');
  assert.equal(reference.spec.type, 'ClusterIP');
  assert.equal(reference.spec.clusterIP, undefined);
  assert.equal(reference.spec.publishNotReadyAddresses, true);
  assert.deepEqual(reference.spec.ports, publicRoute.spec.ports);
  assert.equal(reference.spec.selector.pool, undefined);
  const selected = bundle.items.filter(
    (r) =>
      r.kind === 'Pod' &&
      Object.entries(reference.spec.selector).every(([key, value]) => r.metadata.labels[key] === value),
  );
  assert.deepEqual(
    selected.map((r) => r.metadata.name),
    ['a', 'b'],
  );
  assert.ok(rivetResetPhases(bundle).infrastructure.includes(reference));
});
const inventory = () => ({
  items: ['a', 'b'].map((name, index) => ({
    kind: 'Pod',
    metadata: { name, namespace, uid: `uid-${name}`, labels: { [diagnosticLabel]: namespace } },
    spec: { nodeName: `node-${name}` },
    status: { phase: 'Running', podIP: `10.42.0.${index + 1}`, conditions: [{ type: 'Ready', status: 'True' }] },
  })),
});

test('real-Rivet diagnostic removes backend Services and keeps mutations confined to its execution selector', () => {
  const bundle = prepared();
  assert.deepEqual(
    bundle.items
      .filter((r) => r.kind === 'Service')
      .map((r) => r.metadata.name)
      .sort(),
    ['execution', 'proxy'],
  );
  const role = bundle.items.find((r) => r.kind === 'Role');
  assert.deepEqual(role.rules, [
    { apiGroups: [''], resources: ['services'], resourceNames: ['execution'], verbs: ['get', 'patch'] },
  ]);
  for (const name of ['a', 'b']) {
    const pod = bundle.items.find((r) => r.kind === 'Pod' && r.metadata.name === name);
    assert.equal(pod.spec.containers[0].image, apiImage);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.deepEqual(pod.spec.containers[0].resources, {
      requests: { cpu: '500m', memory: '512Mi' },
      limits: { memory: '512Mi' },
    });
    assert.deepEqual(pod.spec.containers[0].command, [
      'node',
      '/diagnostic/fixtures/rivet-response-reset-runtime.mjs',
      'backend',
    ]);
    const files = pod.spec.volumes.find((v) => v.name === 'source').configMap.items;
    assert.ok(files.some((f) => f.path === 'lib/rivet-response-reset.mjs'));
    assert.equal(
      new Set(files.map((f) => f.path)).size,
      files.length,
      'Projections must not share accumulated entries',
    );
    assert.equal(files.length, 5);
  }
  const job = bundle.items.find((r) => r.kind === 'Job');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 420);
  assert.equal(job.spec.template.spec.containers[0].command.at(-1), 'client-kubernetes');
});

test('offline completion binds the unchanged route and state probes directly to observed Pod IPs', () => {
  const frozen = prepared();
  const source = frozen.items.find((r) => r.kind === 'ConfigMap' && r.metadata.name === 'diagnostic');
  const originalSource = structuredClone(source);
  frozen.items.find((r) => r.kind === 'ConfigMap' && r.metadata.name === 'proxy-config').data['nginx.conf'] +=
    '\n# frozen proxy configuration\n';
  const { bundle, owners } = completeRivetResetResources(frozen, inventory());
  assert.deepEqual(owners, [
    { name: 'a', uid: 'uid-a', ip: '10.42.0.1' },
    { name: 'b', uid: 'uid-b', ip: '10.42.0.2' },
  ]);
  const nginx = bundle.items.find((r) => r.kind === 'ConfigMap' && r.metadata.name === 'proxy-config').data[
    'nginx.conf'
  ];
  assert.match(nginx, /upstream rivet_control[^\n]+server 10\.42\.0\.1:8080/);
  assert.match(nginx, /upstream rivet_execution[^\n]+server execution:8080;/);
  assert.match(nginx, /proxy_set_header Connection close/);
  assert.match(nginx, /proxy_buffering on/);
  assert.doesNotMatch(nginx, /server a:|127\.0\.0\.11| resolve;/);
  assert.match(nginx, /# frozen proxy configuration/);
  assert.deepEqual(source, originalSource, 'Completion must not update the shared source ConfigMap');
  const env = bundle.items.find((r) => r.kind === 'Job').spec.template.spec.containers[0].env;
  assert.ok(env.some((v) => v.name === 'BACKEND_A' && v.value === 'http://10.42.0.1:8080'));
  assert.ok(env.some((v) => v.name === 'BACKEND_B' && v.value === 'http://10.42.0.2:8080'));
});

test('proxy phase creates its final immutable configuration before Service and Pod', async () => {
  const frozen = prepared(),
    phases = rivetResetPhases(frozen),
    creates = [];
  assert.ok(phases.infrastructure.every((r) => r.metadata.name !== 'proxy-config' && r.metadata.name !== 'proxy'));
  const completed = await createRivetResetProxy({
    bundle: frozen,
    inventory: inventory(),
    create: async (r) => {
      creates.push({ kind: r.kind, name: r.metadata.name });
      if (r.kind === 'ConfigMap') {
        assert.equal(r.immutable, true);
        assert.deepEqual(Object.keys(r.data), ['nginx.conf']);
        assert.match(r.data['nginx.conf'], /server 10\.42\.0\.1:8080;/);
        assert.doesNotMatch(r.data['nginx.conf'], /server a:8080/);
      }
      if (r.kind === 'Pod')
        assert.deepEqual(r.spec.volumes.find((v) => v.name === 'source').configMap, {
          name: 'proxy-config',
          items: [{ key: 'nginx.conf', path: 'nginx.conf' }],
        });
    },
  });
  assert.deepEqual(creates, [
    { kind: 'ConfigMap', name: 'proxy-config' },
    { kind: 'Service', name: 'proxy' },
    { kind: 'Pod', name: 'proxy' },
  ]);
  assert.equal(rivetResetPhases(completed.bundle).client.kind, 'Job');
  const projections = completed.bundle.items
    .filter((r) => r.kind === 'Pod')
    .map((p) => p.spec.volumes.find((v) => v.name === 'source').configMap.name);
  assert.deepEqual(projections, ['diagnostic', 'diagnostic', 'proxy-config']);
});

test('a failed proxy configuration create preserves its original error and is never replayed', async () => {
  const failure = Object.assign(Error('Kubernetes POST failed (422; Invalid)'), {
    status: 422,
    kubernetesStatus: { reason: 'Invalid' },
  });
  const creates = [];
  await assert.rejects(
    createRivetResetProxy({
      bundle: prepared(),
      inventory: inventory(),
      create: async (resource) => {
        creates.push(resource.metadata.name);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(creates, ['proxy-config']);
});

test('offline CLI completion emits only create-only proxy resources and leaves frozen input unchanged', async (t) => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)),
    artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'rivet-reset-complete-test-'));
  t.after(async () => {
    assert.ok(directory.startsWith(artifacts + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const bundle = prepared(),
    raw = JSON.stringify(bundle);
  await fs.writeFile(path.join(directory, 'pending.private.json'), raw);
  await fs.writeFile(
    path.join(directory, 'identity.private.json'),
    JSON.stringify({ namespace, pendingSha256: createHash('sha256').update(raw).digest('hex') }),
  );
  const podList = path.join(directory, 'pods.private.json');
  await fs.writeFile(podList, JSON.stringify(inventory()));
  const output = execFileSync(
    process.execPath,
    [
      path.join(root, 'deploy/studio-server/scripts/rivet-response-reset.mjs'),
      'complete',
      '--output',
      directory,
      '--pod-inventory',
      podList,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  assert.match(output, /No Kubernetes command ran/);
  const proxy = JSON.parse(await fs.readFile(path.join(directory, 'proxy.private.json')));
  assert.deepEqual(
    proxy.items.map((r) => [r.kind, r.metadata.name]),
    [
      ['ConfigMap', 'proxy-config'],
      ['Service', 'proxy'],
      ['Pod', 'proxy'],
    ],
  );
  assert.equal(proxy.items[0].immutable, true);
  assert.match(proxy.items[0].data['nginx.conf'], /server 10\.42\.0\.1:8080;/);
  assert.equal(await fs.readFile(path.join(directory, 'pending.private.json'), 'utf8'), raw);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'client.private.json'))).kind, 'Job');
});

for (const [name, change] of [
  [
    'foreign namespace',
    (p) => {
      p.metadata.namespace = 'rivet';
    },
  ],
  [
    'foreign ownership',
    (p) => {
      p.metadata.labels[diagnosticLabel] = 'other';
    },
  ],
  [
    'invalid IP',
    (p) => {
      p.status.podIP = 'a;server attacker';
    },
  ],
  [
    'terminal process',
    (p) => {
      p.status.containerStatuses = [{ name: 'diagnostic', state: { terminated: { exitCode: 0 } } }];
    },
  ],
  [
    'deleted Pod',
    (p) => {
      p.metadata.deletionTimestamp = '2026-11-08T00:00:00Z';
    },
  ],
  [
    'same node',
    (p) => {
      p.spec.nodeName = 'node-b';
    },
  ],
]) {
  test(`offline completion rejects ${name}`, () => {
    const pods = inventory();
    change(pods.items[0]);
    assert.throws(() => completeRivetResetResources(prepared(), pods));
  });
}

test('real-Rivet diagnostic requires an immutable API image', () => {
  assert.throws(() => rivetResetResources({ namespace, apiImage: 'api:latest', sources, tls: {} }));
});

for (const beforeAdmission of [false, true])
  test(
    `first response failure stops new POSTs and drains accepted work; beforeAdmission=${beforeAdmission}`,
    { timeout: 5000 },
    async (t) => {
      // Exercise the real observer/stream collector over loopback without a test CA.
      t.mock.method(https, 'request', (...args) => http.request(...args));
      const owners = { a: { uid: 'a', incarnation: 'a-1' }, b: { uid: 'b', incarnation: 'b-1' } };
      const requests = [];
      let activeRuns = 0,
        failureObserved;
      const failed = new Promise((resolve) => {
        failureObserved = resolve;
      });
      const server = http.createServer(async (req, res) => {
        if (req.method === 'GET') {
          const owner = req.url.startsWith('/b/') ? owners.b : owners.a;
          res.end(
            JSON.stringify({
              owner,
              activeRuns: owner.uid === 'a' ? activeRuns : 0,
              requests: owner.uid === 'a' ? requests : [],
            }),
          );
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString(),
          input = JSON.parse(body);
        if (beforeAdmission && input.delayMs && !req.url.startsWith('/control/')) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          res.destroy();
          return;
        }
        const receipt = {
          requestId: input.requestId,
          accepted: true,
          finished: false,
          closed: false,
          upstreamConnection: 'close',
        };
        requests.push(receipt);
        activeRuns++;
        res.once('finish', () => {
          receipt.finished = true;
        });
        res.once('close', () => {
          receipt.closed = true;
          activeRuns--;
        });
        const response = Buffer.from(JSON.stringify({ output: { type: 'string', value: body } }));
        res.setHeader('content-length', response.length);
        res.setHeader('x-diagnostic-owner', 'a');
        if (input.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, req.url.startsWith('/control/') ? input.delayMs : 100));
          if (!req.url.startsWith('/control/')) {
            res.write(response.subarray(0, 11959), () => res.destroy());
            return;
          }
        }
        res.end(response);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const report = await runRivetResponseReset({
        baseUrl,
        backendA: baseUrl + '/a',
        backendB: baseUrl + '/b',
        durationMs: 1000,
        evidence: (event) => {
          if (event.event === 'first-failure') failureObserved();
        },
        change: async () => {
          await failed;
          return { changed: true };
        },
      });
      assert.equal(report.outcome, 'failed');
      assert.equal(report.requests.length, 4, 'No post-change workflow is sent after failure');
      assert.equal(requests.length, beforeAdmission ? 3 : 4, 'None of the POSTs is replayed');
      assert.equal(report.requests.filter((r) => r.outcome === 'failed').length, 1);
      assert.equal(report.requests.find((r) => r.hold && r.route === 'unchanged').outcome, 'passed');
      assert.equal(report.acceptedWorkSettled, true);
      assert.equal(activeRuns, 0);
      assert.equal(report.unobservedRequests.length, beforeAdmission ? 1 : 0);
    },
  );
