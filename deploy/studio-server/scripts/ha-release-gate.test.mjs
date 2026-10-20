import test from 'node:test';
import assert from 'node:assert/strict';
import { HaReleaseGate, runHaReleaseRollout, validateHaCertificationManifest, withHaProofGeneration } from './kubernetes-ha-release-gate.mjs';
import { HaReleaseProbes, haProofTimeoutMs } from './lib/ha-release-probes.mjs';
import { ProviderHaReleaseGate, withProviderReadRetry } from './kubernetes-ha-provider-gate.mjs';
import { createHaRecoveryFaultTransport, verifyHaReleaseRecovery } from './lib/ha-release-recovery-probes.mjs';
import { startHaWorkflowTraffic } from './lib/ha-workflow-traffic.mjs';
import { parseAllDocuments } from 'yaml';
import { publishHaBrowserBaseline, waitForHaFrontendReplacement, hasHaBrowserReadyTransport } from './lib/ha-browser-probe.mjs';
import { ManagedReleaseGate } from './kubernetes-managed-release-gate.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  readManagedWorkflowSchemaReleaseContract,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));

function recoveryCasFixture() {
  let version = 7;
  const record = { token: 'operation', runner: 'controller', owner: { name: 'owner-0', uid: 'original', beginIssued: true } };
  let current = { metadata: { name: 'journal', resourceVersion: String(version) }, data: { record: JSON.stringify(record) } };
  const calls = [];
  const kube = async (args, extra) => {
    calls.push(args[0]);
    if (args[0] === 'exec') return { stdout: 'accepted' };
    const next = JSON.parse(extra.input);
    if (next.metadata.resourceVersion !== current.metadata.resourceVersion)
      throw Error('Error from server (Conflict): configmap has been modified');
    current = { ...next, metadata: { ...next.metadata, resourceVersion: String(++version) } };
    return { stdout: JSON.stringify(current) };
  };
  return { kube, calls, journal: async () => structuredClone(current), heartbeat: () => {
    current.metadata.resourceVersion = String(++version);
  } };
}

test('lease-loss injection fences the serialized runner write, not a heartbeat racing the injector', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport('leaseLoss', f.kube, f.journal, 'journal');
  await fault.send(['exec', 'owner-0', '--begin-only']);
  assert.deepEqual(f.calls, ['exec'], 'begin acceptance must not race another controller heartbeat with an injector write');
  assert.equal(fault.state.injected, false);
  f.heartbeat(); // A real heartbeat may advance the API version before the next serialized write.
  const next = await f.journal();
  await assert.rejects(fault.send(['replace', '-f', '-'], { input: JSON.stringify(next) }), /Error from server \(Conflict\)/);
  assert.deepEqual(f.calls, ['exec', 'replace', 'replace']);
  assert.equal(fault.state.injected, true);
  assert.equal(fault.state.conflictObserved, true);
  assert.equal(fault.state.begins, 1);
  assert.notEqual(JSON.parse((await f.journal()).data.record).runner, 'controller');
  assert.ok(JSON.parse((await f.journal()).data.record).leaseExpiresAt < Date.now());
  const recovered = await f.journal();
  await fault.send(['replace', '-f', '-'], { input: JSON.stringify(recovered) });
  assert.equal(f.calls.filter(value => value === 'exec').length, 1, 'recovery does not replay begin or reinject');
});

test('lease fault neither mutates a foreign journal nor treats unrelated failures as a confirmed API conflict', async () => {
  for (const mode of ['foreign', 'unavailable', 'injector-unknown']) {
    const f = recoveryCasFixture();
    let replacements = 0;
    const kube = async (args, extra) => {
      if (args[0] === 'replace') {
        replacements++;
        if (mode === 'injector-unknown' || (mode === 'unavailable' && replacements === 2))
          throw Error('connection lost; outcome unknown');
      }
      return f.kube(args, extra);
    };
    const fault = createHaRecoveryFaultTransport('leaseLoss', kube, f.journal, 'journal');
    await fault.send(['exec', 'owner-0', '--begin-only']);
    const next = await f.journal();
    if (mode === 'foreign') next.data.record = JSON.stringify({ ...JSON.parse(next.data.record), token: 'another operation' });
    await assert.rejects(fault.send(['replace', '-f', '-'], { input: JSON.stringify(next) }));
    assert.equal(fault.state.conflictObserved, false);
    assert.equal(fault.state.injected, mode === 'unavailable');
    assert.equal(replacements, mode === 'foreign' ? 0 : mode === 'unavailable' ? 2 : 1,
      'unknown writes and foreign journal state are never retried');
  }
});

test('lost-acknowledgement probe sends the accepted begin once and does not modify its journal', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport('lostAcknowledgement', f.kube, f.journal, 'journal');
  await assert.rejects(fault.send(['exec', 'owner-0', '--begin-only']), /Injected lost begin acknowledgement/);
  assert.equal(fault.state.injected, true);
  assert.equal(fault.state.begins, 1);
  assert.deepEqual(f.calls, ['exec']);
});

test('an unacknowledged begin cannot arm the lease-loss fault during runner cleanup', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport('leaseLoss', async (args, extra) => {
    if (args[0] === 'exec') throw Error('begin outcome unknown');
    return f.kube(args, extra);
  }, f.journal, 'journal');
  await assert.rejects(fault.send(['exec', 'owner-0', '--begin-only']), /begin outcome unknown/);
  await fault.send(['replace', '-f', '-'], { input: JSON.stringify(await f.journal()) });
  assert.equal(fault.state.beginAccepted, false);
  assert.equal(fault.state.injected, false);
  assert.deepEqual(f.calls, ['replace'], 'cleanup records its original outcome without injecting another fault');
});

test('retained browser waits for all old sockets to close and all replacement sessions to finish replay', () => {
  const first = { closed: false, ready: true, resumed: false };
  const second = { closed: false, ready: true, resumed: false };
  const originals = [first, second];
  const replacement = { closed: false, ready: false, resumed: false };
  const sockets = new Set([first, second]);
  assert.equal(hasHaBrowserReadyTransport(sockets.values(), originals), false, 'removed pods can still leave half-open browser sockets');
  first.closed = true; sockets.delete(first); sockets.add(replacement);
  replacement.ready = true; replacement.resumed = true;
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), false, 'another browser socket has not noticed the lost proxy');
  second.closed = true; sockets.delete(second);
  const replaying = { closed: false, ready: false, resumed: true };
  sockets.add(replaying);
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), false, 'TCP open is not ordered session readiness');
  replaying.ready = true;
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), true);
  replaying.resumed = false;
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), false, 'a new unrelated session cannot replace an accepted run');
  assert.equal(hasHaBrowserReadyTransport([], originals), false);
});

test('external gateway with only web replacement can retain a healthy unchanged API socket', () => {
  const socket = { closed: false, ready: true, resumed: false };
  assert.equal(hasHaBrowserReadyTransport([socket]), true);
  socket.ready = false;
  assert.equal(hasHaBrowserReadyTransport([socket]), false);
  socket.ready = true; socket.closed = true;
  assert.equal(hasHaBrowserReadyTransport([socket]), false);
  assert.equal(hasHaBrowserReadyTransport([]), false);
});

test('local test edge bounds stale WebSockets without changing the long HTTP observation timeout', async t => {
  let resources;
  t.mock.method(ManagedReleaseGate.prototype, 'openProxy', async function (target) {
    assert.equal(target, 'service/proof-ha-edge-v2');
    return 'http://test-edge';
  });
  const gate = new HaReleaseGate({ release: 'proof', namespace: 'fixture', images: {
    proxy: { repository: 'fixture/proxy', digest: `sha256:${'a'.repeat(64)}` },
  } }, 'unused', 'unused');
  gate.kubectl = async (args, options) => {
    if (args.includes('apply')) resources = JSON.parse(options.input).items;
    return { stdout: '' };
  };
  assert.equal(await gate.openProxy(), 'http://test-edge');
  const config = resources.find(resource => resource.kind === 'ConfigMap').data['nginx.conf'];
  assert.equal(resources.find(resource => resource.kind === 'Pod').metadata.name, 'proof-ha-edge-v2');
  assert.match(config, /location \/ws\/ \{[^}]*proxy_read_timeout 45s;/);
  assert.match(config, /location \/ \{[^}]*proxy_read_timeout 600s;/);
  assert.equal(resources.find(resource => resource.kind === 'Pod').metadata.labels['app.kubernetes.io/instance'], undefined);
});

test('HA traffic stop includes a late in-flight failure without retrying or retaining secrets', async () => {
  let rejectRequest, calls = 0, phase = 'leaseLoss:injecting';
  const gate = { requestWorkflow: (url, route, options) => {
    calls++;
    assert.equal(url, 'https://staging.example.test');
    assert.equal(route, '/workflows/managed-release-workflow');
    assert.equal(options.timeoutMs, 15_000);
    assert.match(options.headers['x-rivet-ha-probe-id'], /^[a-f0-9-]{36}$/);
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  } };
  const traffic = startHaWorkflowTraffic(gate, 'https://staging.example.test', () => phase);
  let settled = false;
  const stop = traffic.stop().then(report => { settled = true; return report; });
  await Promise.resolve();
  assert.equal(settled, false, 'shutdown waits for the actual request');
  phase = 'leaseLoss:settling';
  rejectRequest(Object.assign(Error('secret response body'), {
    name: 'TimeoutError', cause: { code: 'UND_ERR_SOCKET', token: 'secret-key' }, status: 504,
  }));
  const report = await stop;
  assert.equal(calls, 1, 'failed POST is never replayed');
  assert.equal(report.samples, 0);
  assert.equal(report.failures.length, 1);
  const failure = report.failedRequests[0];
  assert.equal(failure.phase, 'leaseLoss:injecting', 'capture phase at dispatch, not settlement');
  assert.deepEqual(failure.error, { name: 'TimeoutError', code: 'UND_ERR_SOCKET', status: 504 });
  assert.ok(Number.isFinite(Date.parse(failure.startedAt)));
  assert.ok(Number.isFinite(Date.parse(failure.finishedAt)));
  assert.ok(failure.elapsedMs >= 0);
  assert.equal(report.slowestRequest, failure);
  assert.doesNotMatch(JSON.stringify(report), /secret|authorization|https:/i);
  assert.equal(await traffic.stop(), report, 'repeated stop is observational');
});

test('HA traffic counts successful terminal requests and rejects empty execution responses', async () => {
  for (const result of [{ outputs: {} }, null]) {
    let resolveRequest;
    const traffic = startHaWorkflowTraffic({ requestWorkflow: () => new Promise(resolve => { resolveRequest = resolve; }) },
      'https://staging.example.test');
    const stop = traffic.stop();
    resolveRequest(result);
    const report = await stop;
    assert.equal(report.samples, result ? 1 : 0);
    assert.equal(report.failures.length, result ? 0 : 1);
    assert.equal(report.slowestRequest.phase, 'rollout');
  }
});

test('each disposable HA proof changes both frontend templates even when images are unchanged', () => {
  const base = {
    images: { web: { repository: 'registry/web', digest: `sha256:${'a'.repeat(64)}` } },
    podAnnotations: { web: { 'operator/web': 'keep' }, proxy: { 'operator/proxy': 'keep' },
      backend: { 'operator/backend': 'keep' }, execution: { 'operator/execution': 'keep' },
      evaluation: { 'operator/evaluation': 'keep' } },
  };
  const snapshot = structuredClone(base);
  const first = withHaProofGeneration(base);
  const second = withHaProofGeneration(base);
  assert.deepEqual(base, snapshot);
  assert.deepEqual(first.images, base.images, 'do not fabricate a different workload image');
  for (const role of ['web', 'proxy', 'backend', 'execution']) {
    assert.equal(first.podAnnotations[role][`operator/${role}`], 'keep');
    assert.match(first.podAnnotations[role]['rivet.dev/ha-proof-generation'], /^[a-f0-9-]{36}$/);
    assert.notEqual(first.podAnnotations[role]['rivet.dev/ha-proof-generation'], second.podAnnotations[role]['rivet.dev/ha-proof-generation']);
  }
  assert.deepEqual(first.podAnnotations.evaluation, base.podAnnotations.evaluation);
});

test('rendered HA proof preserves endpoint withdrawal and the short shutdown challenge', async () => {
  const images = Object.fromEntries(['api', 'web', 'proxy', 'executor'].map(role =>
    [role, { repository: `registry/${role}`, digest: `sha256:${'a'.repeat(64)}` }]));
  const gate = new HaReleaseGate({ images, release: 'ha-fixture', imagePullPolicy: 'IfNotPresent',
    registry: { secretName: 'fixture-registry' }, managedWorkflowSchema: readManagedWorkflowSchemaReleaseContract(rootDir) }, 'unused', 'unused');
  const values = gate.values();
  assert.deepEqual(values.lifecycle, {
    preStopDelaySeconds: 5, terminationGracePeriodSeconds: 45,
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-render-'));
  try {
    const file = path.join(dir, 'values.json');
    await fs.writeFile(file, JSON.stringify(values));
    const rendered = execFileSync(resolveHelmBinOrThrow(rootDir), ['template', 'ha-fixture',
      path.join(rootDir, 'deploy/studio-server/helm'), '-n', 'ha-fixture', '-f',
      path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'), '-f', file], { encoding: 'utf8' });
    const workloads = parseAllDocuments(rendered).map(doc => {
      assert.equal(doc.errors.length, 0);
      return doc.toJSON();
    }).filter(value => ['Deployment', 'StatefulSet'].includes(value?.kind));
    const proxy = workloads.find(value => value.metadata.labels['app.kubernetes.io/component'] === 'proxy');
    assert.deepEqual(proxy.spec.template.spec.containers[0].lifecycle.preStop.exec.command, ['/bin/sh', '-c', 'sleep 5']);
    for (const workload of workloads) assert.equal(workload.spec.template.spec.terminationGracePeriodSeconds, 45);
    const backend = workloads.find(value => value.metadata.labels['app.kubernetes.io/component'] === 'backend');
    const env = backend.spec.template.spec.containers.find(value => value.name === 'backend').env;
    assert.equal(env.find(value => value.name === 'RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS').value, '15');
    assert.equal(env.find(value => value.name === 'RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS').value, '25000');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('mixed HA baseline installs the predecessor exact schema without changing the candidate contract', async () => {
  const images = Object.fromEntries(['api', 'web', 'proxy', 'executor'].map(role =>
    [role, { repository: `registry/${role}`, digest: `sha256:${'a'.repeat(64)}` }]));
  const candidateSchema = readManagedWorkflowSchemaReleaseContract(rootDir);
  const previousSchema = { version: candidateSchema.version - 1, minimumRollbackCompatibleVersion: candidateSchema.version - 1 };
  const previousImages = Object.fromEntries(Object.entries(images).map(([role, image]) =>
    [role, { ...image, digest: `sha256:${'b'.repeat(64)}` }]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-baseline-'));
  const config = { images, release: 'ha-fixture', namespace: 'ha-fixture', artifactsDir: dir,
    imagePullPolicy: 'IfNotPresent', registry: { secretName: 'fixture-registry' }, managedWorkflowSchema: candidateSchema };
  const gate = new HaReleaseGate(config, 'unused', 'unused');
  let baseline;
  gate.assertLocalContext = async () => {};
  gate.kubectl = async () => ({ stdout: '' });
  gate.createNamespace = async () => {};
  gate.createRegistrySecret = async () => {};
  gate.installDependencies = async () => {};
  gate.apply = async values => { baseline = values; };
  gate.openProxy = async () => 'http://fixture';
  gate.exercisePersistence = async () => ({});
  try {
    await gate.prepare(previousImages, previousSchema);
    assert.deepEqual(baseline.workflowSchema.compatibility, {
      minimumVersion: previousSchema.version, maximumVersion: previousSchema.version,
    });
    assert.equal(baseline.images.api.digest, previousImages.api.digest);
    const file = path.join(dir, 'baseline.json');
    await fs.writeFile(file, JSON.stringify(baseline));
    const rendered = execFileSync(resolveHelmBinOrThrow(rootDir), ['template', 'ha-fixture',
      path.join(rootDir, 'deploy/studio-server/helm'), '-n', 'ha-fixture', '-f',
      path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'), '-f', file], { encoding: 'utf8' });
    const resources = parseAllDocuments(rendered).map(doc => doc.toJS());
    const job = resources.find(value => value?.kind === 'Job' && value.metadata.name.endsWith('workflow-schema-migration'));
    assert.match(job.spec.template.spec.containers[0].args.join(' '),
      new RegExp(`RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION="${previousSchema.version}" RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION="${previousSchema.version}"`));
    assert.equal(job.spec.template.spec.containers[0].image, `${previousImages.api.repository}@${previousImages.api.digest}`);
    assert.deepEqual(gate.values().workflowSchema.compatibility, {
      minimumVersion: candidateSchema.version, maximumVersion: candidateSchema.version,
    });
    assert.deepEqual(config.managedWorkflowSchema, candidateSchema);
    assert.deepEqual(config.images, images);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('paused browser proof waits for actual old web and proxy UID removal, not readiness withdrawal', async () => {
  const pod = (uid, component, extra = {}) => ({ metadata: { uid, labels: { 'app.kubernetes.io/component': component }, ...extra } });
  const before = [pod('old-web', 'web'), pod('old-proxy', 'proxy'), pod('unchanged-owner', 'backend')];
  const snapshots = [before, [pod('old-proxy', 'proxy', { deletionTimestamp: '2026-10-17T12:00:00Z' })],
    [pod('new-web', 'web'), pod('new-proxy', 'proxy'), before[2]]];
  let reads = 0, waits = 0;
  const gate = {
    config: { namespace: 'rivet-staging-proof', release: 'rivet-staging-proof' },
    kubectl: async (args) => {
      assert.deepEqual(args.slice(0, 4), ['-n', 'rivet-staging-proof', 'get', 'pods']);
      return { stdout: JSON.stringify({ items: snapshots[reads++] }) };
    },
  };
  await waitForHaFrontendReplacement(gate, before, 30_000, async () => { waits++; });
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('frontend replacement observation times out without mutating or fabricating browser continuity', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const before = [{ metadata: { uid: 'old-web', labels: { 'app.kubernetes.io/component': 'web' } } }];
  let reads = 0;
  const gate = { config: { namespace: 'rivet-staging-proof', release: 'rivet-staging-proof' },
    kubectl: async () => { reads++; return { stdout: JSON.stringify({ items: before }) }; } };
  await assert.rejects(waitForHaFrontendReplacement(gate, before, 1000, async ms => { now += ms; }), /Original frontend pods remain/);
  assert.equal(reads, 2);
  await assert.rejects(waitForHaFrontendReplacement(gate, [], 1000));
  assert.equal(reads, 2);
});

test('provider transport retries only read-only TLS handshakes, never uncertain mutations', async () => {
  const timeout = Error('Unable to connect to the server: net/http: TLS handshake timeout');
  for (const args of [['get', 'pods'], ['-n', 'staging', '--request-timeout=30s', 'get', 'namespace'], ['config', 'view']]) {
    let calls = 0;
    const waits = [];
    assert.equal(await withProviderReadRetry(args, async () => {
      if (++calls < 3) throw timeout;
      return 'fresh observation';
    }, async ms => { waits.push(ms); }), 'fresh observation');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
  for (const args of [['exec', 'pod', '--', 'retire'], ['scale', 'statefulset/owner'], ['replace', '-f', '-'],
    ['delete', '--raw', '/pod'], ['create', '-f', '-'], ['apply', '-f', '-'], ['config', 'set-context', 'get'],
    ['--unknown-option', 'get', 'pods']]) {
    let calls = 0;
    await assert.rejects(withProviderReadRetry(args, async () => { calls++; throw timeout; }, async () => {
      throw Error('must not wait before replaying a mutation');
    }), error => error === timeout);
    assert.equal(calls, 1);
  }
  for (const error of [timeout, Error('Forbidden'), Error('namespace identity changed')]) {
    let calls = 0;
    await assert.rejects(withProviderReadRetry(['get', 'pods'], async () => { calls++; throw error; }, async () => {}),
      caught => caught === error);
    assert.equal(calls, error === timeout ? 3 : 1);
  }
});

test('HA rollout and recovery observations honor the configured provider deadline', () => {
  assert.equal(haProofTimeoutMs({}), 600_000);
  assert.equal(haProofTimeoutMs({ deploymentTimeoutSeconds: 900 }), 900_000);
  assert.equal(haProofTimeoutMs({ deploymentTimeoutSeconds: 180 }), 180_000);
  for (const deploymentTimeoutSeconds of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => haProofTimeoutMs({ deploymentTimeoutSeconds }), /positive whole-second/);
});

test('cross-owner notification fixture authenticates its streams and mutations as a UI operator', async () => {
  const key = 'disposable-notification-test-key';
  const hash = (suffix) => createHash('sha256').update(`${key}:${suffix}`).digest('hex');
  const streams = new Set();
  let revision = 1;
  let library = { migratedLegacyProjectIds: [] };
  let authenticated = 0;
  const server = createServer(async (req, res) => {
    if (req.headers['x-rivet-proxy-auth'] !== hash('proxy-auth') ||
        req.headers.cookie !== `rivet_ui_token=${hash('ui-session')}`) {
      res.writeHead(403).end();
      return;
    }
    authenticated++;
    const emit = (stream, event) => stream.write(`event: ${event}\ndata: ${JSON.stringify({ revision })}\n\n`);
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(res);
      res.on('close', () => streams.delete(res));
      emit(res, 'snapshot');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    let result;
    if (req.url.endsWith('/library')) {
      if (req.method === 'PUT') {
        library = body.library;
        revision++;
        for (const stream of streams) emit(stream, 'library-changed');
      }
      result = { revision, library };
    } else {
      revision++;
      for (const stream of streams) emit(stream, 'tree-changed');
      result = { project: { relativePath: 'synthetic.rivet-project' } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const child = spawn(process.execPath, [
      path.join(rootDir, 'deploy/studio-server/scripts/fixtures/ha-notification-probe.mjs'), 'localhost',
    ], {
      env: { ...process.env, PORT: String(server.address().port), RIVET_KEY: key, RIVET_HA_HEADLESS_SERVICE: '' },
      windowsHide: true,
      timeout: 20_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).directions.length, 2);
    assert.equal(authenticated, 14);
  } finally {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recovery faults require the same approved context before traffic or cluster access', async () => {
  await assert.rejects(
    verifyHaReleaseRecovery(
      {
        assertProofContext: async () => {
          throw Error('unapproved recovery context');
        },
        requestWorkflow: async () => {
          throw Error('must not send traffic');
        },
        kubectl: async () => {
          throw Error('must not access cluster');
        },
      },
      'https://staging.example.test',
      rootDir,
    ),
    /unapproved recovery context/,
  );
});

test('shared HA rollout refuses an unapproved proof context before reading keys or changing resources', async () => {
  let touched = false;
  await assert.rejects(
    runHaReleaseRollout(
      {
        config: { images: {} },
        assertProofContext: async () => {
          throw Error('unapproved provider context');
        },
        loadWorkflowKey: async () => {
          touched = true;
        },
      },
      'https://staging.example.test',
    ),
    /unapproved provider context/,
  );
  assert.equal(touched, false);
});

test('provider proof reads the real managed database without creating a local PostgreSQL fixture', async () => {
  const queries = [];
  const probes = new HaReleaseProbes(
    {
      config: { namespace: 'rivet-staging-proof' },
      readProofSql: async (query) => {
        queries.push(query);
        return [{ accepted: true }];
      },
      kubectl: async () => {
        throw Error('local database must not be used');
      },
    },
    'https://staging.example.test',
    rootDir,
  );
  assert.deepEqual(await probes.sql('SELECT accepted'), [{ accepted: true }]);
  assert.deepEqual(queries, ['SELECT accepted']);
});

test('provider proof refuses a changed cluster endpoint, namespace UID or ownership label before mutation', async () => {
  for (const changed of ['endpoint', 'uid', 'label']) {
    const identity = {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const gate = new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof' }, 'unused', 'unused', {
      values: {},
      identity,
    });
    gate.assertContext = async () => {};
    gate.kubectl = async (args) => ({
      stdout: JSON.stringify(
        args[0] === 'config'
          ? {
              clusters: [
                { cluster: { server: changed === 'endpoint' ? 'https://other.gke.goog' : identity.clusterServer } },
              ],
            }
          : {
              metadata: {
                uid: changed === 'uid' ? 'replacement' : identity.namespaceUid,
                labels: { 'rivet.dev/ha-rehearsal': changed === 'label' ? 'someone-else' : identity.operation },
              },
            },
      ),
    });
    await assert.rejects(gate.assertProofContext(), /changed|replaced|not owned/);
  }
});

test('provider proof cannot send its UI credentials to a different origin or execute SQL writes', async () => {
  const gate = new ProviderHaReleaseGate(
    { namespace: 'rivet-staging-proof', baseUrl: 'https://staging.example.test' },
    'unused',
    'unused',
    {
      values: {},
      identity: {
        clusterServer: 'https://staging.gke.goog',
        namespaceUid: '11111111-1111-4111-8111-111111111111',
        operation: 'staging-proof',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    },
  );
  assert.throws(() => gate.requestWorkflow('https://production.example.test', '/api/config'), /staging origin/);
  await assert.rejects(gate.readProofSql('DELETE FROM workflows'), /read-only/);
});

function providerFixture(config = {}, expiresAt = '2099-01-01T00:00:00Z') {
  return new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof', ...config }, 'unused', 'unused', {
    values: {},
    identity: {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt,
    },
  });
}

test('provider close retains its operator namespace even when local cleanup is requested', async () => {
  const gate = providerFixture({ keepNamespace: false });
  gate.kubectl = async () => {
    throw Error('provider close must not access or delete infrastructure');
  };
  let stopped = 0;
  gate.portForward = {
    killed: false,
    kill() {
      this.killed = true;
      stopped++;
    },
  };
  await gate.close();
  await gate.close();
  assert.equal(stopped, 1);
  assert.equal(gate.config.keepNamespace, true);
});

test('expired provider rehearsal refuses work before contacting the cluster or reading credentials', async () => {
  const gate = providerFixture({}, '2000-01-01T00:00:00Z');
  gate.assertContext = gate.loadWorkflowKey = async () => {
    throw Error('must not contact resources');
  };
  await assert.rejects(gate.seed(), /expired/);
});

test('provider expiry during a read retry or identity check still fences the next mutation', async (t) => {
  const gate = providerFixture();
  const expiry = Date.parse(gate.identity.expiresAt);
  let now = expiry - 1;
  t.mock.method(Date, 'now', () => now);
  gate.assertContext = async () => {};
  gate.kubectl = async (args) => {
    if (args[0] === 'config') return { stdout: JSON.stringify({ clusters: [{ cluster: { server: gate.identity.clusterServer } }] }) };
    now = expiry;
    return { stdout: JSON.stringify({ metadata: { uid: gate.identity.namespaceUid,
      labels: { 'rivet.dev/ha-rehearsal': gate.identity.operation } } }) };
  };
  await assert.rejects(gate.assertProofContext(), /expired during identity checks/);
});

test('uncertain provider seed cannot replay any application mutation', async () => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-seed-'));
  try {
    const gate = providerFixture({ artifactsDir });
    gate.assertProofContext = gate.loadWorkflowKey = async () => {};
    let writes = 0;
    gate.requestWorkflow = async () => {
      writes++;
      throw Error('lost response after acceptance');
    };
    await assert.rejects(gate.seed(), /lost response/);
    await assert.rejects(gate.seed(), { code: 'EEXIST' });
    assert.equal(writes, 1);
  } finally {
    await fs.rm(artifactsDir, { recursive: true, force: true });
  }
});

test('provider observations run inside a database read-only transaction even for SELECT with side effects', async () => {
  const gate = providerFixture({ release: 'rivet-staging-proof' });
  gate.kubectl = async (args) => {
    assert.ok(args.includes('rivet-staging-proof-ha-backend-0'));
    assert.match(args[args.indexOf('-e') + 1], /BEGIN READ ONLY/);
    assert.equal(args.at(-1), 'SELECT destructive_function()');
    return { stdout: '7' };
  };
  assert.equal(await gate.readProofSql('SELECT destructive_function()'), 7);
});

test('provider browser uses the ordinary authenticated session without following redirects', async () => {
  const gate = providerFixture({ baseUrl: 'https://staging.example.test' });
  gate.secrets = { rivetKey: 'test-only-key' };
  await gate.authenticateBrowser({
    request: {
      post: async (url, options) => {
        assert.equal(url, 'https://staging.example.test/__rivet_auth');
        assert.deepEqual(options, { data: { key: 'test-only-key' }, maxRedirects: 0 });
        return { status: () => 204 };
      },
    },
  });
  await assert.rejects(
    gate.authenticateBrowser({ request: { post: async () => ({ status: () => 302 }) } }),
    /real authenticated/,
  );
});

test('provider HTTP login uses the public proxy contract and retains only its session cookie', async () => {
  const server = createServer(async (req, res) => {
    if (req.url !== '/__rivet_auth') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(body), { key: 'test-only-key' });
    res
      .writeHead(204, { 'set-cookie': 'rivet_ui_token=test-only-session; Path=/; HttpOnly; Secure; SameSite=Lax' })
      .end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const gate = providerFixture({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    gate.providerValues.auth = { keySecretName: 'fixture' };
    gate.kubectl = async () => ({
      stdout: JSON.stringify({ data: { RIVET_KEY: Buffer.from('test-only-key').toString('base64') } }),
    });
    await gate.loadWorkflowKey();
    assert.deepEqual(gate.probeHeaders, { cookie: 'rivet_ui_token=test-only-session' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
function certificationFixture(predecessorRelease = null) {
  const images = Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((key, index) => [
      key,
      { repository: `example.test/rivet/${key}`, digest: `sha256:${String(index + 1).repeat(64)}` },
    ]),
  );
  const sourceSha = 'a'.repeat(40);
  const manifest = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: sourceSha },
    images,
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    predecessorRelease,
  });
  return { manifest, options: { rootDir, sourceSha, images, previous: predecessorRelease } };
}

test('HA certification accepts exact candidates without treating them as deployable releases', () => {
  const { manifest, options } = certificationFixture();
  assert.equal(validateHaCertificationManifest(manifest, options).mode, 'bootstrap');
  const reordered = Object.fromEntries(Object.entries(options.images).reverse());
  assert.equal(validateHaCertificationManifest(manifest, { ...options, images: reordered }).mode, 'bootstrap');
  const promoted = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  assert.throws(() => validateHaCertificationManifest(promoted, options), /requires a candidate/);
});

test('HA candidate preflight preserves source, chart, image and exact predecessor checks', () => {
  const { manifest, options } = certificationFixture();
  assert.throws(
    () => validateHaCertificationManifest(manifest, { ...options, sourceSha: 'b'.repeat(40) }),
    /current checkout/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(
        {
          ...manifest,
          chart: { ...manifest.chart, contentDigest: `sha256:${'f'.repeat(64)}` },
        },
        options,
      ),
    /current Helm chart/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(manifest, {
        ...options,
        images: { ...options.images, api: { ...options.images.api, digest: `sha256:${'f'.repeat(64)}` } },
      }),
    /HA images must match/,
  );
  const previous = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const next = certificationFixture(previous);
  assert.equal(validateHaCertificationManifest(next.manifest, next.options).mode, 'bootstrap');
  assert.throws(
    () => validateHaCertificationManifest(next.manifest, { ...next.options, previous: null }),
    /predecessor/,
  );
});

test('disposable PostgreSQL really provides the HA fixture connection budget', async () => {
  const gate = new HaReleaseGate({ namespace: 'fixture' }, 'unused', 'unused');
  let postgres;
  gate.kubectl = async (args, extra) => {
    if (args[0] === 'get') return { stdout: 'local-node' };
    if (extra?.input)
      for (const doc of parseAllDocuments(extra.input)) {
        assert.equal(doc.errors.length, 0);
        const resource = doc.toJSON();
        if (resource?.kind === 'Deployment' && resource.metadata.name === 'release-gate-postgres')
          postgres = resource.spec.template.spec.containers[0];
      }
    return { stdout: '' };
  };
  gate.waitForDependency = async () => {};
  await gate.installDependencies();
  assert.deepEqual(postgres.args, ['postgres', '-c', 'max_connections=250']);
});

test('HA preparation never deletes or rotates Secrets in an existing namespace', async () => {
  const gate = new HaReleaseGate({ namespace: 'existing' }, 'unused', 'unused');
  const calls = [];
  gate.assertLocalContext = async () => {};
  gate.kubectl = async (args) => {
    calls.push(args);
    return { stdout: 'namespace/existing\n' };
  };
  gate.createNamespace = async () => {
    throw Error('must not mutate');
  };
  await assert.rejects(gate.prepare(), /fresh disposable namespace/);
  assert.deepEqual(calls, [['get', 'namespace', 'existing', '--ignore-not-found', '-o', 'name']]);
});

test('the local proof cannot select a production context, even when allow-context matches', async () => {
  const gate = new HaReleaseGate({ context: 'gke-production', allowedContext: 'gke-production' }, 'unused', 'unused');
  gate.kubectl = async () => {
    throw Error('must not access cluster');
  };
  await assert.rejects(gate.assertLocalContext(), /disposable local cluster/);
});

test('baseline publisher is isolated, digest-pinned and cleaned up after success or failure', async () => {
  for (const failure of [false, true]) {
    const calls = [];
    const gate = {
      config: { namespace: 'disposable', release: 'fixture' },
      assertLocalContext: async () => {},
      kubectl: async (args, options) => {
        const command = args[2];
        calls.push({ command, args, options });
        if (command === 'get')
          return {
            stdout: JSON.stringify({
              items: [
                {
                  status: { conditions: [{ type: 'Ready', status: 'True' }] },
                  spec: {
                    containers: [
                      {
                        name: 'web',
                        image: 'current',
                        lifecycle: { preStop: { exec: { command: ['sleep', '120'] } } },
                        env: [{ name: 'RIVET_WEB_ASSETS_INSTALLATION', value: 'disposable/fixture' }],
                      },
                    ],
                  },
                },
              ],
            }),
          };
        if (command === 'exec') {
          if (failure) throw Error('publication failed');
          return { stdout: 'a'.repeat(64) };
        }
        return { stdout: '' };
      },
    };
    const image = { repository: 'registry/web', digest: `sha256:${'b'.repeat(64)}` };
    if (failure) await assert.rejects(publishHaBrowserBaseline(gate, image), /publication failed/);
    else assert.deepEqual(await publishHaBrowserBaseline(gate, image), { ...image, build: 'a'.repeat(64) });
    const pod = JSON.parse(calls.find((c) => c.command === 'create').options.input);
    assert.equal(pod.spec.containers[0].image, `${image.repository}@${image.digest}`);
    assert.equal(pod.spec.containers[0].lifecycle, undefined, 'non-serving publisher needs no edge-drain hook');
    assert.equal(pod.metadata.labels, undefined, 'publisher must not enter a release Service');
    assert.equal(calls.at(-1).command, 'delete');
  }
});
