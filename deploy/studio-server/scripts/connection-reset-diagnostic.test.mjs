import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  changeDiagnosticService,
  diagnosticLabel,
  diagnosticPodReady,
  waitForDiagnosticSilence,
} from './lib/connection-reset-diagnostic.mjs';
import { connectionResetResources, diagnosticNodeImage } from './lib/connection-reset-resources.mjs';
import { diagnosticBackend } from './fixtures/connection-reset-runtime.mjs';
import { collectContinuityResponse } from './lib/continuity-http-transport.mjs';
import { cleanupConnectionResetLocal } from './lib/connection-reset-local-cleanup.mjs';

const namespace = 'rivet-reset-123456abcdef';

test('silent hold rechecks its monotonic deadline after an early timer wake-up', async () => {
  let now = 0;
  const waits = [];
  const elapsed = await waitForDiagnosticSilence({
    startedAt: 0,
    durationMs: 295000,
    signal: new AbortController().signal,
    clock: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += waits.length === 1 ? ms - 1375 : ms;
      },
    },
  });
  assert.deepEqual(waits, [295000, 1375]);
  assert.equal(elapsed, 295000);
});

test('silent hold counts observed time and ignores wall-clock jumps', async (t) => {
  let now = 40;
  t.mock.method(Date, 'now', () => 3_600_000);
  const waits = [];
  assert.equal(
    await waitForDiagnosticSilence({
      startedAt: 0,
      durationMs: 100,
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        wait: async (ms) => {
          waits.push(ms);
          now += ms;
          t.mock.method(Date, 'now', () => -3_600_000);
        },
      },
    }),
    100,
  );
  assert.deepEqual(waits, [60]);
});

test('a failure during a silent hold rejects before authorizing response release', async () => {
  const controller = new AbortController();
  const failure = Error('transport failed');
  await assert.rejects(
    waitForDiagnosticSilence({
      startedAt: 0,
      durationMs: 100,
      signal: controller.signal,
      clock: {
        now: () => 0,
        wait: async () => controller.abort(failure),
      },
    }),
    (error) => error === failure,
  );
});

function cleanupFixture({ collectError, foreignOwner, removeError, tlsError } = {}) {
  const calls = [],
    ids = { first: 'a'.repeat(64), second: 'b'.repeat(64), network: 'c'.repeat(64) };
  return {
    calls,
    ids,
    options: {
      namespace,
      names: ['first', 'second'],
      docker: async (args) => {
        calls.push(args);
        if (args[0] === 'container' || args[1] === 'ls') return { stdout: 'present' };
        if (args[0] === 'inspect')
          return {
            stdout: JSON.stringify([
              {
                Id: ids[args[1]],
                Config: {
                  Labels: {
                    'rivet.connection-diagnostic': foreignOwner && args[1] === 'first' ? 'foreign' : namespace,
                  },
                },
              },
            ]),
          };
        if (args[0] === 'logs') {
          if (collectError === 'read') throw collectError;
          return { stdout: 'log', stderr: '' };
        }
        if (args[0] === 'rm' && removeError && args[2] === ids.first) throw removeError;
        if (args[0] === 'network' && args[1] === 'inspect')
          return {
            stdout: JSON.stringify([
              {
                Id: ids.network,
                Labels: { 'rivet.connection-diagnostic': namespace },
              },
            ]),
          };
        return { stdout: '' };
      },
      writeLog: async () => {
        if (collectError === 'write') throw collectError;
      },
      removeTls: async () => {
        calls.push(['tls']);
        if (tlsError) throw tlsError;
      },
    },
  };
}

for (const collectError of ['read', 'write'])
  test(`local cleanup removes owned resources despite log ${collectError} failure`, async () => {
    const f = cleanupFixture({ collectError });
    const result = await cleanupConnectionResetLocal(f.options);
    assert.equal(result.cleanupVerified, true);
    assert.ok(result.errors.includes(collectError));
    assert.deepEqual(
      f.calls.filter((args) => args[0] === 'rm').map((args) => args[2]),
      [f.ids.second, f.ids.first],
    );
    assert.ok(f.calls.some((args) => args[0] === 'network' && args[1] === 'rm' && args[2] === f.ids.network));
    assert.ok(f.calls.some((args) => args[0] === 'tls'));
  });

test('local cleanup never removes a foreign container and still visits the other resources', async () => {
  const f = cleanupFixture({ foreignOwner: true });
  const result = await cleanupConnectionResetLocal(f.options);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(
    f.calls.filter((args) => args[0] === 'rm').map((args) => args[2]),
    [f.ids.second],
  );
  assert.ok(f.calls.some((args) => args[0] === 'tls'));
});

for (const cause of ['removeError', 'tlsError'])
  test(`local cleanup preserves ${cause} and reports unconfirmed cleanup`, async () => {
    const error = Error(cause),
      f = cleanupFixture({ [cause]: error });
    const result = await cleanupConnectionResetLocal(f.options);
    assert.equal(result.cleanupVerified, false);
    assert.ok(result.errors.includes(error));
    assert.ok(f.calls.some((args) => args[0] === 'network' && args[1] === 'rm'));
    assert.ok(f.calls.some((args) => args[0] === 'tls'));
  });

test('CLI enters through projected paths while imports remain inert', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rivet-reset-entry-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('./', import.meta.url));
  const projected = path.join(directory, 'projected');
  await symlink(source, projected, process.platform === 'win32' ? 'junction' : 'dir');
  const entry = path.join(projected, 'fixtures', 'connection-reset-runtime.mjs');
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    // The invalid mode fails only if the CLI body runs; the old guard silently
    // exited 0. No ports or cloud credentials are needed for this regression.
    const result = spawnSync(process.execPath, [...flags, entry, 'invalid-probe-mode'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERR_ASSERTION/);
    assert.match(result.stderr, /client-local/);
  }
  const importer = path.join(directory, 'importer.mjs');
  await writeFile(
    importer,
    `await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write('import-ok');`,
  );
  const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(imported.error, undefined);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, 'import-ok');
});

test('backend readiness stops immediately on terminal or deleting Pods', () => {
  assert.equal(diagnosticPodReady(null), false);
  assert.equal(diagnosticPodReady({ status: { phase: 'Pending' } }), false);
  const pod = {
    metadata: { name: 'a' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
  assert.equal(diagnosticPodReady(pod), true);
  for (const phase of ['Succeeded', 'Failed']) {
    assert.throws(() => diagnosticPodReady({ ...pod, status: { ...pod.status, phase } }), /exited before readiness/);
  }
  assert.throws(
    () =>
      diagnosticPodReady({
        ...pod,
        status: { ...pod.status, containerStatuses: [{ name: 'diagnostic', state: { terminated: { exitCode: 0 } } }] },
      }),
    /exited before readiness/,
  );
  assert.throws(
    () => diagnosticPodReady({ ...pod, metadata: { ...pod.metadata, deletionTimestamp: 'now' } }),
    /being deleted/,
  );
});

function serviceFixture({ lostAck = false, commit = true, extraSpecAfter = {} } = {}) {
  let service = {
    metadata: {
      name: 'execution',
      namespace,
      uid: 'service-uid',
      resourceVersion: '1',
      labels: { [diagnosticLabel]: namespace },
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: '10.0.0.4',
      clusterIPs: ['10.0.0.4'],
      ports: [{ port: 8080 }],
      selector: { [diagnosticLabel]: namespace, pool: 'a' },
      sessionAffinity: 'None',
      internalTrafficPolicy: 'Cluster',
    },
  };
  const calls = [];
  const api = async (method, path, patch) => {
    assert.equal(path, `/api/v1/namespaces/${namespace}/services/execution`);
    calls.push({ method, patch });
    if (method === 'GET') return structuredClone(service);
    assert.equal(method, 'PATCH');
    assert.deepEqual(patch.slice(0, 3), [
      { op: 'test', path: '/metadata/uid', value: service.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: '1' },
      { op: 'test', path: '/spec/selector', value: service.spec.selector },
    ]);
    if (commit) service.spec.selector = patch[3].value;
    Object.assign(service.spec, extraSpecAfter);
    if (lostAck) throw Error('Uncertain acknowledgement');
    return structuredClone(service);
  };
  return { api, calls, service };
}

for (const lostAck of [false, true])
  test(`selector changes once with guarded identity; lost acknowledgement=${lostAck}`, async () => {
    const f = serviceFixture({ lostAck });
    const result = await changeDiagnosticService(f.api, namespace);
    assert.equal(result.acknowledged, !lostAck);
    assert.equal(result.serviceUid, 'service-uid');
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
    assert.equal(f.calls.at(-1).method, 'GET');
  });

test('an uncommitted uncertain write is not retried', async () => {
  const f = serviceFixture({ lostAck: true, commit: false });
  await assert.rejects(changeDiagnosticService(f.api, namespace), /Uncertain acknowledgement/);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1);
});

for (const extraSpecAfter of [{ sessionAffinity: 'ClientIP' }, { internalTrafficPolicy: 'Local' }])
  test(`selector confirmation rejects concurrent routing drift: ${Object.keys(extraSpecAfter)[0]}`, async () => {
    const f = serviceFixture({ extraSpecAfter });
    await assert.rejects(changeDiagnosticService(f.api, namespace), /change was not confirmed/);
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 1, 'Never replay the selector write');
  });

for (const mutation of ['namespace', 'owner', 'selector'])
  test(`foreign ${mutation} stops before mutation`, async () => {
    const f = serviceFixture();
    if (mutation === 'namespace') f.service.metadata.namespace = 'rivet';
    if (mutation === 'owner') f.service.metadata.labels[diagnosticLabel] = 'different';
    if (mutation === 'selector') f.service.spec.selector.pool = 'b';
    await assert.rejects(changeDiagnosticService(f.api, namespace));
    assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  });

test('ordinary application namespaces cannot be addressed', async () => {
  await assert.rejects(changeDiagnosticService(() => assert.fail('Must not access Kubernetes'), 'rivet'));
});

test('a denied Kubernetes read preserves its status and never attempts the patch', async () => {
  let calls = 0;
  const denied = Object.assign(Error('Denied'), { code: 'DIAGNOSTIC_KUBERNETES_HTTP', status: 403 });
  await assert.rejects(
    changeDiagnosticService(async (method) => {
      assert.equal(method, 'GET');
      calls++;
      throw denied;
    }, namespace),
    (error) => error === denied && error.status === 403,
  );
  assert.equal(calls, 1);
});

test('cross-node wire Pods meet Autopilot minimums without resizing the client', () => {
  const bundle = connectionResetResources({
    namespace,
    sources: { 'diagnostic.mjs': 'a', 'runtime.mjs': 'b', 'transport.mjs': 'c' },
    tls: { cert: 'disposable cert', key: 'disposable key' },
  });
  const wirePods = bundle.items.filter((item) => item.kind === 'Pod');
  assert.deepEqual(wirePods.map((pod) => pod.metadata.name).sort(), ['a', 'b', 'proxy']);
  for (const pod of wirePods) {
    assert.ok(pod.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length);
    assert.deepEqual(pod.spec.containers[0].resources, {
      requests: { cpu: '500m', memory: '512Mi' },
      limits: { memory: '512Mi' },
    });
  }
  const client = bundle.items.find((item) => item.kind === 'Job').spec.template.spec;
  assert.equal(client.affinity, undefined);
  assert.deepEqual(client.containers[0].resources, {
    requests: { cpu: '50m', memory: '128Mi' },
    limits: { memory: '128Mi' },
  });
});

test('offline Kubernetes bundle isolates access and disables automatic Job retries', () => {
  const bundle = connectionResetResources({
    namespace,
    sources: { 'diagnostic.mjs': 'a', 'runtime.mjs': 'b', 'transport.mjs': 'c' },
    tls: { cert: 'disposable cert', key: 'disposable key' },
  });
  assert.ok(bundle.items.every((r) => r.metadata.labels[diagnosticLabel] === namespace));
  assert.ok(bundle.items.filter((r) => r.kind !== 'Namespace').every((r) => r.metadata.namespace === namespace));
  const role = bundle.items.find((r) => r.kind === 'Role');
  assert.deepEqual(role.rules, [
    { apiGroups: [''], resources: ['services'], resourceNames: ['execution'], verbs: ['get', 'patch'] },
  ]);
  assert.ok(
    !bundle.items.some((r) =>
      ['ClusterRole', 'ClusterRoleBinding', 'Deployment', 'PersistentVolumeClaim'].includes(r.kind),
    ),
  );
  const job = bundle.items.find((r) => r.kind === 'Job');
  assert.equal(job.spec.backoffLimit, 0);
  assert.ok(job.spec.activeDeadlineSeconds >= 300 + 90, 'The job must cover the silent request and observation');
  assert.equal(job.spec.template.spec.restartPolicy, 'Never');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, true);
  assert.ok(bundle.items.filter((r) => r.kind === 'Pod').every((r) => r.spec.automountServiceAccountToken === false));
  for (const spec of [...bundle.items.filter((r) => r.kind === 'Pod').map((r) => r.spec), job.spec.template.spec]) {
    assert.equal(spec.activeDeadlineSeconds, 900, 'Disposable Pods must cover setup plus the silent hold, then stop');
    assert.equal(
      spec.securityContext.fsGroup,
      10001,
      'Non-root processes must be able to write their temporary volume',
    );
    assert.equal(spec.containers[0].securityContext.runAsGroup, 10001);
    assert.ok(spec.containers[0].securityContext.runAsUser > 0);
  }
  assert.ok(bundle.items.filter((r) => r.kind === 'Service').every((r) => r.spec.type === 'ClusterIP'));
  const wirePods = bundle.items.filter((r) => r.kind === 'Pod');
  assert.equal(wirePods.length, 3);
  for (const pod of wirePods) {
    const [rule] = pod.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    assert.equal(rule.topologyKey, 'kubernetes.io/hostname');
    assert.ok(
      wirePods.every((peer) =>
        Object.entries(rule.labelSelector.matchLabels).every(([key, value]) => peer.metadata.labels[key] === value),
      ),
    );
  }
  assert.ok(!bundle.items.find((r) => r.kind === 'ConfigMap').data['nginx.conf'].includes('127.0.0.11'));
  assert.throws(() => connectionResetResources({ namespace: 'rivet' }));
  assert.throws(() => connectionResetResources({ namespace, nodeImage: 'node:latest' }));
  assert.ok(diagnosticNodeImage.includes('@sha256:'));
});

for (const fault of [false, true])
  test(`held response stays silent until release; truncate=${fault}`, async (t) => {
    const server = diagnosticBackend({ uid: 'owner-a', fault, holdMs: 100 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const requestId = randomUUID(),
      body = JSON.stringify({ requestId, hold: true, input: 'x'.repeat(16384) });
    let responses = 0;
    const start = (body, control) => {
      const completion = new Promise((resolve, reject) => {
        const req = http.request(
          base + '/workflows/fixture',
          {
            method: 'POST',
            headers: { 'x-diagnostic-control': control ? '1' : '0', connection: 'close' },
          },
          (res) => {
            responses++;
            collectContinuityResponse(res, res.statusCode, res.headers).then(resolve, reject);
          },
        );
        req.once('error', reject);
        req.end(body);
      });
      completion.catch(() => {});
      return completion;
    };
    const admitted = async (count) => {
      const deadline = Date.now() + 5000;
      let state;
      do {
        assert.ok(Date.now() < deadline, 'The requests must be admitted');
        state = await (await fetch(base + '/state')).json();
        if (state.requests.length < count) await new Promise(setImmediate);
      } while (state.requests.length < count);
      return state;
    };
    // Even when the unchanged-route control arrives first, it must never be
    // chosen for deliberate truncation.
    const controlId = randomUUID();
    const control = start(JSON.stringify({ requestId: controlId, hold: true, input: 'x'.repeat(16384) }), true);
    await admitted(1);
    const completion = start(body, false);
    const before = await admitted(2);
    assert.equal(responses, 0, 'No headers or prefix may keep the silent connections active');
    assert.ok(before.requests.every((r) => r.held && !r.finished && r.prefixBytes === 0));
    assert.ok(before.requests.every((r) => r.upstreamConnection === 'close'));
    assert.equal(before.requests.find((r) => r.requestId === controlId).control, true);
    const release = await fetch(base + '/release', {
      method: 'POST',
      body: JSON.stringify({ requestIds: [controlId, requestId] }),
    });
    assert.equal(release.status, 200);
    assert.equal((await control).bytes, 16568, 'The unchanged-route control remains healthy');
    if (fault)
      await assert.rejects(completion, (error) => {
        assert.equal(error.continuityResponse.status, 200);
        assert.equal(error.continuityResponse.bodyBytes, 11959);
        return true;
      });
    else {
      const result = await completion;
      assert.equal(result.bytes, 16568);
      assert.equal(JSON.parse(result.body).output.value, body);
    }
    const duplicate = await fetch(base + '/workflows/fixture', { method: 'POST', body });
    assert.equal(duplicate.status, 400, 'A duplicate execution is never accepted');
  });
