import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  reconcileExecutionAutoscaling,
  autoscalerPolicy,
  autoscalerPolicyDigest,
} from './lib/execution-autoscaler.mjs';
import {
  runHaRollingUpgrade as runRollingStrategy,
  assertHaRolloutPlan,
  assertHaRetirement,
} from './lib/ha-rolling-upgrade.mjs';
import { fixtureDeploymentSafety } from './fixtures/deployment-safety.mjs';
const runHaRollingUpgrade = (options) =>
  runRollingStrategy({
    ...options,
    safety:
      options.safety ??
      fixtureDeploymentSafety('rolling', options.identity, { baseline: options.assertInstalledBaseline }),
  });

import {
  resolveHaWorkloadCapacity,
  hasSameHaOwnerIdentity,
  runHaKubernetesRollout as runKubernetesRollingStrategy,
  getHaConfigurationDigest,
  hasSameHaServiceRouting,
  captureHaFrontendCapacity,
} from './lib/ha-kubernetes-rollout.mjs';
const runHaKubernetesRollout = (options) =>
  runKubernetesRollingStrategy({
    // This suite isolates retirement plumbing. Real preparation runs in its
    // HTTP suite and in the actual deployment-command stand-in tests.
    prepareReplacements: async () => {},
    ...options,
    safety:
      options.safety ?? fixtureDeploymentSafety('rolling', options, { baseline: options.assertInstalledBaseline }),
  });

test('preparation finishes before templates or any old owner retirement, and unresolved cleanup keeps recovery ownership', async () => {
  for (const fault of [false, true]) {
    const f = fixture();
    f.options.prepareReplacements = async (operation) => {
      f.operations.push('prepare');
      await operation.checkpoint({ preparation: { state: fault ? 'preparing' : 'complete' } });
      if (fault) throw Error('preparation cleanup unknown');
    };
    if (fault) {
      await assert.rejects(runHaRollingUpgrade(f.options), /preparation cleanup unknown/);
      assert.equal(f.journal.phase, 'preflight');
      assert.ok(!f.operations.includes('templates'));
      assert.ok(!f.operations.some((v) => v.startsWith('withdraw-command:')));
    } else {
      await runHaRollingUpgrade(f.options);
      assert.ok(f.operations.indexOf('prepare') < f.operations.indexOf('templates'));
    }
  }
});

test('HA template updates preserve HPA-grown frontend capacity with UID and resourceVersion fencing', async () => {
  const live = {
    metadata: {
      uid: 'proxy-uid',
      resourceVersion: '7',
      labels: {
        'app.kubernetes.io/instance': 'rivet',
        'app.kubernetes.io/component': 'proxy',
      },
    },
    spec: { replicas: 4 },
  };
  const resources = [
    {
      kind: 'Deployment',
      metadata: { name: 'proxy', labels: { 'app.kubernetes.io/component': 'proxy' } },
      spec: { replicas: 2 },
    },
    { kind: 'HorizontalPodAutoscaler', spec: { scaleTargetRef: { kind: 'Deployment', name: 'proxy' } } },
  ];
  const kube = async (args) => {
    assert.deepEqual(args, ['get', 'deployment', 'proxy', '-o', 'json']);
    return { stdout: JSON.stringify(live) };
  };
  const guard = await captureHaFrontendCapacity(kube, resources, 'rivet');
  assert.deepEqual(await guard(), { replicas: { proxy: 4 }, versions: { proxy: '7' } });
  live.spec.replicas = 3;
  live.metadata.resourceVersion = '8';
  assert.deepEqual(await guard(), { replicas: { proxy: 3 }, versions: { proxy: '8' } });
  live.metadata.uid = 'replacement';
  await assert.rejects(guard(), /frontend identity/);
  await assert.rejects(captureHaFrontendCapacity(kube, resources, 'foreign'), /identity is unconfirmed/);
  const unused = await captureHaFrontendCapacity(
    () => {
      throw new Error('No autoscaled frontend to inspect');
    },
    resources.slice(0, 1),
    'rivet',
  );
  assert.deepEqual(await unused(), { replicas: {}, versions: {} });
});

test('singleton rollout rejects absent or malformed inventory through its validation boundary', () => {
  for (const inventory of [undefined, null, {}, [], [null, { role: 'backend' }]])
    assert.throws(() => assertHaRolloutPlan(inventory, 'singleton'), /Missing HA backends/);
});

test('HA accepts the full supported execution-autoscaling range without relaxing other owner bounds', () => {
  const image = `api@sha256:${'a'.repeat(64)}`;
  const backend = { name: 'backend', role: 'backend', replicas: 1, image, updateStrategy: 'OnDelete' };
  const execution = { name: 'execution', role: 'execution', replicas: 2, image, updateStrategy: 'OnDelete' };
  const policy = autoscalerPolicy({ maxReplicas: 100 });
  for (const replicas of [32, 33, policy.maxReplicas])
    assert.doesNotThrow(() => assertHaRolloutPlan([backend, { ...execution, replicas }], 'singleton'));
  assert.throws(
    () => assertHaRolloutPlan([backend, { ...execution, replicas: policy.maxReplicas + 1 }], 'singleton'),
    /bounded OnDelete/,
  );
  assert.throws(() => assertHaRolloutPlan([{ ...backend, replicas: 33 }, execution]), /bounded OnDelete/);
});
import { journalForReleaseOperation, releaseOperationJournalName } from './lib/release-operation-journal.mjs';

test('API-server field ordering does not resemble a Secret identity change', () => {
  const template = (container) => ({ spec: { containers: [{ name: 'backend', ...container }] } });
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
  const template = (env) => ({ spec: { containers: [{ name: 'backend', env }] } });
  const name = 'RIVET_DEPLOYMENT_STORAGE_ENDPOINT';
  // A real server-side dry-run omits value: "" from the returned EnvVar.
  const current = template([{ name }]);
  assert.equal(hasSameHaOwnerIdentity(current, template([{ name, value: '' }])), true);
  assert.equal(hasSameHaOwnerIdentity(template([{ name, value: '' }]), current), true);
  assert.equal(hasSameHaOwnerIdentity(current, template([])), false);
  assert.equal(hasSameHaOwnerIdentity(current, template([{ name, value: 'https://s3.example.test' }])), false);
  assert.equal(
    hasSameHaOwnerIdentity(
      current,
      template([{ name, valueFrom: { secretKeyRef: { name: 'storage', key: 'endpoint' } } }]),
    ),
    false,
  );
});

test('bridge mode normalizes only an absent replicated literal, never secret-derived owner policy', () => {
  const template = (env) => ({ spec: { containers: [{ name: 'backend', env }] } });
  assert.equal(
    hasSameHaOwnerIdentity(template([]), template([{ name: 'RIVET_HA_CONTROL_PLANE_MODE', value: 'replicated' }])),
    true,
  );
  assert.equal(
    hasSameHaOwnerIdentity(template([]), template([{ name: 'RIVET_HA_CONTROL_PLANE_MODE', value: 'singleton' }])),
    false,
  );
  assert.equal(
    hasSameHaOwnerIdentity(
      template([]),
      template([
        { name: 'RIVET_HA_CONTROL_PLANE_MODE', valueFrom: { secretKeyRef: { name: 'foreign', key: 'mode' } } },
      ]),
    ),
    false,
  );
});

test('owner identity includes Vault wiring, injected credentials and serving ports, but not ordinary tuning', () => {
  const current = {
    metadata: {
      annotations: {
        'vault.hashicorp.com/role': 'rivet',
        'vault.hashicorp.com/agent-inject-secret-dotenv': 'secret/rivet',
        'vault.hashicorp.com/agent-requests-mem': '64Mi',
      },
    },
    spec: {
      containers: [
        { name: 'backend', env: [{ name: 'PORT', value: '3001' }], envFrom: [{ secretRef: { name: 'rivet' } }] },
      ],
    },
  };
  for (const change of [
    (value) => {
      value.metadata.annotations['vault.hashicorp.com/role'] = 'other';
    },
    (value) => {
      value.metadata.annotations['vault.hashicorp.com/agent-inject-secret-dotenv'] = 'secret/other';
    },
    (value) => {
      value.spec.containers[0].env[0].value = '3002';
    },
    (value) => {
      value.spec.containers[0].envFrom[0].secretRef.name = 'other';
    },
    (value) => {
      value.spec.serviceAccountName = 'other';
    },
  ]) {
    const candidate = structuredClone(current);
    change(candidate);
    assert.equal(hasSameHaOwnerIdentity(current, candidate), false);
  }
  const tuning = structuredClone(current);
  tuning.metadata.annotations['vault.hashicorp.com/agent-requests-mem'] = '128Mi';
  tuning.metadata.annotations['rivet.dev/ha-proof-generation'] = 'candidate';
  tuning.spec.serviceAccountName = 'default';
  assert.equal(hasSameHaOwnerIdentity(current, tuning), true);
});

test('HA Service routing normalizes API defaults but rejects mixed-version route changes', () => {
  const current = {
    spec: {
      clusterIP: '10.0.0.1',
      type: 'ClusterIP',
      selector: { component: 'api' },
      ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 80 }],
    },
  };
  const candidate = { spec: { selector: { component: 'api' }, ports: [{ name: 'http', port: 80 }] } };
  assert.equal(hasSameHaServiceRouting(current, candidate), true);
  for (const change of [
    (value) => {
      value.spec.ports[0].port = 81;
    },
    (value) => {
      value.spec.ports[0].targetPort = 3002;
    },
    (value) => {
      value.spec.selector.component = 'other';
    },
    (value) => {
      value.spec.clusterIP = 'None';
    },
    (value) => {
      value.spec.publishNotReadyAddresses = true;
    },
  ]) {
    const changed = structuredClone(candidate);
    change(changed);
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

test('a fresh rollout does not create a surge for a fully current, ready and serving workload', async () => {
  const f = fixture();
  for (const pod of f.pods.values()) pod.image = f.options.workloads[0].image;
  assert.equal((await runHaRollingUpgrade(f.options)).phase, 'complete');
  assert.deepEqual(f.operations, ['capacity', 'templates', 'autoscalers']);
  assert.equal(f.pods.size, 2);
});

test('an installed-version change under the acquired lease aborts untouched preflight and releases scaling', async () => {
  const f = fixture();
  f.options.assertInstalledBaseline = async () => {
    throw Error('installed version changed');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /installed version changed/);
  assert.equal(f.journal.phase, 'complete');
  assert.equal(f.journal.abortedBeforeTemplates, true);
  assert.equal(f.operations.includes('templates'), false);
  assert.equal(f.journal.leaseExpiresAt, f.options.now());
  await assert.rejects(runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token }), /No unfinished/);
});

test('autoscaled execution owners retain surge capacity for the drain-aware controller', async () => {
  const f = fixture();
  const workload = f.options.workloads[0];
  workload.role = 'execution';
  f.options.workloads.push({ ...workload, name: 'developer', role: 'backend', replicas: 1 });
  f.options.identity.controlPlaneMode = 'singleton';
  f.options.identity.cooperativeScaling = { workload: workload.name, maxReplicas: 7 };
  // The developer tier is unchanged and replaced serially; supply its owner.
  f.pods.set('developer-0', {
    ...structuredClone(f.pods.get('fixture-backend-0')),
    name: 'developer-0',
    image: workload.image,
  });
  await runHaRollingUpgrade(f.options);
  assert.equal(f.journal.phase, 'complete');
  assert.equal(f.pods.has('fixture-backend-2'), true);
  assert.equal(f.operations.includes('surge-removed'), false);
  assert.equal(f.operations.filter((op) => op.startsWith('delete:fixture-backend')).length, 2);
});

test('traffic growth during a real retirement adds execution owners that the upgrader preserves', async () => {
  const f = fixture(),
    workload = f.options.workloads[0];
  workload.role = 'execution';
  workload.uid = 'execution-sts';
  f.options.workloads.push({ ...workload, name: 'developer', role: 'backend', replicas: 1, uid: 'developer-sts' });
  f.options.identity.controlPlaneMode = 'singleton';
  const policy = autoscalerPolicy({ maxReplicas: 7 });
  f.options.identity.cooperativeScaling = {
    protocol: 1,
    workload: workload.name,
    uid: workload.uid,
    image: workload.image,
    maxReplicas: 7,
    policyDigest: autoscalerPolicyDigest(policy),
  };
  f.pods.set('developer-0', {
    ...structuredClone(f.pods.get('fixture-backend-0')),
    name: 'developer-0',
    image: workload.image,
  });
  const execution = () => [...f.pods.values()].filter((p) => p.name.startsWith(`${workload.name}-`));
  let grew = false;
  const withdraw = f.options.waitForRoutingWithdrawal;
  f.options.waitForRoutingWithdrawal = async (pod) => {
    await withdraw(pod);
    if (grew) return;
    grew = true;
    const io = {
      readJournal: async () => structuredClone(f.journal),
      snapshot: async () => ({
        uid: workload.uid,
        resourceVersion: '1',
        replicas: execution().length,
        pods: execution().map((p) => ({
          ...p,
          ordinal: Number(p.name.split('-').at(-1)),
          active: 9,
          limit: 10,
          cpuRatio: 0.1,
          sampleFresh: true,
          terminating: false,
        })),
      }),
      scale: async (_uid, from, to) => {
        assert.equal(from, execution().length);
        for (let ordinal = from; ordinal < to; ordinal++)
          f.pods.set(`${workload.name}-${ordinal}`, {
            ...structuredClone(pod),
            name: `${workload.name}-${ordinal}`,
            uid: randomUUID(),
            incarnation: randomUUID(),
            image: workload.image,
            ready: true,
            state: 'serving',
            operationId: null,
          });
      },
    };
    const result = await reconcileExecutionAutoscaling({
      io,
      policy,
      release: 'fixture',
      namespace: 'fixture',
      manifestDigest: 'candidate',
      runner: 'controller',
      workload: workload.name,
      image: workload.image,
      now: f.options.now,
    });
    assert.equal(result.state, 'rollout-scaled-up');
    assert.equal(result.replicas, 6);
  };
  await runHaRollingUpgrade(f.options);
  assert.equal(f.journal.phase, 'complete');
  assert.equal(execution().length, 6);
  assert.ok(execution().every((p) => p.ready && p.image === workload.image && p.state === 'serving'));
  assert.equal(f.operations.includes('surge-removed'), false);
});

test('exact-token HA recovery cannot replace the successful baseline policy or values', async () => {
  const f = fixture();
  const identity = {
    operationId: 'workflow',
    policyDigest: 'sha256:' + 'a'.repeat(64),
    valuesDigest: 'sha256:' + 'b'.repeat(64),
    beforeVerified: true,
  };
  f.options.identity.workflowIdentity = identity;
  f.options.checkHeadroom = async ({ stage }) => {
    if (stage === 'retirement') throw Error('pause at retirement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /pause at retirement/);
  const count = f.operations.length;
  f.options.identity.workflowIdentity = { ...identity, valuesDigest: 'sha256:' + 'c'.repeat(64) };
  await assert.rejects(
    runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token }),
    /original deployment safety contract/,
  );
  assert.equal(f.operations.length, count);
  f.options.identity.workflowIdentity = identity;
  f.options.checkHeadroom = async () => {};
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.journal.phase, 'complete');
});

test('same-image owners with an old desired revision still receive the guarded rollout', async () => {
  const f = fixture();
  for (const pod of f.pods.values()) {
    pod.image = f.options.workloads[0].image;
    pod.oldRevision = true;
  }
  f.options.isCurrentPod = (pod, workload) => pod.image === workload.image && !pod.oldRevision;
  assert.equal((await runHaRollingUpgrade(f.options)).phase, 'complete');
  assert.equal(f.operations.filter((operation) => operation.startsWith('delete:')).length, 2);
  assert.ok(f.operations.includes('scale:3'));
  assert.ok(f.operations.includes('surge-removed'));
});

test('an ownerless recovery still settles a surge whose scale acknowledgement was lost', async () => {
  const f = fixture();
  const scale = f.options.scale;
  let lost = false;
  f.options.scale = async (...args) => {
    await scale(...args);
    if (!lost && args[1] === 3) {
      lost = true;
      throw Error('lost surge scale acknowledgement');
    }
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost surge scale acknowledgement/);
  assert.equal(f.journal.owner, null);
  assert.equal(f.pods.size, 3);
  for (const pod of f.pods.values()) pod.image = f.options.workloads[0].image;
  f.advance(1);
  assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
  assert.equal(f.pods.size, 2);
  assert.ok(f.operations.includes('surge-removed'));
  assert.equal(f.operations.filter((operation) => operation.startsWith('begin:')).length, 1);
});

test('insufficient measured headroom prevents ownership and template changes at preflight', async () => {
  const f = fixture();
  f.options.checkHeadroom = async ({ stage }) => {
    assert.equal(stage, 'preflight');
    throw Error('insufficient measured headroom');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /insufficient measured headroom/);
  assert.equal(f.journal, undefined);
  assert.deepEqual(f.operations, ['capacity']);
});

test('a demand increase before templates aborts untouched preflight and allows a fresh attempt', async () => {
  const f = fixture();
  let observations = 0;
  f.options.checkHeadroom = async () => {
    if (++observations === 2) throw Error('insufficient measured headroom');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /insufficient measured headroom/);
  assert.equal(f.journal.phase, 'complete');
  assert.equal(f.journal.abortedBeforeTemplates, true);
  const token = f.journal.token;
  assert.deepEqual(f.operations, ['capacity']);
  f.options.checkHeadroom = async () => {};
  f.advance(1);
  await assert.rejects(runHaRollingUpgrade({ ...f.options, resumeToken: token }), /No unfinished/);
  assert.equal((await runHaRollingUpgrade(f.options)).phase, 'complete');
  assert.notEqual(f.journal.token, token);
});

test('full settlement must pass before the HA journal can become complete', async () => {
  const f = fixture();
  f.options.settle = async () => {
    assert.equal(f.journal.phase, 'owners');
    assert.ok(f.operations.includes('autoscalers'));
    throw Error('frontend still terminating');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /frontend still terminating/);
  assert.equal(f.journal.phase, 'owners');
  f.options.settle = async () => {};
  f.advance(1);
  assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
});

test('lease and owner health are rechecked after full settlement', async () => {
  for (const fault of ['lease', 'owner']) {
    const f = fixture();
    f.options.settle = async () => {
      if (fault === 'lease') f.advance(120_001);
      else f.pods.get('fixture-backend-0').ready = false;
    };
    await assert.rejects(
      runHaRollingUpgrade(f.options),
      /lease expired|ownership is unconfirmed|no longer current and ready/,
    );
    assert.equal(f.journal.phase, 'owners');
  }
});

test('peer failure during routing propagation blocks admission fencing and resumes without repeating withdrawal', async () => {
  const f = fixture();
  const waitForRoutingWithdrawal = f.options.waitForRoutingWithdrawal;
  f.options.waitForRoutingWithdrawal = async (pod) => {
    await waitForRoutingWithdrawal(pod);
    f.pods.get('fixture-backend-1').ready = false;
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /two other ready, serving owners/);
  assert.equal(f.operations.includes('withdraw-command:fixture-backend-0'), true);
  assert.equal(
    f.operations.some((operation) => operation.startsWith('begin:') || operation.startsWith('delete:')),
    false,
  );
  assert.equal(f.journal.owner.beginIssued, false);
  f.pods.get('fixture-backend-1').ready = true;
  f.options.waitForRoutingWithdrawal = waitForRoutingWithdrawal;
  f.advance(1);
  assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
  assert.equal(f.operations.filter((operation) => operation === 'withdraw-command:fixture-backend-0').length, 1);
});

test('a completed owner replaced during the final status read cannot seal a successful journal', async () => {
  const f = fixture();
  const status = f.options.status;
  let settled = false,
    replaced = false;
  f.options.settle = async () => {
    settled = true;
  };
  f.options.status = async (pod) => {
    const result = await status(pod);
    if (settled && !replaced && pod.name === 'fixture-backend-0') {
      const current = f.pods.get(pod.name);
      current.uid = randomUUID();
      current.ready = false;
      replaced = true;
    }
    return result;
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /changed during verification/);
  assert.equal(f.journal.phase, 'owners');
  f.pods.get('fixture-backend-0').ready = true;
  f.advance(1);
  assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
});

for (const when of ['before-withdrawal', 'before-admission-fence'])
  test(`a demand increase ${when} preserves accepted work and blocks further retirement`, async () => {
    const f = fixture();
    let observations = 0;
    f.options.checkHeadroom = async ({ stage, departing, workload }) => {
      if (stage !== 'retirement') return;
      assert.equal(workload.name, 'fixture-backend');
      assert.equal(departing.name, 'fixture-backend-0');
      if (++observations === (when === 'before-withdrawal' ? 1 : 2)) throw Error('insufficient measured headroom');
    };
    await assert.rejects(runHaRollingUpgrade(f.options), /insufficient measured headroom/);
    assert.equal(
      f.operations.some((operation) => operation.startsWith('begin:') || operation.startsWith('delete:')),
      false,
    );
    assert.equal(
      f.operations.some((operation) => operation.startsWith('withdraw-command:')),
      when === 'before-admission-fence',
    );
    assert.equal(f.pods.size, 3);
    f.options.checkHeadroom = async () => {};
    f.advance(1);
    assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
    assert.equal(f.operations.filter((operation) => operation === 'withdraw-command:fixture-backend-0').length, 1);
  });

test('replicated HA also rejects an execution tier with only one owner', () => {
  const f = fixture();
  assert.throws(
    () =>
      assertHaRolloutPlan([
        ...f.options.workloads,
        { ...f.options.workloads[0], name: 'fixture-execution', role: 'execution', replicas: 1 },
      ]),
    /at least two|two.*owners/,
  );
});

for (const role of ['backend', 'execution'])
  for (const fault of ['not-ready', 'retiring', 'changed-uid'])
    test(`a ${fault} peer after preflight blocks the next ${role} retirement before withdrawal`, async () => {
      const f = fixture();
      const name = `fixture-${role}`;
      if (role === 'execution') {
        f.options.workloads.push({ ...f.options.workloads[0], name, role });
        for (let i = 0; i < 2; i++)
          f.pods.set(`${name}-${i}`, {
            ...structuredClone(f.pods.get(`fixture-backend-${i}`)),
            name: `${name}-${i}`,
            uid: randomUUID(),
            incarnation: randomUUID(),
          });
      }
      const waitReady = f.options.waitForReady;
      const status = f.options.status;
      let changed = false,
        armed = false;
      f.options.waitForReady = async (...args) => {
        await waitReady(...args);
        if (args[0] !== `${name}-2`) return;
        armed = true;
        if (fault === 'not-ready') f.pods.get(`${name}-1`).ready = false;
        if (fault === 'retiring')
          Object.assign(f.pods.get(`${name}-1`), { state: 'withdrawing', operationId: randomUUID() });
      };
      f.options.status = async (pod) => {
        if (armed && fault === 'changed-uid' && pod.name === `${name}-1` && !changed) {
          f.pods.get(pod.name).uid = randomUUID();
          changed = true;
        }
        return status(pod);
      };
      await assert.rejects(runHaRollingUpgrade(f.options), /two.*serving|replacement capacity/);
      assert.ok(!f.operations.some((o) => new RegExp(`^(withdraw-command|begin|delete):${name}`).test(o)));
      assert.equal(
        [...f.pods.keys()].filter((n) => n.startsWith(name)).length,
        3,
        'keep the surge; do not compensate by deleting an accepted owner',
      );
      Object.assign(f.pods.get(`${name}-1`), { ready: true, state: 'serving', operationId: null });
      f.options.waitForReady = waitReady;
      f.options.status = status;
      f.advance(1);
      assert.equal((await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token })).phase, 'complete');
      const withdrawals = f.operations.filter((o) => o.startsWith(`withdraw-command:${name}`));
      assert.equal(withdrawals.length, 3);
      assert.equal(new Set(withdrawals).size, 3, 'resume must not replay a retirement');
    });
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
    {
      kind: 'StatefulSet',
      metadata: { name: 'backend' },
      spec: { template: { spec: { containers: [{ image: 'same-image', resources: { limits: { memory: '1Gi' } } }] } } },
    },
    { kind: 'Service', metadata: { name: 'api' }, spec: { ports: [{ port: 80 }] } },
    { kind: 'HorizontalPodAutoscaler', metadata: { name: 'execution' }, spec: { maxReplicas: 4 } },
  ];
  const digest = getHaConfigurationDigest(resources);
  const reordered = resources
    .toReversed()
    .map((resource) => ({ spec: resource.spec, metadata: resource.metadata, kind: resource.kind }));
  assert.equal(getHaConfigurationDigest(reordered), digest);
  for (const change of [
    (value) => {
      value[0].spec.template.spec.containers[0].resources.limits.memory = '2Gi';
    },
    (value) => {
      value[1].spec.ports[0].port = 81;
    },
    (value) => {
      value[2].spec.maxReplicas = 5;
    },
  ]) {
    const changed = structuredClone(resources);
    change(changed);
    assert.notEqual(getHaConfigurationDigest(changed), digest);
  }
});

test('recovery cannot apply different values at autoscaler restoration after retiring an identical image', async () => {
  const f = fixture(),
    begin = f.options.begin;
  f.options.identity.configurationDigest = 'original-values';
  f.options.begin = async (...args) => {
    await begin(...args);
    throw Error('lost acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost acknowledgement/);
  f.options.begin = begin;
  const before = [...f.operations];
  await assert.rejects(
    runHaRollingUpgrade({
      ...f.options,
      resumeToken: f.journal.token,
      identity: { ...f.options.identity, configurationDigest: 'different-values' },
    }),
    /recovery configuration changed/,
  );
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
      if (fault === 'retirement') {
        pod.state = 'withdrawing';
        pod.operationId = randomUUID();
      }
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
  'foreign-pod-controller',
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
        return result({
          items: [
            {
              kind: 'Service',
              metadata: { name: 'public' },
              spec: fault === 'service-routing-change' ? { ports: [{ port: 81 }] } : {},
            },
          ],
        });
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
            ownerReferences: [
              {
                kind: 'StatefulSet',
                controller: true,
                uid: fault === 'foreign-pod-controller' ? 'foreign-controller' : current.metadata.uid,
              },
            ],
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
        if (args.includes('--withdraw-only')) {
          routingWithdrawals.set(pod.uid, routingTime);
          Object.assign(pod, { state: 'withdrawing', operationId: args[7], ready: false });
        }
        if (args.includes('--begin-only')) {
          assert.ok(
            routingTime - routingWithdrawals.get(pod.uid) >= 60_000,
            'ordinary roll cannot close admission on the control-plane acknowledgement alone',
          );
          Object.assign(pod, { state: 'drained', operationId: args[7], ready: false });
        }
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
          if (['lost-acknowledgement', 'recreated-statefulset-recovery'].includes(fault))
            throw Error('lost scale acknowledgement');
        }
        return result({});
      }
      throw Error(`Unexpected Kubernetes command: ${args}`);
    };
    let routingTime = 0;
    const routingWithdrawals = new Map();
    const options = {
      kube,
      release: 'fixture',
      namespace: 'fixture',
      manifestDigest: 'candidate',
      resources: [candidate, { kind: 'Service', metadata: { name: 'public' }, spec: {} }],
      timeoutMs: 1000,
      routingWithdrawalClock: {
        now: () => routingTime,
        wait: async () => {
          routingTime += 1000;
        },
      },
      applyTemplates: async (_workloads, guardedValues) => {
        assert.deepEqual(guardedValues, {
          replicaCount: { backend: 2 },
          ha: { rolloutResourceVersions: { [name]: 'observed-version' } },
        });
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
    if (fault === 'foreign-pod-controller') {
      await assert.rejects(runHaKubernetesRollout(options), /pod controller ownership/);
      assert.equal(cm, undefined, 'foreign pods must be rejected before journal ownership or Helm changes');
      assert.equal(
        calls.filter((a) => ['create', 'replace', 'patch', 'scale', 'delete', 'exec'].includes(a[0])).length,
        0,
      );
      return;
    }
    if (fault === 'missing-final-revision') {
      await assert.rejects(runHaKubernetesRollout(options), /completion is blocked/);
      assert.equal(restored, false);
      assert.equal(JSON.parse(cm.data.record).phase, 'owners');
      return;
    }
    if (['recreated-statefulset', 'scale-resource-version-race', 'service-routing-change'].includes(fault)) {
      await assert.rejects(
        runHaKubernetesRollout(options),
        /StatefulSet identity changed|scale resourceVersion conflict|Service routing changed/,
      );
      assert.equal(
        calls.filter((a) => a.includes('--withdraw-only') || a.includes('--begin-only') || a[0] === 'delete').length,
        0,
      );
      assert.equal(restored, false);
      if (fault === 'service-routing-change') assert.equal(cm, undefined);
      return;
    }
    if (fault.startsWith('template-')) {
      await assert.rejects(
        runHaKubernetesRollout(options),
        /capacity changed before template update|resourceVersion conflict/,
      );
      assert.equal(
        calls.filter(
          (a) => a.includes('--withdraw-only') || a.includes('--begin-only') || a[0] === 'delete' || a[0] === 'scale',
        ).length,
        0,
      );
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
      await assert.rejects(
        runHaKubernetesRollout({ ...options, resumeToken: JSON.parse(cm.data.record).token }),
        /recovery inventory changed/,
      );
      assert.equal(
        calls.slice(before).filter((a) => ['create', 'replace', 'scale', 'delete', 'exec'].includes(a[0])).length,
        0,
      );
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
