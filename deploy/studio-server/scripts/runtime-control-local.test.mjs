import assert from 'node:assert/strict';
import test from 'node:test';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  RuntimeControlLocalGate,
  mergeRuntimeControlGuards,
  hasRuntimeControlPublicEndpoint,
  waitForRuntimeControlColdProxies,
  runtimeControlOwnerContainer,
  publishedScheduleCompletedWithoutDevelopers,
} from './kubernetes-runtime-control-local.mjs';

test('schedule independence requires one recorded execution started after developer shutdown', () => {
  const complete = { status: 'succeeded', recordingStatus: 'saved', startedAt: 1100 };
  assert.equal(publishedScheduleCompletedWithoutDevelopers([], 1000), false);
  assert.equal(publishedScheduleCompletedWithoutDevelopers([{ status: 'pending' }], 1000), false);
  assert.equal(publishedScheduleCompletedWithoutDevelopers([complete], 1000), true);
  for (const runs of [
    [{ ...complete, startedAt: 999 }],
    [{ ...complete, startedAt: undefined }],
    [complete, complete],
    [{ ...complete, status: 'failed' }],
  ])
    assert.throws(() => publishedScheduleCompletedWithoutDevelopers(runs, 1000));
});

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

test('fresh namespace UID is retained before bootstrap writes; an existing namespace is never adopted', async () => {
  const gate = Object.create(RuntimeControlLocalGate.prototype),
    artifacts = new Map();
  gate.config = { context: 'rivet-runtime-ha10-test', namespace: 'rivet-runtime-control-test', release: 'rivet' };
  let existing = false,
    writes = 0;
  let creationRace = false;
  gate.deleteOwnedNamespace = async () => assert.fail('A fresh fixture must never delete another namespace');
  gate.kubectl = async (args) => {
    if (args.includes('--ignore-not-found')) return { stdout: existing ? 'namespace/existing' : '' };
    assert.deepEqual(args, ['create', '-f', '-', '-o', 'json']);
    writes++;
    if (creationRace) throw Error('Namespace already exists');
    return {
      stdout: JSON.stringify({
        metadata: { name: gate.config.namespace, uid: 'new-exact-uid', labels: { 'rivet.release-gate/owned': 'true' } },
      }),
    };
  };
  gate.artifact = async (name, text) => artifacts.set(name, JSON.parse(text));
  await gate.createNamespace();
  assert.deepEqual(artifacts.get('namespace-identity.json'), {
    protocol: 1,
    ...gate.config,
    namespaceUid: 'new-exact-uid',
  });
  assert.equal(writes, 1);
  existing = true;
  artifacts.clear();
  await assert.rejects(gate.createNamespace(), /fresh namespace/);
  assert.equal(writes, 1);
  assert.equal(artifacts.size, 0);
  existing = false;
  creationRace = true;
  await assert.rejects(gate.createNamespace(), /already exists/);
  assert.equal(writes, 2);
  assert.equal(artifacts.size, 0);
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

test('active-controller evidence requires fresh numeric samples and the exact policy and image', async () => {
  const gate = Object.create(RuntimeControlLocalGate.prototype);
  gate.config = { release: 'fixture', deploymentTimeoutSeconds: 3, images: { api: { digest: 'exact-image' } } };
  let reads = 0;
  const record = {
    autoscalingProtocol: 1,
    phase: 'complete',
    leaseExpiresAt: 0,
    lastSampleAt: 123,
    policyDigest: autoscalerPolicyDigest({}),
    manifestDigest: 'exact-image',
  };
  gate.kube = async () => ({
    stdout: JSON.stringify({
      data: { record: JSON.stringify({ ...record, lastSampleAt: ++reads === 1 ? null : record.lastSampleAt }) },
    }),
  });
  assert.equal((await gate.assertAutoscalerActive(123)).sampleAt, 123);
  assert.equal(reads, 2, 'an omitted/null sample must not be considered fresh');
  record.policyDigest = 'wrong-policy';
  await assert.rejects(gate.assertAutoscalerActive(123));
});
