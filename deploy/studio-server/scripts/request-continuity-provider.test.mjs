import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { parse } from 'yaml';
import { ProviderRequestContinuity, qualifyProtectedProxyRoll } from './qualification/provider-request-continuity.mjs';
import { observeHpaContinuity } from './qualification/provider-proxy-hpa.mjs';
import { RuntimeControlLocalGate } from './kubernetes-runtime-control-local.mjs';
import { continuityStages } from './lib/request-continuity.mjs';
// test-style: fixture-read: Run the serialized test project and generated fixture code, without asserting production source text.

const profile = {
  protocol: 1,
  maxProtectedRequestSeconds: 300,
  backendServiceDrainSeconds: 600,
  propagationSeconds: 60,
  proxyPreStopDelaySeconds: 660,
  proxyTerminationGracePeriodSeconds: 900,
};
const pod = (uid, deleting = false) => ({
  metadata: {
    name: uid,
    uid,
    labels: { 'app.kubernetes.io/component': 'proxy' },
    ...(deleting ? { deletionTimestamp: new Date().toISOString() } : {}),
  },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});
function fixture() {
  const events = [],
    before = [pod('old1'), pod('old2')],
    after = [pod('new1'), pod('new2')];
  let patched = false,
    observations = 0;
  const deployment = {
    metadata: { uid: 'deployment', resourceVersion: '7', labels: { 'app.kubernetes.io/instance': 'fixture' } },
    spec: {
      replicas: 2,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0 } },
      template: {
        metadata: { annotations: { existing: 'retained' } },
        spec: {
          terminationGracePeriodSeconds: 900,
          containers: [{ lifecycle: { preStop: { exec: { command: ['/bin/sh', '-c', 'sleep 660'] } } } }],
        },
      },
    },
  };
  const gate = {
    config: { release: 'fixture' },
    operation: { operationId: randomUUID(), requestContinuityProfile: profile, installed: { qualificationValues: {} } },
    assertProofContext: async () => events.push('context'),
    kube: async (args) => {
      events.push(args[0]);
      if (args[0] === 'get') return { stdout: JSON.stringify(deployment) };
      assert.equal(args[0], 'patch');
      const patch = JSON.parse(args.at(-1));
      assert.deepEqual(patch.slice(0, 2), [
        { op: 'test', path: '/metadata/uid', value: 'deployment' },
        { op: 'test', path: '/metadata/resourceVersion', value: '7' },
      ]);
      assert.equal(patch[2].value.existing, 'retained');
      patched = true;
      return { stdout: '' };
    },
    pods: async () =>
      patched ? (observations++ === 0 ? [pod('old1', true), pod('old2'), pod('new1')] : after) : before,
    artifact: async () => events.push('intent'),
    verifyProtectedProxyAvailability: async () => ({
      profile,
      protectedProxies: true,
      actualBackendServiceDrainSeconds: 600,
      policyBackendServiceDrainSeconds: 600,
    }),
  };
  const probes = {
    startCohort: async (stage) => events.push('accepted:' + stage),
    settleCohort: async (stage) => events.push('complete:' + stage),
  };
  const waitFor = async (_label, check) => {
    for (let i = 0; i < 3; i++) if (await check()) return;
    throw Error('Fixture did not settle');
  };
  return { gate, probes, waitFor, events, deployment };
}
test('provider native proxy rollout admits every planned duration before one guarded mutation and observes retirement', async () => {
  const f = fixture();
  await qualifyProtectedProxyRoll(f.gate, f.probes, { waitFor: f.waitFor });
  assert.deepEqual(f.probes.replacement.before, ['old1', 'old2']);
  assert.deepEqual(f.probes.replacement.after, ['new1', 'new2']);
  assert.ok(f.probes.replacement.observedAt);
  assert.ok(f.events.indexOf('accepted:duration-295') < f.events.indexOf('intent'));
  assert.ok(f.events.indexOf('intent') < f.events.indexOf('patch'));
  assert.ok(f.events.indexOf('patch') < f.events.indexOf('complete:protected-roll'));
  assert.equal(f.events.filter((e) => e === 'patch').length, 1);
});
test('lost native-roll acknowledgement never retries or certifies replacement', async () => {
  const f = fixture(),
    kube = f.gate.kube;
  f.gate.kube = async (args) => {
    const result = await kube(args);
    if (args[0] === 'patch') throw Error('lost acknowledgement');
    return result;
  };
  await assert.rejects(qualifyProtectedProxyRoll(f.gate, f.probes, { waitFor: f.waitFor }), /lost acknowledgement/);
  assert.equal(f.events.filter((e) => e === 'patch').length, 1);
  assert.equal(f.probes.replacement, undefined);
});

test('focused qualification cannot invoke the separate cold-proxy rollout', async () => {
  const f = fixture();
  f.gate.operation.qualification = { tier: 'focused' };
  await assert.rejects(qualifyProtectedProxyRoll(f.gate, f.probes, { waitFor: f.waitFor }), /actual update/);
  assert.deepEqual(f.events, []);
});

for (const changed of [true, false]) {
  test(`focused request probe observes the actual template apply without a second rollout: changed=${changed}`, async () => {
    const f = fixture();
    f.gate.operation.qualification = { tier: 'focused' };
    f.gate.operation.installed.qualificationValues = {
      requestContinuity: {
        enabled: true,
        maxProtectedRequestSeconds: 300,
        backendServiceDrainSeconds: 600,
        propagationSeconds: 60,
      },
      lifecycle: { shutdownGraceSeconds: 120, proxy: { preStopDelaySeconds: 660, terminationGracePeriodSeconds: 900 } },
    };
    const probes = new ProviderRequestContinuity(f.gate);
    probes.proxyTemplate = structuredClone(f.deployment.spec.template);
    if (changed) probes.proxyTemplate.metadata.annotations.release = 'candidate';
    probes.startCohort = async (stage) => f.events.push(`accepted:${stage}`);
    await probes.beforeProxyTemplates();
    assert.equal(probes.replacement.changed, changed);
    assert.deepEqual(probes.replacement.before, ['old1', 'old2']);
    if (changed) {
      f.events.push('real-template-apply');
      probes.observeProxyPods([pod('new1'), pod('new2')]);
      assert.equal(probes.replacement.observedAt, undefined, 'Missing IDs alone do not prove when termination started');
      probes.observeProxyPods([pod('old1', true), pod('old2'), pod('new1')]);
      probes.observeProxyPods([pod('new1'), pod('new2')]);
      assert.ok(f.events.indexOf('accepted:protected-roll') < f.events.indexOf('real-template-apply'));
      assert.ok(probes.replacement.observedAt);
    } else {
      assert.ok(!f.events.some((e) => e.startsWith('accepted:')));
      assert.equal(probes.replacement.dispatchedAt, undefined);
    }
    assert.ok(!f.events.includes('patch'), 'The probe must observe the real update, never manufacture another one');
  });
}

test('focused journal observes real bridge boundaries without policy or late-admission batches', async () => {
  const f = fixture(),
    probes = new ProviderRequestContinuity(f.gate),
    stages = [];
  f.gate.operation.qualification = { tier: 'focused' };
  probes.prepared = true;
  const basePods = f.gate.pods;
  f.gate.pods = async () => [...(await basePods()), pod('old3'), pod('old4')];
  probes.startCohort = async (stage) => {
    stages.push(stage);
    probes.cohorts.set(stage, {});
  };
  probes.proxyTemplate = structuredClone(f.deployment.spec.template);
  probes.proxyTemplate.metadata.annotations.release = 'candidate';
  const state = { phase: 'creating', mutations: { policy: {} }, entries: [] };
  await probes.observeJournal({ phase: 'preflight', proxyContinuity: state });
  assert.deepEqual(stages, []);
  state.mutations.bridge = {};
  await probes.observeJournal({ phase: 'preflight', proxyContinuity: state });
  state.phase = 'bridge-serving';
  await probes.observeJournal({ phase: 'preflight', proxyContinuity: state });
  await probes.observeJournal({ phase: 'templates', proxyContinuity: state });
  const owner = { name: 'fixture-ha-execution-0', uid: 'worker-0', withdrawIssued: true };
  await probes.observeJournal({ phase: 'owners', owner, proxyContinuity: state });
  owner.beginIssued = true;
  await probes.observeJournal({ phase: 'owners', owner, proxyContinuity: state });
  state.mutations.normal = {};
  await probes.observeJournal({ phase: 'owners', proxyContinuity: state });
  state.phase = 'normal-serving';
  await probes.observeJournal({ phase: 'owners', proxyContinuity: state });
  state.phase = 'complete';
  state.routeRestored = true;
  await probes.observeJournal({ phase: 'complete', proxyContinuity: state });
  assert.deepEqual(stages, ['bootstrap', 'return-handoff']);
  assert.equal(probes.replacement.changed, true);
  assert.equal(probes.replacement.before.length, 4, 'First adoption observes the temporary HPA floor');
  assert.ok(probes.bootstrapHandoff.dispatchedAt && probes.bootstrapHandoff.settledAt);
  assert.ok(probes.returnHandoff.observedAt);
  assert.equal(probes.bridgeCleaned, true);
  assert.equal(probes.actionCompletion, undefined);
  assert.equal(probes.executionWithdrawal.podUid, 'worker-0');
  assert.ok(probes.executionWithdrawal.dispatchedAt && probes.executionWithdrawal.observedAt);
});

test('focused acceptance requires observed termination and fresh final proxy identities', async () => {
  const f = fixture();
  f.gate.operation.qualification = { tier: 'focused' };
  const probes = new ProviderRequestContinuity(f.gate);
  // Exercise acceptance after completed cohorts; their response facts are
  // validated separately by the provider-evidence regressions.
  for (const stage of continuityStages(false, 'upgrade', 'focused'))
    probes.cohorts.set(stage, { completion: Promise.resolve() });
  probes.bridgeCleaned = true;
  probes.replacement = {
    changed: true,
    deploymentUid: 'deployment',
    before: ['old1', 'old2'],
    after: ['cached1', 'cached2'],
    dispatchedAt: new Date().toISOString(),
  };
  f.gate.requestWorkflow = async () => ({ hasMore: false, totalRuns: 0, runs: [] });
  const health = f.gate.verifyProtectedProxyAvailability;
  f.gate.verifyProtectedProxyAvailability = async () => ({ ...(await health()), proxyUid: 'deployment' });
  f.gate.pods = async () => [pod('new1'), pod('new2')];
  await assert.rejects(probes.finish(), /termination was not observed/);
  probes.observeProxyPods([pod('old1', true), pod('old2'), pod('new1')]);
  f.gate.pods = async () => [pod('old1'), pod('new2')];
  await assert.rejects(probes.finish(), /original proxy still exists/);
  f.gate.pods = async () => [pod('final1'), pod('final2')];
  const receipt = await probes.finish();
  assert.deepEqual(receipt.replacement.after, ['final1', 'final2']);
});
test('unsafe native rollout policy fails before requests or mutation', async () => {
  const f = fixture();
  f.deployment.spec.strategy.rollingUpdate.maxUnavailable = 1;
  await assert.rejects(qualifyProtectedProxyRoll(f.gate, f.probes, { waitFor: f.waitFor }));
  assert.ok(!f.events.some((e) => e === 'patch' || e.startsWith('accepted:')));
});
test('runtime independence reuses one protected cold rollout and retains its timing receipt while developers are absent', async () => {
  const f = fixture(),
    nativePods = f.gate.pods,
    nativeKube = f.gate.kube;
  let absent = false,
    browserChecks = 0;
  f.gate.continuityProbes = f.probes;
  f.gate.purpose = 'ordinary-upgrade';
  f.gate.pods = async () => [
    ...(await nativePods()),
    ...(!absent
      ? [
          { metadata: { name: 'developer', uid: 'developer', labels: { 'app.kubernetes.io/component': 'backend' } } },
          { metadata: { name: 'web', uid: 'web', labels: { 'app.kubernetes.io/component': 'web' } } },
        ]
      : []),
  ];
  f.gate.requestWorkflow = async () => ({ id: randomUUID() });
  f.gate.scaleExact = async () => {
    absent = true;
  };
  f.gate.kube = async (args) => {
    if (args[0] === 'get' && ['services', 'endpointslice'].includes(args[1]))
      return { stdout: JSON.stringify({ items: [] }) };
    if (args[0] === 'exec')
      return {
        stdout: JSON.stringify(
          args[1] === 'developer'
            ? { incarnation: 'incarnation', state: 'drained' }
            : [{ status: 'succeeded', startedAt: Date.now(), recordingStatus: 'saved' }],
        ),
      };
    return nativeKube(args);
  };
  f.gate.verifyPublishedBrowser = async () => {
    assert.equal(absent, true);
    browserChecks++;
  };
  f.gate.values = () => ({});
  f.gate.apply = async () => {
    absent = false;
  };
  f.gate.waitForDeveloperRoute = async () => {};
  const result = await RuntimeControlLocalGate.prototype.isolateRuntime.call(
    f.gate,
    'https://fixture.invalid',
    'workflow',
  );
  assert.equal(result.coldProxyReplacement, true);
  assert.equal(browserChecks, 1);
  assert.equal(f.events.filter((e) => e === 'patch').length, 1, 'There must be only one cold-proxy template mutation');
  assert.ok(
    f.probes.replacement.dispatchedAt && f.probes.replacement.observedAt,
    'The shared scenario must not overwrite temporal evidence',
  );
});
test('HPA probe is admitted late in stabilization before removal and never relabels a survivor request', async () => {
  const start = Date.parse('2026-10-30T00:00:00.000Z'),
    calls = [];
  const probes = {
    cohorts: new Map(),
    startCohort: async (stage) => {
      calls.push(stage);
      probes.cohorts.set(stage, {});
    },
  };
  const observe = (offset, proxies) =>
    observeHpaContinuity(probes, {
      pressureStoppedAt: new Date(start).toISOString(),
      now: () => start + offset,
      proxies,
      readProxies: async () => proxies,
      hpaUid: 'hpa',
    });
  await observe(239000, [pod('one')]);
  assert.deepEqual(calls, []);
  await observe(240000, [pod('one')]);
  assert.deepEqual(calls, ['hpa-removal']);
  await observe(300000, [pod('one', true)]);
  assert.deepEqual(probes.removal.podUids, ['one']);
  const late = {
    cohorts: new Map(),
    startCohort: async () => {
      throw Error('Must not dispatch after deletion');
    },
  };
  await assert.rejects(
    observeHpaContinuity(late, {
      pressureStoppedAt: new Date(start).toISOString(),
      now: () => start + 300000,
      proxies: [pod('one', true)],
      hpaUid: 'hpa',
    }),
    /before protected requests/,
  );
  const raced = {
    cohorts: new Map(),
    startCohort: async () => {
      raced.cohorts.set('hpa-removal', {});
    },
  };
  await assert.rejects(
    observeHpaContinuity(raced, {
      pressureStoppedAt: new Date(start).toISOString(),
      now: () => start + 240000,
      proxies: [pod('one')],
      readProxies: async () => [pod('one', true)],
      hpaUid: 'hpa',
    }),
    /raced protected request/,
  );
});
test('fixture admissions are observed on execution owners and shared container markers count once', async () => {
  const id = randomUUID(),
    acceptedAt = new Date(Date.now() + 60000).toISOString();
  const gate = {
    operation: { installed: { qualificationValues: {} } },
    pods: async () => [
      {
        metadata: { uid: 'worker', name: 'worker', labels: { 'app.kubernetes.io/component': 'execution' } },
        spec: { containers: [{ name: 'backend' }, { name: 'api' }, { name: 'executor' }] },
      },
    ],
    kube: async () => ({ stdout: JSON.stringify([{ requestId: id, acceptedAt }]) }),
  };
  const probes = new ProviderRequestContinuity(gate);
  probes.cohorts.set('stage', { requests: [{ requestId: id }] });
  await probes.waitForAcceptance('stage');
  assert.equal(probes.cohorts.get('stage').requests[0].executionPodUid, 'worker');
  assert.ok(
    Date.parse(probes.cohorts.get('stage').requests[0].acceptedAt) <= Date.now(),
    'Admission boundaries use the observer clock, even when the execution node clock is ahead',
  );
  const original = gate.pods;
  gate.pods = async () => [
    ...(await original()),
    { ...(await original())[0], metadata: { ...(await original())[0].metadata, uid: 'duplicate' } },
  ];
  await assert.rejects(probes.waitForAcceptance('stage'), /Duplicate synchronous/);
});
test('published fixture enforces duration/input bounds and exclusive admission markers', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { etag: 'revision' } }));
  let uploaded;
  const gate = {
    operation: { installed: { qualificationValues: {} } },
    config: { baseUrl: 'https://fixture.invalid' },
    probeHeaders: {},
    assertProofContext: async () => {},
    pods: async () => [
      { metadata: { name: 'proxy', labels: { 'app.kubernetes.io/component': 'proxy' } } },
      { metadata: { name: 'proxy2', labels: { 'app.kubernetes.io/component': 'proxy' } } },
    ],
    kube: async () => ({ stdout: 'proxy_read_timeout 3600s;' }),
    requestWorkflow: async (_base, route, options) => {
      if (route.endsWith('/upload')) {
        uploaded = parse(JSON.parse(options.body).contents);
        return { project: { id: 'workflow', relativePath: 'fixture' } };
      }
      if (route.includes('web-apps?'))
        return { projectId: 'workflow', draftRevisionId: 'draft', publicationVersion: 0 };
      return {};
    },
  };
  const probes = new ProviderRequestContinuity(gate, { hpaOnly: true });
  await probes.prepare(
    await fs.readFile('deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project', 'utf8'),
  );
  const nodes = uploaded.data.graphs[uploaded.data.metadata.mainGraphId].nodes;
  const code = nodes['[admission]:code "Admission"'].data.code,
    markers = new Map();
  const execute = new Function('inputs', 'require', 'process', code);
  const mockRequire = () => ({
    writeFileSync: (path, value, options) => {
      assert.equal(options.flag, 'wx');
      if (markers.has(path)) throw Error('duplicate');
      markers.set(path, JSON.parse(value));
    },
  });
  for (const delayMs of [60000, 180000, 295000, 300000]) {
    const input = JSON.stringify({ requestId: randomUUID(), delayMs });
    const result = execute({ input: { value: input } }, mockRequire, { env: { HOSTNAME: 'worker' } });
    assert.equal(result.delay.value, delayMs);
    assert.equal(result.output.value, input);
    assert.throws(
      () => execute({ input: { value: input } }, mockRequire, { env: { HOSTNAME: 'worker' } }),
      /duplicate/,
    );
  }
  assert.throws(
    () =>
      execute({ input: { value: JSON.stringify({ requestId: randomUUID(), delayMs: 1 }) } }, mockRequire, {
        env: { HOSTNAME: 'worker' },
      }),
    /Invalid/,
  );
  assert.equal(markers.size, 4);
});
test('a pending cohort cannot create additional fixture demand or hide the previous failure', async () => {
  const probes = new ProviderRequestContinuity({ operation: { installed: { qualificationValues: {} } } });
  probes.prepared = true;
  let reject;
  probes.cohorts.set('first', {
    completion: new Promise((_, r) => {
      reject = r;
    }),
  });
  const next = probes.startCohort('next');
  await new Promise(setImmediate);
  assert.equal(probes.cohorts.has('next'), false, 'No second cohort is admitted while the first is pending');
  reject(Error('prior cohort failed'));
  await assert.rejects(next, /prior cohort failed/);
  assert.equal(probes.cohorts.has('next'), false);
});
