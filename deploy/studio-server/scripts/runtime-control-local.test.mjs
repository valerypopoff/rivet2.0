import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeControlLocalGate,
  mergeRuntimeControlGuards,
  hasRuntimeControlPublicEndpoint,
  waitForRuntimeControlColdProxies,
  runtimeControlOwnerContainer,
} from './kubernetes-runtime-control-local.mjs';

test('local runtime proof rejects production and ambiguous contexts before issuing commands', async () => {
  for (const [context, allowedContext, namespace] of [
    [
      'gke_wartime-storyteller_europe-central2_rivet-cluster',
      'gke_wartime-storyteller_europe-central2_rivet-cluster',
      'rivet-runtime-control-test',
    ],
    ['rivet-runtime-ha10-test', 'other', 'rivet-runtime-control-test'],
    ['rivet-runtime-ha10-test', 'rivet-runtime-ha10-test', 'production'],
  ]) {
    let commands = 0;
    const gate = Object.create(RuntimeControlLocalGate.prototype);
    gate.config = { context, allowedContext, namespace };
    gate.assertContext = gate.kubectl = async () => {
      commands++;
    };
    await assert.rejects(gate.assertLocalContext());
    assert.equal(commands, 0);
  }
});

test('retirement targets the actual execution API or combined backend container, never a guessed name', () => {
  for (const name of ['api', 'backend'])
    assert.equal(runtimeControlOwnerContainer({ spec: { containers: [{ name: 'sidecar' }, { name }] } }), name);
  for (const containers of [[], [{ name: 'sidecar' }], [{ name: 'api' }, { name: 'backend' }]])
    assert.throws(() => runtimeControlOwnerContainer({ spec: { containers } }), /unambiguous API owner/);
});

test('local edge selection is explicit, defaults to six proxies and rejects unknown profiles', () => {
  const gate = Object.create(RuntimeControlLocalGate.prototype);
  gate.config = {};
  assert.equal(gate.proxyCount, 6);
  gate.config.runtimeEdgeProfile = 'compact';
  assert.equal(gate.proxyCount, 2);
  gate.config.runtimeEdgeProfile = 'typo';
  assert.throws(() => gate.proxyCount, /unknown local/);
});

for (const [profile, proxyCount] of [
  ['regional', 6],
  ['compact', 2],
]) {
  test(`${profile} developer recovery checks every proxy using only safe GETs after the allowed outage`, async () => {
    const gate = Object.create(RuntimeControlLocalGate.prototype);
    gate.config = { runtimeEdgeProfile: profile };
    const calls = [];
    gate.pods = async () =>
      Array.from({ length: proxyCount }, (_, i) => ({
        metadata: { name: `proxy-${i}`, labels: { 'app.kubernetes.io/component': 'proxy' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
        spec: { containers: [{ name: 'proxy', ports: [{ name: 'proxy-http', containerPort: 8080 }] }] },
      }));
    const probes = [];
    gate.kube = async (args) => {
      probes.push(args);
      return { exitCode: probes.length === 1 ? 1 : 0 };
    };
    gate.requestWorkflow = async (_base, route, options) => {
      calls.push({ route, method: options.method });
      if (calls.length === 1) throw new Error('Service propagation pending');
      return {};
    };
    await gate.waitForDeveloperRoute('http://127.0.0.1:1');
    assert.deepEqual(calls, [
      { route: '/api/config', method: 'GET' },
      { route: '/api/config', method: 'GET' },
      { route: '/api/config', method: 'GET' },
    ]);
    assert.equal(probes.length, proxyCount * 2, 'every proxy must recover, not just one successful load-balanced GET');
    assert.ok(probes.every((args) => args[0] === 'exec' && !args.at(-1).includes('--post')));
  });
}

test('cold proxy proof waits for terminating old processes, not just ready replacements', async () => {
  let reads = 0;
  await waitForRuntimeControlColdProxies(async () => {
    reads++;
    return reads === 1
      ? [{ metadata: { uid: 'old', deletionTimestamp: 'terminating' } }, { metadata: { uid: 'new' } }]
      : [{ metadata: { uid: 'new' } }];
  }, ['old']);
  assert.equal(reads, 2);
});

test('isolated execution replacement rejects a production context before fixture reads or writes', async () => {
  const gate = Object.create(RuntimeControlLocalGate.prototype);
  gate.config = {
    context: 'gke_production',
    allowedContext: 'gke_production',
    namespace: 'rivet-runtime-control-test',
  };
  let commands = 0;
  gate.kubectl = gate.kube = async () => {
    commands++;
  };
  await assert.rejects(gate.replaceIsolatedExecution());
  assert.equal(commands, 0);
});

test('local guarded values retain frontend capacity and schema bounds like layered Helm values', () => {
  const values = {
    ha: { enabled: true, controlPlane: { mode: 'singleton' } },
    replicaCount: { proxy: 6, web: 1, backend: 1, execution: 2 },
    workflowSchema: { compatibility: { minimumVersion: 16, maximumVersion: 16 } },
  };
  const guards = {
    ha: { rolloutResourceVersions: { backend: '4' } },
    replicaCount: { backend: 1, execution: 2 },
    workflowSchema: { migrationJob: { enabled: false } },
  };
  const merged = mergeRuntimeControlGuards(values, guards);
  assert.deepEqual(merged.replicaCount, values.replicaCount);
  assert.deepEqual(merged.ha.controlPlane, values.ha.controlPlane);
  assert.deepEqual(merged.workflowSchema.compatibility, values.workflowSchema.compatibility);
  assert.equal(merged.workflowSchema.migrationJob.enabled, false);
  assert.equal(values.ha.rolloutResourceVersions, undefined);
});

test('runtime isolation ignores discovery endpoints but requires explicit public routing withdrawal', () => {
  const services = [
    { metadata: { name: 'public' }, spec: {} },
    { metadata: { name: 'discovery' }, spec: { publishNotReadyAddresses: true } },
  ];
  const slice = (name, conditions) => ({
    metadata: { labels: { 'kubernetes.io/service-name': name } },
    endpoints: [{ targetRef: { uid: 'owner' }, conditions }],
  });
  assert.equal(hasRuntimeControlPublicEndpoint([slice('discovery', { ready: true })], services, 'owner'), false);
  assert.equal(hasRuntimeControlPublicEndpoint([slice('public', { ready: false })], services, 'owner'), false);
  assert.equal(hasRuntimeControlPublicEndpoint([slice('public', {})], services, 'owner'), true);
  assert.equal(hasRuntimeControlPublicEndpoint([slice('public', { ready: true })], services, 'other'), false);
});
