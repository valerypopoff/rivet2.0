import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runHaRollingUpgrade, assertHaRolloutPlan, assertHaRetirement } from './lib/ha-rolling-upgrade.mjs';
import {
  resolveHaWorkloadCapacity,
  hasSameHaOwnerIdentity,
  runHaKubernetesRollout,
  getHaConfigurationDigest,
  hasSameHaServiceRouting,
} from './lib/ha-kubernetes-rollout.mjs';
import { journalForReleaseOperation, releaseOperationJournalName } from './lib/release-operation-journal.mjs';

test('API-server field ordering does not resemble a Secret identity change', () => {
  const template = container => ({ spec: { containers: [{ name: 'backend', ...container }] } });
  const current = {
    env: [
      { name: 'RIVET_KEY', valueFrom: { secretKeyRef: { key: 'key', name: 'auth' } } },
      { name: 'PORT', value: '1234' },
    ],
  };
  const candidate = {
    env: [
      { name: 'PORT', value: '1234' },
      { name: 'RIVET_KEY', valueFrom: { secretKeyRef: { name: 'auth', key: 'key' } } },
    ],
  };
  assert.equal(hasSameHaOwnerIdentity(template(current), template(candidate)), true);
  candidate.env[1].valueFrom.secretKeyRef.name = 'other';
  assert.equal(hasSameHaOwnerIdentity(template(current), template(candidate)), false);
  assert.equal(hasSameHaOwnerIdentity(template(current), template({ env: [] })), false);
  assert.equal(hasSameHaOwnerIdentity({}, {}), false);
});

test('owner identity accepts API-omitted empty literal values without hiding missing or changed configuration', () => {
  const template = env => ({ spec: { containers: [{ name: 'backend', env }] } });
  const name = 'RIVET_DEPLOYMENT_STORAGE_ENDPOINT';
  // A real server-side dry-run omits value: "" from the returned EnvVar.
  const current = template([{ name }]);
  assert.equal(hasSameHaOwnerIdentity(current, template([{ name, value: '' }])), true);
  assert.equal(hasSameHaOwnerIdentity(template([{ name, value: '' }]), current), true);
  assert.equal(hasSameHaOwnerIdentity(current, template([])), false);
  assert.equal(hasSameHaOwnerIdentity(current, template([{ name, value: 'https://s3.example.test' }])), false);
  assert.equal(hasSameHaOwnerIdentity(current, template([
    { name, valueFrom: { secretKeyRef: { name: 'storage', key: 'endpoint' } } },
  ])), false);
});

test('owner identity includes Vault wiring, injected credentials and serving ports, but not ordinary tuning', () => {
  const current = {
    metadata: { annotations: { 'vault.hashicorp.com/role': 'rivet', 'vault.hashicorp.com/agent-inject-secret-dotenv': 'secret/rivet', 'vault.hashicorp.com/agent-requests-mem': '64Mi' } },
    spec: { containers: [{ name: 'backend', env: [{ name: 'PORT', value: '3001' }], envFrom: [{ secretRef: { name: 'rivet' } }] }] },
  };
  for (const change of [
    value => { value.metadata.annotations['vault.hashicorp.com/role'] = 'other'; },
    value => { value.metadata.annotations['vault.hashicorp.com/agent-inject-secret-dotenv'] = 'secret/other'; },
    value => { value.spec.containers[0].env[0].value = '3002'; },
    value => { value.spec.containers[0].envFrom[0].secretRef.name = 'other'; },
    value => { value.spec.serviceAccountName = 'other'; },
  ]) {
    const candidate = structuredClone(current); change(candidate);
    assert.equal(hasSameHaOwnerIdentity(current, candidate), false);
  }
  const tuning = structuredClone(current);
  tuning.metadata.annotations['vault.hashicorp.com/agent-requests-mem'] = '128Mi';
  tuning.metadata.annotations['rivet.dev/ha-proof-generation'] = 'candidate';
  tuning.spec.serviceAccountName = 'default';
  assert.equal(hasSameHaOwnerIdentity(current, tuning), true);
});

test('HA Service routing normalizes API defaults but rejects mixed-version route changes', () => {
  const current = { spec: { clusterIP: '10.0.0.1', type: 'ClusterIP', selector: { component: 'api' }, ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 80 }] } };
  const candidate = { spec: { selector: { component: 'api' }, ports: [{ name: 'http', port: 80 }] } };
  assert.equal(hasSameHaServiceRouting(current, candidate), true);
  for (const change of [
    value => { value.spec.ports[0].port = 81; },
    value => { value.spec.ports[0].targetPort = 3002; },
    value => { value.spec.selector.component = 'other'; },
    value => { value.spec.clusterIP = 'None'; },
    value => { value.spec.publishNotReadyAddresses = true; },
  ]) {
    const changed = structuredClone(candidate); change(changed);
    assert.equal(hasSameHaServiceRouting(current, changed), false);
  }
});

function fixture() {
  let journal,
    revision = 0,
    time = 0;
  const operations = [],
    pods = new Map();
  const workloads = [
    {
      name: 'fixture-backend',
      role: 'backend',
      replicas: 2,
      updateStrategy: 'OnDelete',
      image: `api@sha256:${'b'.repeat(64)}`,
    },
  ];
  const create = (name, image) =>
    pods.set(name, {
      name,
      uid: randomUUID(),
      image,
      ready: true,
      incarnation: randomUUID(),
      state: 'serving',
      operationId: null,
    });
  for (let i = 0; i < 2; i++) create(`fixture-backend-${i}`, `api@sha256:${'a'.repeat(64)}`);
  const options = {
    identity: { release: 'fixture', namespace: 'fixture', manifestDigest: 'candidate' },
    workloads,
    now: () => time,
    wait: async () => {
      time += 100;
    },
    timeoutMs: 500,
    setHeartbeat: () => 0,
    clearHeartbeat: () => {},
    readJournal: async () => journal && structuredClone(journal),
    saveJournal: async (next, rv) => {
      assert.equal(rv, journal?.resourceVersion);
      return (journal = structuredClone({ ...next, resourceVersion: String(++revision) }));
    },
    snapshotCapacity: async () => operations.push('capacity'),
    observePod: async (name) => structuredClone(pods.get(name)),
    status: async (pod) => ({ protocol: 1, withdrawalProtocol: 1, ...pods.get(pod.name) }),
    withdraw: async (pod, op) => {
      assert.equal(journal.owner.withdrawIssued, true);
      Object.assign(pods.get(pod.name), { state: 'withdrawing', operationId: op, ready: false });
      operations.push(`withdraw-command:${pod.name}`);
    },
    waitForRoutingWithdrawal: async (pod) => {
      assert.equal(pods.get(pod.name).ready, false);
      assert.ok(['withdrawing', 'draining', 'drained'].includes(pods.get(pod.name).state));
      operations.push(`routing-withdrawn:${pod.name}`);
    },
    begin: async (pod, op, inc) => {
      const current = pods.get(pod.name);
      assert.equal(current.incarnation, inc);
      assert.equal(current.uid, pod.uid);
      assert.equal(journal.owner.beginIssued, true);
      current.state = 'drained';
      current.operationId = op;
      current.ready = false;
      operations.push(`begin:${pod.name}`);
    },
    removePod: async (pod) => {
      const current = pods.get(pod.name);
      assert.equal(current.uid, pod.uid);
      assert.equal(current.state, 'drained');
      assert.ok([...pods.values()].filter((p) => p.ready).length >= 2);
      operations.push(`delete:${pod.name}`);
      create(pod.name, workloads[0].image);
    },
    scale: async (name, count) => {
      if (count === 3) {
        if (!pods.has(`${name}-2`)) create(`${name}-2`, workloads[0].image);
      } else {
        assert.equal(pods.get(`${name}-2`).state, 'drained');
        pods.delete(`${name}-2`);
      }
      operations.push(`scale:${count}`);
    },
    waitForScaleDown: async (workload, owner) => {
      assert.equal(owner.name, `${workload.name}-2`);
      assert.equal(owner.scaleDownIssued, true);
      assert.equal(pods.has(owner.name), false);
      operations.push('surge-removed');
    },
    applyTemplates: async () => operations.push('templates'),
    restoreAutoscalers: async () => operations.push('autoscalers'),
    waitForReady: async (name, image) => {
      assert.equal(pods.get(name)?.image, image);
      assert.equal(pods.get(name)?.ready, true);
    },
    waitForWithdrawal: async (pod) => {
      assert.equal(pods.get(pod.name).ready, false);
      operations.push(`withdraw:${pod.name}`);
    },
  };
  return {
    options,
    operations,
    pods,
    get journal() {
      return journal;
    },
    advance(ms) {
      time += ms;
    },
  };
}
test('maintenance and HA use one CAS journal and cannot take an unfinished or leased foreign operation', () => {
  const identity = { release: 'fixture', namespace: 'fixture' };
  const ownership = { token: randomUUID(), runner: randomUUID(), manifestDigest: 'candidate' };
  const ha = { ...identity, ...ownership, protocol: 1, phase: 'owners', resourceVersion: '7', leaseExpiresAt: 1 };
  const cutover = {
    ...identity,
    ...ownership,
    formatVersion: 1,
    phase: 'quiescing',
    resourceVersion: '8',
    leaseExpiresAt: 1,
  };
  assert.match(releaseOperationJournalName('fixture'), /-cutover$/);
  assert.throws(() => journalForReleaseOperation(ha, 'cutover', identity, () => 100), /owns this release/);
  assert.throws(() => journalForReleaseOperation(cutover, 'ha', identity, () => 100), /owns this release/);
  assert.throws(
    () => journalForReleaseOperation({ ...ha, phase: 'complete', leaseExpiresAt: 200 }, 'cutover', identity, () => 100),
    /owns this release/,
  );
  assert.equal(
    journalForReleaseOperation({ ...ha, phase: 'complete' }, 'cutover', identity, () => 100),
    null,
  );
  assert.throws(
    () =>
      journalForReleaseOperation(
        { ...ha, phase: 'complete', manifestDigest: undefined },
        'cutover',
        identity,
        () => 100,
      ),
    /unconfirmed/,
  );
  assert.equal(
    journalForReleaseOperation(ha, 'ha', identity, () => 100),
    ha,
  );
});

test('recovery retains original capacity when the recorded rollout has already created a surge', () => {
  const candidate = { metadata: { name: 'fixture-backend' } };
  const existing = { spec: { replicas: 3 } };
  const journal = {
    token: 'owned-token',
    phase: 'owners',
    workloads: [{ name: 'fixture-backend', role: 'backend', replicas: 2 }],
  };
  assert.equal(resolveHaWorkloadCapacity(candidate, existing, journal, 'owned-token'), 2);
  assert.throws(() => resolveHaWorkloadCapacity(candidate, existing, journal, 'wrong'), /token changed/);
  assert.throws(
    () => resolveHaWorkloadCapacity(candidate, { spec: { replicas: 4 } }, journal, 'owned-token'),
    /capacity/,
  );
  assert.equal(resolveHaWorkloadCapacity(candidate, existing, null), 3);
});

test('configuration identity ignores map ordering but binds pod settings, routes and autoscalers', () => {
  const resources = [
    { kind: 'StatefulSet', metadata: { name: 'backend' }, spec: { template: { spec: { containers: [{ image: 'same-image', resources: { limits: { memory: '1Gi' } } }] } } } },
    { kind: 'Service', metadata: { name: 'api' }, spec: { ports: [{ port: 80 }] } },
    { kind: 'HorizontalPodAutoscaler', metadata: { name: 'execution' }, spec: { maxReplicas: 4 } },
  ];
  const digest = getHaConfigurationDigest(resources);
  const reordered = resources.toReversed().map(resource => ({ spec: resource.spec, metadata: resource.metadata, kind: resource.kind }));
  assert.equal(getHaConfigurationDigest(reordered), digest);
  for (const change of [
    value => { value[0].spec.template.spec.containers[0].resources.limits.memory = '2Gi'; },
    value => { value[1].spec.ports[0].port = 81; },
    value => { value[2].spec.maxReplicas = 5; },
  ]) {
    const changed = structuredClone(resources); change(changed);
    assert.notEqual(getHaConfigurationDigest(changed), digest);
  }
});

test('recovery cannot apply different values at autoscaler restoration after retiring an identical image', async () => {
  const f = fixture(), begin = f.options.begin;
  f.options.identity.configurationDigest = 'original-values';
  f.options.begin = async (...args) => { await begin(...args); throw Error('lost acknowledgement'); };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost acknowledgement/);
  f.options.begin = begin;
  const before = [...f.operations];
  await assert.rejects(runHaRollingUpgrade({ ...f.options,
    resumeToken: f.journal.token, identity: { ...f.options.identity, configurationDigest: 'different-values' },
  }), /recovery configuration changed/);
  assert.deepEqual(f.operations, before);
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.journal.phase, 'complete');
});

test('unknown initial ownership acknowledgement exposes its recovery token without touching workloads', async () => {
  const f = fixture();
  f.options.saveJournal = async () => {
    throw new Error('lost response');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /ownership write is unconfirmed.*journal token [a-f0-9-]+/);
  assert.ok(!f.operations.includes('templates'));
  assert.ok(!f.operations.some((o) => o.startsWith('begin:')));
});

test('HA replaces each exact drained UID while two ready owners serve, including accepted surge work', async () => {
  const f = fixture();
  const result = await runHaRollingUpgrade(f.options);
  assert.equal(result.phase, 'complete');
  assert.equal(f.pods.size, 2);
  assert.deepEqual(
    f.operations.filter((x) => x.startsWith('begin')),
    ['begin:fixture-backend-0', 'begin:fixture-backend-1', 'begin:fixture-backend-2'],
  );
  for (const name of ['fixture-backend-0', 'fixture-backend-1'])
    assert.ok(f.operations.indexOf(`withdraw:${name}`) < f.operations.indexOf(`delete:${name}`));
  for (const name of ['fixture-backend-0', 'fixture-backend-1', 'fixture-backend-2'])
    assert.ok(f.operations.indexOf(`routing-withdrawn:${name}`) < f.operations.indexOf(`begin:${name}`));
});

test('routing withdrawal failure leaves admission unfenced and never deletes an owner', async () => {
  const f = fixture();
  f.options.waitForRoutingWithdrawal = async () => {
    throw Error('endpoints still ready');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /endpoints still ready/);
  assert.equal(f.journal.owner.withdrawIssued, true);
  assert.equal(f.journal.owner.beginIssued, false);
  assert.equal(f.pods.get('fixture-backend-0').state, 'withdrawing');
  assert.ok(!f.operations.some((o) => o.startsWith('begin:') || o.startsWith('delete:')));
});

test('a lost withdrawal acknowledgement is observed on recovery without repeating the command', async () => {
  const f = fixture(),
    send = f.options.withdraw;
  f.options.withdraw = async (...args) => {
    await send(...args);
    throw Error('lost withdrawal acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost withdrawal/);
  const token = f.journal.token;
  f.options.withdraw = send;
  await runHaRollingUpgrade({ ...f.options, resumeToken: token });
  assert.equal(f.operations.filter((o) => o === 'withdraw-command:fixture-backend-0').length, 1);
});

test('failed fixture preparation cannot record a command that was never attempted', async () => {
  const f = fixture();
  f.options.prepareRetirement = async () => {
    throw Error('probe setup failed');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /probe setup failed/);
  assert.equal(f.journal.owner.beginIssued, false);
  assert.ok(!f.operations.some((o) => o.startsWith('begin:') || o.startsWith('delete:')));
  delete f.options.prepareRetirement;
  const result = await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(result.phase, 'complete');
});
test('missing protocol, readiness or spare capacity stops before templates, commands and journal ownership', async () => {
  for (const mode of ['protocol', 'withdrawal-protocol', 'readiness', 'capacity']) {
    const f = fixture();
    if (mode === 'protocol') f.options.status = async () => ({ protocol: 0 });
    if (mode === 'withdrawal-protocol') {
      const status = f.options.status;
      f.options.status = async (pod) => ({ ...(await status(pod)), withdrawalProtocol: undefined });
    }
    if (mode === 'readiness') f.pods.get('fixture-backend-1').ready = false;
    if (mode === 'capacity')
      f.options.snapshotCapacity = async () => {
        throw Error('capacity');
      };
    await assert.rejects(runHaRollingUpgrade(f.options));
    assert.equal(f.journal, undefined);
    assert.ok(!f.operations.includes('templates'));
  }
});

test('a same-image template change still retires stale-revision owners', async () => {
  const f = fixture();
  const originalUids = new Set([...f.pods.values()].map((p) => p.uid));
  for (const pod of f.pods.values()) pod.image = f.options.workloads[0].image;
  f.options.isCurrentPod = (pod, workload) => pod.image === workload.image && !originalUids.has(pod.uid);
  await runHaRollingUpgrade(f.options);
  assert.deepEqual(
    f.operations.filter((o) => o.startsWith('begin:')),
    ['begin:fixture-backend-0', 'begin:fixture-backend-1', 'begin:fixture-backend-2'],
  );
});
test('a long accepted run times out without deleting, scaling down, replaying or rolling back', async () => {
  const f = fixture();
  f.options.begin = async (pod, op) => {
    Object.assign(f.pods.get(pod.name), { state: 'draining', operationId: op });
    f.operations.push('begin');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /still active/);
  assert.equal(f.pods.size, 3);
  assert.equal(f.operations.filter((x) => x === 'begin').length, 1);
  assert.ok(!f.operations.some((x) => x.startsWith('delete') || x === 'scale:2'));
});
test('a lost begin acknowledgement is observed on explicit recovery and never sent twice', async () => {
  const f = fixture(),
    begin = f.options.begin;
  f.options.begin = async (...args) => {
    await begin(...args);
    throw Error('lost begin acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost begin/);
  f.options.resumeToken = f.journal.token;
  f.options.begin = begin;
  await runHaRollingUpgrade(f.options);
  assert.equal(f.operations.filter((x) => x === 'begin:fixture-backend-0').length, 1);
});

test('lost surge scale-down acknowledgement is observed without recreating or commanding another owner', async () => {
  const f = fixture(),
    scale = f.options.scale;
  f.options.scale = async (...args) => {
    await scale(...args);
    if (args[1] === 2) throw Error('lost scale acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost scale acknowledgement/);
  assert.equal(f.journal.owner.scaleDownIssued, true);
  assert.equal(f.pods.size, 2);
  assert.ok(!f.operations.includes('autoscalers'));
  f.options.scale = scale;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:3').length, 1);
  assert.equal(f.operations.filter((o) => o === 'scale:2').length, 1);
  assert.equal(f.operations.filter((o) => o === 'begin:fixture-backend-2').length, 1);
  assert.ok(f.operations.indexOf('surge-removed') < f.operations.indexOf('autoscalers'));
});

test('surge drain recovery retains its UID and observes a lost begin instead of replaying it', async () => {
  const f = fixture(),
    begin = f.options.begin;
  f.options.begin = async (...args) => {
    await begin(...args);
    if (args[0].name.endsWith('-2')) throw Error('lost surge begin');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost surge begin/);
  f.options.begin = begin;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:3').length, 1);
  assert.equal(f.operations.filter((o) => o === 'begin:fixture-backend-2').length, 1);
});

test('pending surge deletion blocks completion and autoscaler restoration without replaying scale-down', async () => {
  const f = fixture(),
    waitForScaleDown = f.options.waitForScaleDown;
  f.options.waitForScaleDown = async () => {
    throw Error('deletion still pending');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /deletion still pending/);
  assert.equal(f.journal.phase, 'owners');
  assert.ok(!f.operations.includes('autoscalers'));
  f.options.waitForScaleDown = waitForScaleDown;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:2').length, 1);
});

test('historically completed owners are rechecked before autoscaler restoration, including recovery', async () => {
  for (const fault of ['image', 'readiness', 'retirement']) {
    const f = fixture();
    const waitForScaleDown = f.options.waitForScaleDown;
    f.options.waitForScaleDown = async (...args) => {
      await waitForScaleDown(...args);
      const pod = f.pods.get('fixture-backend-0');
      if (fault === 'image') pod.image = `api@sha256:${'c'.repeat(64)}`;
      if (fault === 'readiness') pod.ready = false;
      if (fault === 'retirement') { pod.state = 'withdrawing'; pod.operationId = randomUUID(); }
    };
    await assert.rejects(runHaRollingUpgrade(f.options), /completion is blocked/);
    assert.deepEqual(f.journal.completed, ['fixture-backend']);
    assert.ok(!f.operations.includes('autoscalers'));
    const before = [...f.operations];
    await assert.rejects(runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token }), /completion is blocked/);
    assert.deepEqual(f.operations, before, 'completed owners must be checked without repeating retirement');
  }
});

test('an acknowledged final Helm update is not completion proof if it changed the running template', async () => {
  const f = fixture();
  f.options.restoreAutoscalers = async () => {
    f.operations.push('autoscalers');
    f.pods.get('fixture-backend-0').image = `api@sha256:${'c'.repeat(64)}`;
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /completion is blocked/);
  assert.equal(f.journal.phase, 'owners');
  assert.deepEqual(f.journal.completed, ['fixture-backend']);
});
test('lease loss and stale incarnation stop deletion; unknown template outcomes never replay migrations', async () => {
  for (const mode of ['lease', 'incarnation', 'template']) {
    const f = fixture(),
      begin = f.options.begin;
    if (mode === 'template')
      f.options.applyTemplates = async () => {
        throw Error('template unknown');
      };
    else
      f.options.begin = async (...args) => {
        await begin(...args);
        if (mode === 'lease') f.advance(130_000);
        else f.pods.get(args[0].name).incarnation = randomUUID();
      };
    await assert.rejects(runHaRollingUpgrade(f.options));
    assert.ok(!f.operations.some((x) => x.startsWith('delete')));
    if (mode === 'template') {
      f.options.resumeToken = f.journal.token;
      await assert.rejects(runHaRollingUpgrade(f.options), /template acknowledgement is unknown/);
    }
  }
});
test('HA rejects unbounded plans, automatic replacement and malformed ownership', () => {
  assert.throws(() => assertHaRolloutPlan([{ name: 'x', role: 'backend', replicas: 1 }]));
  assert.throws(() => assertHaRetirement({ protocol: 1, incarnation: '-'.repeat(36), state: 'drained' }));
});

for (const fault of [
  'none',
  'lost-acknowledgement',
  'changed-capacity',
  'changed-uid',
  'missing-readiness',
  'null-readiness',
  'template-capacity-race',
  'template-resource-version-race',
  'recreated-statefulset',
  'scale-resource-version-race',
  'service-routing-change',
  'recreated-statefulset-recovery',
  'missing-final-revision',
])
  test(`Kubernetes surge removal is capacity/UID guarded and recoverable: ${fault}`, async () => {
    const f = fixture(),
      calls = [];
    const name = f.options.workloads[0].name;
    const candidate = {
      kind: 'StatefulSet',
      metadata: { name, labels: { 'app.kubernetes.io/component': 'backend' } },
      spec: {
        replicas: 2,
        updateStrategy: { type: 'OnDelete' },
        template: {
          spec: {
            containers: [
              { name: 'backend', image: f.options.workloads[0].image, env: [{ name: 'RIVET_KEY', value: 'fixture' }] },
            ],
          },
        },
      },
    };
    const current = structuredClone(candidate);
    current.metadata.generation = 1;
    current.metadata.uid = randomUUID();
    current.metadata.resourceVersion = 'observed-version';
    current.status = { readyReplicas: 2, observedGeneration: 1, updateRevision: 'candidate' };
    let cm,
      revision = 0,
      pendingRemoval = false,
      restored = false;
    const kube = async (args, extra) => {
      calls.push(args);
      const result = (value) => ({ stdout: value == null ? '' : JSON.stringify(value) });
      if (args[0] === 'get' && args[1] === 'configmap') return result(cm);
      if (['create', 'replace'].includes(args[0])) {
        const next = JSON.parse(extra.input);
        assert.equal(next.metadata.resourceVersion, cm?.metadata.resourceVersion);
        cm = { ...next, metadata: { ...next.metadata, resourceVersion: String(++revision) } };
        return result(cm);
      }
      if (args[0] === 'get' && args[1] === 'statefulset') {
        if (fault === 'missing-final-revision' && cm && JSON.parse(cm.data.record).completed.includes(name))
          current.status.updateRevision = undefined;
        if (fault === 'recreated-statefulset' && cm) current.metadata.uid = randomUUID();
        if (fault === 'template-capacity-race' && cm && JSON.parse(cm.data.record).phase === 'templates')
          current.spec.replicas = 3;
        if (cm && JSON.parse(cm.data.record).owner?.scaleDownIssued) {
          if (fault === 'changed-capacity') current.spec.replicas = 4;
          if (fault === 'changed-uid') f.pods.get(`${name}-2`).uid = 'unexpected-replacement';
        }
        return result(args.includes('-l') ? { items: [current] } : current);
      }
      if (args[0] === 'get' && args[1] === 'service')
        return result({ items: [{ kind: 'Service', metadata: { name: 'public' }, spec: fault === 'service-routing-change' ? { ports: [{ port: 81 }] } : {} }] });
      if (args[0] === 'get' && args[1] === 'endpointslice')
        return result({
          items: [
            {
              metadata: { labels: { 'kubernetes.io/service-name': 'public' } },
              endpoints: [...f.pods.values()].map((pod) => ({
                targetRef: { uid: pod.uid },
                ...(fault === 'missing-readiness'
                  ? {}
                  : { conditions: { ready: fault === 'null-readiness' ? null : pod.ready } }),
              })),
            },
          ],
        });
      if (args[0] === 'get' && args[1] === 'pod') {
        const pod = f.pods.get(args[2]);
        if (!pod) return result(null);
        const value = {
          metadata: {
            name: pod.name,
            uid: pod.uid,
            labels: { 'app.kubernetes.io/instance': 'fixture', 'controller-revision-hash': 'candidate' },
          },
          spec: { containers: [{ name: 'backend', image: pod.image }] },
          status: { conditions: [{ type: 'Ready', status: pod.ready ? 'True' : 'False' }] },
        };
        if (fault === 'missing-final-revision' && cm && JSON.parse(cm.data.record).completed.includes(name))
          value.metadata.labels['controller-revision-hash'] = undefined;
        if (pendingRemoval && args[2] === `${name}-2`) {
          // The first read still sees the terminating pod after spec.replicas changed.
          f.pods.delete(args[2]);
          pendingRemoval = false;
        }
        return result(value);
      }
      if (args[0] === 'exec') {
        const pod = f.pods.get(args[1]);
        if (args.includes('--withdraw-only'))
          Object.assign(pod, { state: 'withdrawing', operationId: args[7], ready: false });
        if (args.includes('--begin-only')) Object.assign(pod, { state: 'drained', operationId: args[7], ready: false });
        return result({ protocol: 1, withdrawalProtocol: 1, ...pod });
      }
      if (args[0] === 'delete') {
        const podName = args[2].split('/').at(-1);
        assert.equal(JSON.parse(extra.input).preconditions.uid, f.pods.get(podName).uid);
        await f.options.removePod(f.pods.get(podName));
        return result({});
      }
      if (args[0] === 'scale') {
        assert.ok(args.includes(`--current-replicas=${current.spec.replicas}`));
        assert.ok(args.includes(`--resource-version=${current.metadata.resourceVersion}`));
        if (fault === 'scale-resource-version-race') throw Error('Kubernetes scale resourceVersion conflict');
        const replicas = Number(args.find((a) => a.startsWith('--replicas=')).split('=')[1]);
        current.spec.replicas = replicas;
        if (replicas === 3) await f.options.scale(name, replicas);
        else {
          pendingRemoval = true;
          if (['lost-acknowledgement', 'recreated-statefulset-recovery'].includes(fault)) throw Error('lost scale acknowledgement');
        }
        return result({});
      }
      throw Error(`Unexpected Kubernetes command: ${args}`);
    };
    const options = {
      kube,
      release: 'fixture',
      namespace: 'fixture',
      manifestDigest: 'candidate',
      resources: [candidate, { kind: 'Service', metadata: { name: 'public' }, spec: {} }],
      timeoutMs: 1000,
      applyTemplates: async (_workloads, guardedValues) => {
        assert.deepEqual(guardedValues, { replicaCount: { backend: 2 }, ha: { rolloutResourceVersions: { [name]: 'observed-version' } } });
        if (fault === 'template-resource-version-race') throw Error('Helm resourceVersion conflict');
      },
      restoreAutoscalers: async (_workloads, guardedValues) => {
        assert.equal(guardedValues.ha.rolloutResourceVersions[name], current.metadata.resourceVersion);
        assert.equal(pendingRemoval, false);
        assert.equal(f.pods.has(`${name}-2`), false);
        assert.equal(current.spec.replicas, 2);
        restored = true;
      },
    };
    if (fault === 'missing-final-revision') {
      await assert.rejects(runHaKubernetesRollout(options), /completion is blocked/);
      assert.equal(restored, false);
      assert.equal(JSON.parse(cm.data.record).phase, 'owners');
      return;
    }
    if (['recreated-statefulset', 'scale-resource-version-race', 'service-routing-change'].includes(fault)) {
      await assert.rejects(runHaKubernetesRollout(options), /StatefulSet identity changed|scale resourceVersion conflict|Service routing changed/);
      assert.equal(calls.filter(a => a.includes('--withdraw-only') || a.includes('--begin-only') || a[0] === 'delete').length, 0);
      assert.equal(restored, false);
      if (fault === 'service-routing-change') assert.equal(cm, undefined);
      return;
    }
    if (fault.startsWith('template-')) {
      await assert.rejects(runHaKubernetesRollout(options), /capacity changed before template update|resourceVersion conflict/);
      assert.equal(calls.filter(a => a.includes('--withdraw-only') || a.includes('--begin-only') || a[0] === 'delete' || a[0] === 'scale').length, 0);
      assert.equal(restored, false);
      return;
    }
    if (fault === 'missing-readiness' || fault === 'null-readiness') {
      await assert.rejects(runHaKubernetesRollout(options), /endpoint withdrawal/);
      assert.equal(calls.filter((a) => a.includes('--begin-only')).length, 0);
      assert.equal(calls.filter((a) => a[0] === 'delete').length, 0);
      assert.equal(restored, false);
      return;
    }
    if (fault === 'changed-capacity' || fault === 'changed-uid') {
      await assert.rejects(runHaKubernetesRollout(options), /capacity changed|identity changed/);
      assert.equal(calls.filter((a) => a[0] === 'scale').length, 1);
      assert.equal(restored, false);
      assert.equal(f.pods.has(`${name}-2`), true);
      return;
    }
    if (fault === 'recreated-statefulset-recovery') {
      await assert.rejects(runHaKubernetesRollout(options), /lost scale acknowledgement/);
      current.metadata.uid = randomUUID();
      const before = calls.length;
      await assert.rejects(runHaKubernetesRollout({ ...options, resumeToken: JSON.parse(cm.data.record).token }), /recovery inventory changed/);
      assert.equal(calls.slice(before).filter(a => ['create', 'replace', 'scale', 'delete', 'exec'].includes(a[0])).length, 0);
      assert.equal(restored, false);
      return;
    }
    if (fault === 'lost-acknowledgement') {
      await assert.rejects(runHaKubernetesRollout(options), /lost scale acknowledgement/);
      assert.equal(restored, false);
      await runHaKubernetesRollout({ ...options, resumeToken: JSON.parse(cm.data.record).token });
    } else await runHaKubernetesRollout(options);
    assert.equal(restored, true);
    assert.equal(calls.filter((a) => a[0] === 'scale').length, 2);
  });
