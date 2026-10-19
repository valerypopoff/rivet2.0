import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { assertGkeFrontendAvailability, verifyGkeFrontendEvictions } from './lib/ha-gke-availability.mjs';
import { startHaWebAppTraffic, startHaWorkflowTraffic } from './lib/ha-workflow-traffic.mjs';
import { ManagedReleaseGate } from './kubernetes-managed-release-gate.mjs';
import { assertProviderHaFrontendPolicy } from './kubernetes-ha-provider-gate.mjs';
import { maintenanceValidationValues } from './lib/managed-release-cutover.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const release = 'gke-proof';
const namespace = 'rivet-staging-proof';
const neg = 'cloud.google.com/load-balancer-neg-ready';

test('provider identity must declare its platform and GKE cannot silently omit the new proof', () => {
  const identity = { provider: 'gke', clusterServer: 'https://cluster.gke.goog' };
  const values = { availability: { gkeGateway: true } };
  assert.doesNotThrow(() => assertProviderHaFrontendPolicy(values, identity));
  for (const provider of [undefined, 'other', 'unknown'])
    assert.throws(() => assertProviderHaFrontendPolicy(values, { ...identity, provider }));
  assert.throws(() => assertProviderHaFrontendPolicy({}, identity), /requires the guarded/);
  assert.throws(() => assertProviderHaFrontendPolicy({}, { ...identity, clusterServer: 'https://192.0.2.1' }), /requires the guarded/);
  assert.doesNotThrow(() => assertProviderHaFrontendPolicy({}, { provider: 'other', clusterServer: 'https://other.example.test' }));
});

function fixture() {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ metadata: {
    name: `node-${i}`, uid: `node-uid-${i}`, labels: {
      'kubernetes.io/hostname': `host-${i}`, 'topology.kubernetes.io/zone': `zone-${i % 3}`,
    },
  } }));
  const pod = (role, i) => ({
    metadata: { name: `${role}-${i}`, uid: `${role}-uid-${i}`, namespace,
      labels: { 'app.kubernetes.io/component': role, 'app.kubernetes.io/instance': release } },
    spec: { nodeName: `node-${i}`, readinessGates: role === 'proxy' ? [{ conditionType: neg }] : [],
      topologySpreadConstraints: [{ topologyKey: 'topology.kubernetes.io/zone', nodeTaintsPolicy: 'Honor',
        whenUnsatisfiable: 'DoNotSchedule', minDomains: 3, maxSkew: 1 }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }, ...(role === 'proxy'
      ? [{ type: neg, status: 'True', reason: 'LoadBalancerNegReady' }] : [])] },
  });
  return { nodes, pods: [...nodes.map((_, i) => pod('proxy', i)), pod('web', 0), pod('web', 1)] };
}

function render(overrides = [], gke = true) {
  return execFileSync(resolveHelmBinOrThrow(rootDir), ['template', release, 'deploy/studio-server/helm',
    '-f', 'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
    ...(gke ? ['-f', 'deploy/studio-server/helm/overlays/gke-ha.yaml'] : []),
    '--set', 'objectStorage.bucket=fixture', '--set', 'postgres.maxConnections=250',
    ...overrides.flatMap(value => ['--set', value])], { cwd: rootDir, encoding: 'utf8', stdio: 'pipe' });
}

test('GKE profile enforces six separated proxies, hard three-zone spread, PDB and surge', () => {
  const resources = parseAllDocuments(render()).map(doc => {
    assert.equal(doc.errors.length, 0);
    return doc.toJS();
  });
  const workloads = resources.filter(r => ['Deployment', 'StatefulSet'].includes(r.kind));
  const proxy = workloads.find(r => r.metadata.labels['app.kubernetes.io/component'] === 'proxy');
  assert.equal(proxy.spec.replicas, 6);
  assert.equal(proxy.spec.minReadySeconds, 120);
  assert.deepEqual(proxy.spec.strategy.rollingUpdate, { maxUnavailable: 0, maxSurge: 1 });
  for (const workload of workloads) {
    const spec = workload.spec.template.spec;
    assert.equal(spec.terminationGracePeriodSeconds, 270);
    const spread = spec.topologySpreadConstraints[0];
    assert.equal(spread.whenUnsatisfiable, 'DoNotSchedule');
    assert.equal(spread.minDomains, 3);
    assert.equal(spread.maxSkew, 1);
    assert.equal(spread.topologyKey, 'topology.kubernetes.io/zone');
    assert.equal(spread.nodeTaintsPolicy, 'Honor');
    const affinity = spec.affinity.podAntiAffinity;
    assert.equal(affinity.preferredDuringSchedulingIgnoredDuringExecution, undefined);
    assert.equal(affinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, 'kubernetes.io/hostname');
    assert.deepEqual(affinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector, spread.labelSelector);
    assert.equal(spread.labelSelector.matchLabels['app.kubernetes.io/instance'], release);
  }
  const pdb = resources.find(r => r.kind === 'PodDisruptionBudget' && r.spec.selector.matchLabels['app.kubernetes.io/component'] === 'proxy');
  assert.equal(pdb.spec.maxUnavailable, 1);
});

test('GKE policy cannot silently lose replicas, spread, isolation or PDB protection through installation overrides', () => {
  for (const [overrides, message] of [
    [['replicaCount.proxy=2'], /six|minimum of 6/],
    [['replicaCount.web=1'], /minimum of 2/],
    [['autoscaling.proxy.enabled=true', 'autoscaling.proxy.minReplicas=2'], /minimum of 6/],
    [['autoscaling.proxy.enabled=true', 'replicaCount.proxy=0'], /minimum of 6/],
    [['autoscaling.web.enabled=true', 'replicaCount.web=1'], /minimum of 2/],
    [['availability.topologySpread.minDomains=2'], /hard zone spread/],
    [['availability.topologySpread.enabled=false'], /hard zone spread/],
    [['availability.topologySpread.nodeTaintsPolicy=Ignore'], /nodeTaintsPolicy=Honor/],
    [['availability.topologySpread.nodeTaintsPolicy='], /nodeTaintsPolicy=Honor/],
    [['availability.topologySpread.whenUnsatisfiable=ScheduleAnyway'], /requires DoNotSchedule/],
    [['availability.podAntiAffinity.required=false'], /hard hostname/],
    [['availability.podAntiAffinity.enabled=false'], /anti-affinity must be enabled/],
    [['availability.disruptionBudget.enabled=false'], /disruption budget/],
    [['availability.disruptionBudget.maxUnavailable=2'], /maxUnavailable=1/],
    [['rollout.maxUnavailable=1'], /rollout.maxUnavailable=0/],
    [['rollout.maxSurge=0'], /rollout.maxSurge=1/],
    [['ha.enabled=false'], /requires cluster HA/],
    [['gateway.mode=external'], /requires cluster HA/],
  ]) assert.throws(() => render(overrides), error => message.test(String(error.stderr)), overrides.join(','));
});

test('GKE policy preserves explicit maintenance validation with public tiers stopped', () => {
  const resources = parseAllDocuments(render([
    'workflowSchema.maintenanceValidation=true', 'replicaCount.proxy=0', 'replicaCount.web=0',
    'autoscaling.proxy.enabled=false', 'autoscaling.web.enabled=false', 'autoscaling.execution.enabled=false',
  ])).map(doc => doc.toJS());
  const frontend = resources.filter(r => r.kind === 'Deployment');
  assert.ok(frontend.length >= 2);
  for (const resource of frontend) assert.equal(resource.spec.replicas, 0);
});

test('GKE HA adoption renders the launcher actual singleton validation overlay and keeps the full profile guarded', () => {
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return item && typeof item === 'object' ? flatten(item, field) : [`${field}=${item}`];
  });
  const resources = parseAllDocuments(render([
    ...flatten(maintenanceValidationValues), 'ha.enabled=false', 'replicaCount.backend=1',
  ])).map(doc => doc.toJS());
  const backend = resources.find(r => r.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'backend');
  assert.equal(backend.spec.replicas, 1);
  for (const resource of resources.filter(r => r.kind === 'Deployment' &&
    ['proxy', 'web', 'evaluation'].includes(r.metadata.labels['app.kubernetes.io/component'])))
    assert.equal(resource.spec.replicas, 0);
  assert.equal(resources.some(r => r.kind === 'HorizontalPodAutoscaler'), false);
  assert.throws(() => render(['ha.enabled=false']), error => /requires cluster HA/.test(String(error.stderr)));
  const resumed = parseAllDocuments(render()).map(doc => doc.toJS());
  assert.equal(resumed.find(r => r.kind === 'Deployment' && r.metadata.labels['app.kubernetes.io/component'] === 'proxy').spec.replicas, 6);
});

test('native placement options reject fractional domains and string booleans', () => {
  for (const value of ['0', '1.5']) assert.throws(() => render([`availability.topologySpread.minDomains=${value}`]));
  assert.throws(() => render(['availability.podAntiAffinity.required=not-a-boolean']), /must be a boolean/);
  for (const value of ['false', 'null', 'invalid'])
    assert.throws(() => render([`availability.topologySpread.nodeTaintsPolicy=${value}`]), /must be empty, Honor or Ignore/);
});

test('generic placement retains the omitted taint policy and permits explicit native policies', () => {
  for (const policy of [undefined, 'Ignore', 'Honor']) {
    const resources = parseAllDocuments(render(policy ?
      [`availability.topologySpread.nodeTaintsPolicy=${policy}`] : [], false)).map(doc => doc.toJS());
    for (const r of resources.filter(r => ['Deployment', 'StatefulSet'].includes(r.kind)))
      assert.equal(r.spec.template.spec.topologySpreadConstraints[0].nodeTaintsPolicy, policy);
  }
});

test('positive GKE observation has six actually health-checked proxy endpoints, never just six Ready bits', () => {
  const state = fixture();
  const copy = structuredClone(state);
  assert.equal(assertGkeFrontendAvailability(state.pods, state.nodes, release).length, 8);
  assert.deepEqual(state, copy);
});

test('GKE preflight rejects premature readiness, co-location, missing identities and insufficient zonal redundancy', () => {
  const changes = [
    s => { s.pods[0].status.conditions[1].reason = 'LoadBalancerNegWithoutHealthCheck'; },
    s => { s.pods[0].status.conditions[1].reason = 'LoadBalancerNegTimeout'; },
    s => { s.pods[0].status.conditions[1].status = 'False'; },
    s => { s.pods[0].spec.readinessGates = []; },
    s => { delete s.pods[0].spec.topologySpreadConstraints[0].nodeTaintsPolicy; },
    s => { s.pods[0].spec.topologySpreadConstraints[0].nodeTaintsPolicy = 'Ignore'; },
    s => { s.pods[0].spec.topologySpreadConstraints[0].whenUnsatisfiable = 'ScheduleAnyway'; },
    s => { s.pods[0].status.conditions[0].status = 'False'; },
    s => { s.pods[0].metadata.deletionTimestamp = '2026-10-18T00:00:00Z'; },
    s => { s.pods[0].spec.nodeName = s.pods[1].spec.nodeName; },
    s => { s.nodes[0].metadata.labels['kubernetes.io/hostname'] = s.nodes[1].metadata.labels['kubernetes.io/hostname']; },
    s => { delete s.nodes[0].metadata.uid; },
    s => { s.nodes[0].metadata.labels['topology.kubernetes.io/zone'] = 'zone-1'; },
    s => { s.pods[0].metadata.labels['app.kubernetes.io/instance'] = 'other-release'; },
    s => { s.pods.pop(); },
  ];
  for (const change of changes) {
    const state = fixture(); change(state);
    assert.throws(() => assertGkeFrontendAvailability(state.pods, state.nodes, release));
  }
});

async function proofFixture(t, failure) {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-frontend-proof-'));
  t.after(() => fs.rm(artifactsDir, { recursive: true, force: true }));
  const state = fixture();
  const writes = [], artifacts = new Map();
  let observations = 0;
  let expired = false;
  const gate = {
    config: { namespace, release, artifactsDir, deploymentTimeoutSeconds: 5 },
    providerValues: { availability: { gkeGateway: true } },
    assertProofContext: async () => {
      if (failure === 'foreign-context') throw Error('wrong context');
      if (expired) throw Error('proof expired');
    },
    artifact: async (name, value) => {
      const report = JSON.parse(value);
      artifacts.set(name, report);
      if (failure === 'expired-before-write' && report.evictions?.length) expired = true;
    },
    requestWorkflow: async (_url, route) => {
      observations++;
      if (failure === 'web-failure' && route.startsWith('/apps/')) throw Error('503 web app');
      return route.startsWith('/apps/') ? 'Managed release gate app' : { outputs: {} };
    },
    kubectl: async (args, options) => {
      if (args[0] === 'create') {
        const eviction = JSON.parse(options.input);
        assert.equal(artifacts.get('provider-frontend-evictions.json').evictions.at(-1).acknowledged, false);
        writes.push({ args, eviction });
        assert.equal(eviction.deleteOptions.preconditions.uid, state.pods.find(p => p.metadata.name === eviction.metadata.name).metadata.uid);
        if (failure === 'pdb-rejection') throw Error('429 disruption budget');
        state.pods = state.pods.map(p => p.metadata.name === eviction.metadata.name
          ? { ...p, metadata: { ...p.metadata, name: `${p.metadata.name}-replacement`, uid: `${p.metadata.uid}-replacement` } } : p);
        if (failure === 'lost-ack') throw Error('eviction acknowledgement lost');
        return { stdout: '' };
      }
      let value;
      if (args.includes('nodes')) value = { items: state.nodes };
      else if (args.includes('pods')) value = { items: state.pods };
      else {
        const p = state.pods.find(p => p.metadata.name === args[4]);
        value = failure === 'changed-uid' ? { ...p, metadata: { ...p.metadata, uid: 'different' } } : p;
      }
      return { stdout: JSON.stringify(value) };
    },
  };
  return { gate, writes, artifacts, observations: () => observations };
}

test('frontend eviction proof uses policy Eviction with exact UIDs, checks actual replacement health, and observes both public streams', async t => {
  const f = await proofFixture(t);
  const result = await verifyGkeFrontendEvictions(f.gate, 'https://staging.example.test');
  assert.equal(result.phase, 'passed');
  assert.equal(f.writes.length, 4, 'two distinct-node proxies plus only their co-located web pods');
  for (const { args, eviction } of f.writes) {
    assert.match(args[2], /^\/api\/v1\/namespaces\/rivet-staging-proof\/pods\/(proxy|web)-[01]\/eviction$/);
    assert.equal(eviction.apiVersion, 'policy/v1');
    assert.equal(eviction.metadata.namespace, namespace);
  }
  assert.ok(result.evictions.every(p => p.acknowledged));
  assert.ok(result.after.every(p => !result.evictions.some(old => p.uid === old.uid)));
  assert.ok(result.workflow.samples >= 100 && result.webApp.samples > 0);
  assert.equal(result.workflow.failures.length + result.webApp.failures.length, 0);
  await assert.rejects(verifyGkeFrontendEvictions(f.gate, 'https://staging.example.test'), { code: 'EEXIST' });
  assert.equal(f.writes.length, 4, 'an admitted proof cannot replay evictions');
});

for (const failure of ['foreign-context', 'changed-uid', 'lost-ack', 'pdb-rejection', 'expired-before-write', 'web-failure']) {
  test(`frontend eviction proof stops on ${failure} without retry or direct deletion`, async t => {
    const f = await proofFixture(t, failure);
    await assert.rejects(verifyGkeFrontendEvictions(f.gate, 'https://staging.example.test'));
    assert.equal(f.writes.length, ['lost-ack', 'pdb-rejection'].includes(failure) ? 1 : 0);
    assert.ok([...f.artifacts.values()].every(r => r.phase !== 'passed'));
    if (failure === 'foreign-context') assert.equal(f.observations(), 0);
  });
}

test('web observation rejects HTML without the published app and includes a late failed request during stop', async () => {
  for (const value of ['Managed release gate app', '<html>maintenance</html>', null]) {
    let finish;
    const traffic = startHaWebAppTraffic({ requestWorkflow: () => new Promise(resolve => { finish = resolve; }) }, 'https://staging.example.test');
    const stop = traffic.stop();
    finish(value);
    const report = await stop;
    assert.equal(report.samples, value === 'Managed release gate app' ? 1 : 0);
    assert.equal(report.failures.length, value === 'Managed release gate app' ? 0 : 1);
  }
});

test('real HTTP failure evidence retains a fingerprint and fixed classifications, not server text, body or auth', async () => {
  const body = '<html>private diagnostic secret</html>';
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.writeHead(503, {
    'server': 'nginx/private-secret', 'content-type': 'text/html', 'set-cookie': 'secret-cookie',
  }); res.end(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const gate = new ManagedReleaseGate({ namespace, release }, 'unused', 'unused');
    gate.secrets = { rivetKey: 'secret-key' };
    const traffic = startHaWorkflowTraffic(gate, `http://127.0.0.1:${server.address().port}`);
    const report = await traffic.stop();
    assert.equal(calls, 1);
    assert.equal(report.failedRequests[0].error.status, 503);
    assert.deepEqual(report.failedRequests[0].http, { server: 'nginx', format: 'html',
      bodyBytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex') });
    assert.doesNotMatch(JSON.stringify(report), /secret|set-cookie|authorization|<html>/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
