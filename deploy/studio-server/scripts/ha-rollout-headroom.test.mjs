import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessHaExecutionHeadroom,
  createHaExecutionHeadroomGuard,
  createHaProxyHeadroomGuard,
  waitForHaHeadroom,
} from './lib/ha-rollout-headroom.mjs';

const policy = { minReplicas: 2, maxReplicas: 7 };
const snapshot = (replicas = 3) => ({
  uid: 'workload-uid',
  replicas,
  pods: Array.from({ length: replicas }, (_, ordinal) => ({
    name: `execution-${ordinal}`,
    uid: `uid-${ordinal}`,
    incarnation: `incarnation-${ordinal}`,
    ordinal,
    ready: true,
    terminating: false,
    sampleFresh: true,
    state: 'serving',
    operationId: null,
    active: 2,
    limit: 10,
    cpuRatio: 0.1,
  })),
});

test('ordinary retirement can exceed the scaling target while retaining real admission and CPU capacity', () => {
  const sample = snapshot();
  for (const pod of sample.pods) Object.assign(pod, { active: 1, limit: 4, cpuRatio: 0.6 });
  sample.pods[0].active = 3;
  const result = assessHaExecutionHeadroom(sample, policy, sample.pods[0]);
  assert.equal(result.activeSlots, 5);
  assert.equal(result.availableServingOwners, 2);
  assert.equal(result.requiredServingOwners, 2);
  assert.equal(result.targetServingOwners, 3);
  assert.equal(result.spareOwnersAtTarget, -1);
  assert.equal(result.sufficient, true);
});

test('headroom accounts for the departing owner and all accepted work', () => {
  const sample = snapshot();
  let result = assessHaExecutionHeadroom(sample, policy, sample.pods[2]);
  assert.equal(result.availableServingOwners, 2);
  assert.equal(result.sufficient, true);
  sample.pods[2].active = 20;
  Object.assign(sample.pods[2], { state: 'withdrawing', ready: false, operationId: 'owned' });
  result = assessHaExecutionHeadroom(sample, policy, sample.pods[2]);
  assert.equal(result.activeSlots, 24);
  assert.equal(result.requiredServingOwners, 3);
  assert.equal(result.targetServingOwners, 4);
  assert.equal(result.sufficient, false);
  assert.equal(result.spareOwnersAtTarget, -2);
});

test('CPU rounding cannot invent an extra required owner at reserved capacity', () => {
  const sample = snapshot();
  sample.pods[0].cpuRatio = 0.5 + Number.EPSILON;
  sample.pods[1].cpuRatio = 0.5 + Number.EPSILON;
  sample.pods[2].cpuRatio = 1;
  const result = assessHaExecutionHeadroom(sample, policy, sample.pods[2]);
  assert.equal(result.requiredServingOwners, 2);
  assert.equal(result.sufficient, true);
  sample.pods[2].cpuRatio = 1.000001;
  assert.equal(assessHaExecutionHeadroom(sample, policy, sample.pods[2]).sufficient, false);
});

test('CPU demand and overload beyond the autoscaler maximum cannot be hidden by clamping', () => {
  const sample = snapshot(8);
  for (const pod of sample.pods) pod.cpuRatio = 3;
  const result = assessHaExecutionHeadroom(sample, policy);
  assert.equal(result.requiredServingOwners, 24);
  assert.equal(result.targetServingOwners, 32);
  assert.equal(result.sufficient, false);
  assert.throws(() => assessHaExecutionHeadroom(snapshot(9), policy), /surge bound/);
});

test('missing, stale, changed or inconsistent observations block headroom acceptance', () => {
  for (const change of [
    (sample) => {
      sample.pods[0].sampleFresh = false;
    },
    (sample) => {
      sample.pods[0].ready = false;
    },
    (sample) => {
      sample.pods[0].limit = 11;
    },
    (sample) => {
      sample.pods.pop();
    },
    (sample) => {
      sample.pods[1].uid = sample.pods[0].uid;
    },
  ]) {
    const sample = snapshot();
    change(sample);
    assert.throws(() => assessHaExecutionHeadroom(sample, policy), /unconfirmed|differ|incomplete/);
  }
  assert.throws(
    () => assessHaExecutionHeadroom(snapshot(), policy, { name: 'execution-2', uid: 'changed' }),
    /owner changed/,
  );
});

function fixture(replicas = 2) {
  const now = 1_000_000;
  const oldImage = `api@sha256:${'a'.repeat(64)}`,
    candidate = `api@sha256:${'b'.repeat(64)}`;
  const workload = { name: 'execution', uid: 'workload-uid', role: 'execution', replicas: 2, image: candidate };
  const owner = {
    metadata: { name: 'execution', uid: workload.uid, labels: { 'app.kubernetes.io/instance': 'rivet' } },
    spec: {
      replicas,
      updateStrategy: { type: 'OnDelete' },
      template: {
        spec: { containers: [{ name: 'api', image: oldImage }] },
      },
    },
  };
  const initial = structuredClone(owner);
  const pods = snapshot(replicas).pods.map((pod) => ({
    metadata: {
      name: pod.name,
      uid: pod.uid,
      ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: workload.uid, name: workload.name }],
    },
    spec: { containers: [{ name: 'api', resources: { requests: { cpu: '1000m' } } }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  }));
  const metrics = pods.map((pod) => ({
    metadata: { name: pod.metadata.name },
    timestamp: new Date(now).toISOString(),
    containers: [{ name: 'api', usage: { cpu: '100m' } }],
  }));
  const config = {
    release: 'rivet',
    namespace: 'rivet',
    workload: 'execution',
    service: 'execution',
    image: candidate,
    port: 8080,
    policy,
  };
  const resources = [
    {
      kind: 'Deployment',
      metadata: { labels: { 'app.kubernetes.io/component': 'autoscaler' } },
      spec: {
        template: {
          spec: { containers: [{ env: [{ name: 'RIVET_AUTOSCALER_CONFIG', value: JSON.stringify(config) }] }] },
        },
      },
    },
  ];
  let active = 1;
  const receipts = [],
    calls = [];
  const kube = async (args) => {
    calls.push(args);
    if (args[0] === 'exec') {
      if (args.at(-1) === '/opt/rivet/retire-backend.mjs')
        return {
          stdout: JSON.stringify({
            protocol: 1,
            withdrawalProtocol: 1,
            state: 'serving',
            incarnation: args[1],
            operationId: null,
          }),
        };
      return {
        stdout: `rivet_published_execution_active_runs ${typeof active === 'function' ? active(args[1]) : active}\nrivet_published_execution_admission_limit{mode="enforce"} 10\n`,
      };
    }
    assert.deepEqual(args.slice(0, 2), ['get', '--raw']);
    const pathname = args[2].split('?')[0];
    let value;
    if (pathname.includes('/statefulsets/')) value = owner;
    else if (pathname.includes('/metrics.k8s.io/')) value = { items: metrics };
    else if (pathname.endsWith('/horizontalpodautoscalers')) value = { items: [] };
    else if (pathname.endsWith('/pods')) value = { items: pods };
    else value = pods.find((pod) => pathname.endsWith(`/pods/${pod.metadata.name}`));
    assert.ok(value, `unexpected read ${pathname}`);
    return { stdout: JSON.stringify(value) };
  };
  const options = {
    kube,
    release: 'rivet',
    namespace: 'rivet',
    resources,
    workloads: [workload],
    inventory: [initial],
    now: () => now,
    artifact: async (_name, text) => receipts.push(JSON.parse(text)),
  };
  return {
    options,
    owner,
    pods,
    metrics,
    receipts,
    calls,
    candidate,
    setActive: (value) => {
      active = value;
    },
  };
}

test('retirement waits read-only for cooperative growth when current demand needs another surviving worker', async () => {
  const f = fixture(3);
  f.owner.spec.template.spec.containers[0].image = f.candidate;
  f.setActive((name) => (name === 'execution-3' ? 0 : 8));
  const departing = { name: 'execution-0', uid: 'uid-0' };
  const guard = createHaExecutionHeadroomGuard(f.options);
  let clock = 0,
    pauses = 0;
  await waitForHaHeadroom(() => guard({ stage: 'retirement', departing }), {
    timeoutMs: 2000,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
      pauses++;
      f.owner.spec.replicas = 4;
      const pod = structuredClone(f.pods[0]);
      Object.assign(pod.metadata, { name: 'execution-3', uid: 'uid-3' });
      f.pods.push(pod);
      f.metrics.push({ ...structuredClone(f.metrics[0]), metadata: { name: 'execution-3' } });
    },
  });
  assert.equal(pauses, 1);
  assert.equal(f.receipts[0].outcome, 'blocked');
  assert.equal(f.receipts.at(-1).requiredServingOwners, 3);
  assert.equal(f.receipts.at(-1).availableServingOwners, 3);
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.ok(f.calls.every((args) => args[0] === 'get' || args[0] === 'exec'));
});

test('capacity waiting expires within the original shorter deadline or five minutes, and identity failures stop it', async () => {
  for (const scenario of ['shorter-deadline', 'five-minute-cap', 'changed-identity']) {
    const f = fixture(3);
    f.setActive(11);
    let clock = 0,
      pauses = 0;
    const guard = createHaExecutionHeadroomGuard(f.options);
    const work = waitForHaHeadroom(() => guard({ stage: 'preflight' }), {
      timeoutMs: scenario === 'five-minute-cap' ? 1200000 : 2000,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        pauses++;
        if (scenario === 'changed-identity') f.owner.metadata.uid = 'foreign';
      },
    });
    await assert.rejects(work, scenario === 'changed-identity' ? /headroom is unconfirmed/ : /insufficient/);
    assert.equal(pauses, scenario === 'changed-identity' ? 1 : scenario === 'five-minute-cap' ? 300 : 2);
    assert.equal(clock, scenario === 'five-minute-cap' ? 300000 : scenario === 'changed-identity' ? 1000 : 2000);
  }
});

test('Kubernetes guard reuses fenced metrics reads and records sanitized execution headroom', async () => {
  const f = fixture();
  const guard = createHaExecutionHeadroomGuard(f.options);
  await guard({ stage: 'preflight' });
  assert.equal(f.receipts[0].outcome, 'passed');
  assert.equal(f.receipts[0].autoscalingFrozen, false);
  f.owner.spec.template.spec.containers[0].image = f.candidate;
  await guard({ stage: 'retirement' });
  assert.equal(f.receipts[1].autoscalingFrozen, false);
  assert.equal(f.receipts[1].scaleDownPaused, true);
  assert.equal(f.receipts[1].automaticBurstScaling, true);
  assert.equal(f.receipts[1].availableServingOwners, 2);
  assert.ok(f.calls.every((args) => args[0] === 'get' || args[0] === 'exec'));
  assert.equal(JSON.stringify(f.receipts).includes('sha256:'), false);
  f.setActive(11);
  await assert.rejects(guard({ stage: 'retirement' }), /insufficient measured headroom/);
  assert.equal(f.receipts.at(-1).requiredServingOwners, 3);
  assert.equal(f.receipts.at(-1).outcome, 'blocked');
});

test('guard fails closed on stale samples or workload identity changes with a blocked receipt', async () => {
  for (const change of [
    (f) => {
      f.metrics[0].timestamp = new Date(0).toISOString();
    },
    (f) => {
      f.owner.metadata.uid = 'replacement';
    },
    (f) => {
      f.owner.spec.template.spec.containers[0].image = 'foreign';
    },
  ]) {
    const f = fixture(),
      guard = createHaExecutionHeadroomGuard(f.options);
    change(f);
    await assert.rejects(guard({ stage: 'preflight' }), /headroom is unconfirmed/);
    assert.equal(f.receipts.at(-1).outcome, 'blocked');
  }
});

test('execution headroom reconfirms the complete capacity inventory after sequential sampling', async () => {
  for (const change of [
    (f) => {
      f.pods[0].status.conditions[0].status = 'False';
    },
    (f) => {
      f.pods[0].metadata.uid = 'replacement-after-first-sample';
    },
    (f) => {
      f.owner.metadata.uid = 'replacement-workload';
    },
    (f) => {
      f.owner.spec.template.metadata = { annotations: { 'rivet.dev/execution-retirement-fence': 'execution-1' } };
    },
    (f) => {
      f.owner.spec.replicas = 3;
      f.pods.push({
        ...structuredClone(f.pods[0]),
        metadata: { ...f.pods[0].metadata, name: 'execution-2', uid: 'new-unmeasured-owner' },
      });
    },
  ]) {
    const f = fixture(),
      kube = f.options.kube;
    f.options.kube = async (args) => {
      const result = await kube(args);
      if (args[0] === 'exec' && args[1] === 'execution-1' && args.includes('-e')) change(f);
      return result;
    };
    await assert.rejects(createHaExecutionHeadroomGuard(f.options)({ stage: 'preflight' }), /headroom is unconfirmed/);
    assert.equal(f.receipts.at(-1).outcome, 'blocked');
  }
});

test('execution headroom cannot outlive metric freshness while confirming capacity', async () => {
  const f = fixture(),
    kube = f.options.kube;
  let now = 1_000_000,
    lists = 0;
  f.options.now = () => now;
  f.options.kube = async (args) => {
    const result = await kube(args);
    if (args[0] === 'get' && args[2].split('?')[0].endsWith('/pods') && ++lists === 2) now += 90_001;
    return result;
  };
  await assert.rejects(createHaExecutionHeadroomGuard(f.options)({ stage: 'preflight' }), /headroom is unconfirmed/);
  assert.equal(f.receipts.at(-1).outcome, 'blocked');
});

test('growth during metric sampling is reobserved without hiding changed identities or lost readiness', async () => {
  for (const scenario of ['growth', 'changed-peer', 'foreign-growth', 'lost-readiness', 'outside-cap']) {
    const f = fixture(3),
      kube = f.options.kube;
    let added,
      pauses = 0,
      clock = 0;
    f.options.kube = async (args) => {
      const result = await kube(args);
      if (!added && args[0] === 'exec' && args[1] === 'execution-2' && args.includes('-e')) {
        added = structuredClone(f.pods[0]);
        Object.assign(added.metadata, { name: 'execution-3', uid: 'uid-3' });
        added.status.phase = 'Pending';
        added.status.conditions[0].status = 'False';
        f.owner.spec.replicas = scenario === 'outside-cap' ? 8 : 4;
        f.pods.push(added);
        if (scenario === 'changed-peer') f.pods[0].metadata.uid = 'replacement';
        if (scenario === 'foreign-growth') added.metadata.ownerReferences[0].uid = 'foreign';
        if (scenario === 'lost-readiness') f.pods[0].status.conditions[0].status = 'False';
      }
      return result;
    };
    const guard = createHaExecutionHeadroomGuard(f.options);
    const work = waitForHaHeadroom(() => guard({ stage: 'preflight' }), {
      timeoutMs: 3000,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        if (++pauses === 2) {
          added.status.phase = 'Running';
          added.status.conditions[0].status = 'True';
          f.metrics.push({ ...structuredClone(f.metrics[0]), metadata: { name: 'execution-3' } });
        }
      },
    });
    if (scenario === 'growth') {
      await work;
      assert.equal(pauses, 2);
      assert.equal(f.receipts.at(-1).availableServingOwners, 4);
    } else {
      await assert.rejects(work, /headroom is unconfirmed/);
      assert.equal(pauses, 0, 'Only intact owned growth within the approved cap can wait');
    }
  }
});

test('the deliberately withdrawn owner need not become ready again before its accepted work drains', async () => {
  const f = fixture(3),
    kube = f.options.kube;
  f.owner.spec.template.spec.containers[0].image = f.candidate;
  f.pods[0].status.conditions[0].status = 'False';
  f.options.kube = async (args) => {
    const result = await kube(args);
    if (args[0] === 'exec' && args[1] === 'execution-0' && args.at(-1) === '/opt/rivet/retire-backend.mjs')
      return { stdout: JSON.stringify({ ...JSON.parse(result.stdout), state: 'withdrawing', operationId: 'owned' }) };
    return result;
  };
  await createHaExecutionHeadroomGuard(f.options)({
    stage: 'retirement',
    departing: { name: 'execution-0', uid: 'uid-0' },
  });
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.equal(f.receipts.at(-1).availableServingOwners, 2);
});

test('profiles without the execution controller do not acquire an unrelated metrics dependency', async () => {
  const f = fixture();
  await createHaExecutionHeadroomGuard({ ...f.options, resources: [] })({ stage: 'preflight' });
  assert.equal(f.calls.length, 0);
});

function proxyFixture(replicas = 2) {
  const now = 1_000_000,
    receipts = [],
    calls = [];
  const labels = { 'app.kubernetes.io/instance': 'rivet', 'app.kubernetes.io/component': 'proxy' };
  const deployment = {
    kind: 'Deployment',
    metadata: { name: 'proxy', uid: 'proxy-uid', labels },
    spec: {
      replicas,
      strategy: { rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      selector: { matchLabels: labels },
    },
  };
  const hpa = {
    kind: 'HorizontalPodAutoscaler',
    spec: {
      minReplicas: 2,
      maxReplicas: 4,
      scaleTargetRef: { kind: 'Deployment', name: 'proxy' },
      metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } } },
      ],
    },
  };
  const sets = [
    {
      metadata: {
        uid: 'rs-uid',
        ownerReferences: [{ controller: true, kind: 'Deployment', name: 'proxy', uid: 'proxy-uid' }],
      },
    },
  ];
  const pods = Array.from({ length: replicas }, (_, ordinal) => ({
    metadata: {
      name: `proxy-${ordinal}`,
      uid: `proxy-${ordinal}-uid`,
      ownerReferences: [{ controller: true, kind: 'ReplicaSet', uid: 'rs-uid' }],
    },
    spec: { containers: [{ name: 'proxy', resources: { requests: { cpu: '500m' } } }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  }));
  const metrics = pods.map((pod) => ({
    metadata: { name: pod.metadata.name },
    timestamp: new Date(now).toISOString(),
    containers: [{ name: 'proxy', usage: { cpu: '100m' } }],
  }));
  const kube = async (args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 2), ['get', '--raw']);
    const path = args[2].split('?')[0];
    let result;
    if (path.includes('/deployments/')) result = deployment;
    else if (path.includes('/metrics.k8s.io/')) result = { items: metrics };
    else if (path.endsWith('/replicasets')) result = { items: sets };
    else if (path.endsWith('/pods')) result = { items: pods };
    assert.ok(result, `unexpected request ${path}`);
    return { stdout: JSON.stringify(result) };
  };
  const options = {
    kube,
    release: 'rivet',
    namespace: 'rivet',
    resources: [structuredClone(deployment), hpa],
    now: () => now,
    artifact: async (_name, text) => receipts.push(JSON.parse(text)),
  };
  return { options, receipts, calls, deployment, pods, metrics, sets };
}

function addProxyPod(f, { terminating = false, cpu = '100m' } = {}) {
  const pod = structuredClone(f.pods[0]);
  pod.metadata.name = `proxy-${f.pods.length}`;
  pod.metadata.uid = `${pod.metadata.name}-uid`;
  if (terminating) pod.metadata.deletionTimestamp = new Date(f.options.now()).toISOString();
  f.pods.push(pod);
  f.metrics.push({
    metadata: { name: pod.metadata.name },
    timestamp: new Date(f.options.now()).toISOString(),
    containers: [{ name: 'proxy', usage: { cpu } }],
  });
  return pod;
}

test('proxy rollout allows four desired pods, one surge and terminating predecessors', async () => {
  const f = proxyFixture(4);
  addProxyPod(f);
  addProxyPod(f, { terminating: true });
  const guard = createHaProxyHeadroomGuard(f.options);
  await guard({ stage: 'retirement' });
  assert.equal(f.receipts.at(-1).availableServingOwners, 4);
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.ok(Math.abs(f.receipts.at(-1).totalCpuCores - 0.6) < 1e-9);
  addProxyPod(f, { terminating: true });
  await guard({ stage: 'retirement' });
  assert.equal(f.receipts.at(-1).availableServingOwners, 4);
  assert.equal(f.receipts.at(-1).owners.length, 7);
  assert.ok(f.calls.every((args) => args[0] === 'get' && args[1] === '--raw'));
});

test('terminating proxies cannot supply serving capacity and their CPU demand still counts', async () => {
  const f = proxyFixture();
  f.pods[1].metadata.deletionTimestamp = new Date(f.options.now()).toISOString();
  await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /insufficient/);
  assert.equal(f.receipts.at(-1).availableServingOwners, 1);

  const busy = proxyFixture();
  addProxyPod(busy, { terminating: true, cpu: '1400m' });
  await assert.rejects(createHaProxyHeadroomGuard(busy.options)({ stage: 'retirement' }), /insufficient/);
  assert.equal(busy.receipts.at(-1).availableServingOwners, 2);
  assert.equal(busy.receipts.at(-1).requiredServingOwners, 4);
});

test('proxy rollout still rejects too many non-terminating pods', async () => {
  const f = proxyFixture();
  addProxyPod(f);
  addProxyPod(f);
  await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), (error) =>
    /outside the surge bound/.test(error.cause?.message),
  );
});

test('terminating proxies retain ownership and CPU checks', async () => {
  for (const fault of ['foreign-owner', 'duplicate-uid', 'missing-cpu', 'stale-cpu']) {
    const f = proxyFixture(),
      pod = addProxyPod(f, { terminating: true });
    if (fault === 'foreign-owner') pod.metadata.ownerReferences[0].uid = 'foreign';
    if (fault === 'duplicate-uid') pod.metadata.uid = f.pods[0].metadata.uid;
    if (fault === 'missing-cpu') f.metrics.pop();
    if (fault === 'stale-cpu') f.metrics.at(-1).timestamp = new Date(0).toISOString();
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /headroom is unconfirmed/);
    assert.equal(f.receipts.at(-1).outcome, 'blocked');
  }
});

test('fully stopped terminating proxies need no further CPU scrape or serving-capacity credit', async () => {
  const f = proxyFixture(),
    stopped = addProxyPod(f, { terminating: true });
  stopped.status.containerStatuses = [{ name: 'proxy', state: { terminated: { exitCode: 0 } } }];
  f.metrics.pop();
  await createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' });
  assert.equal(f.receipts.at(-1).availableServingOwners, 2);
  assert.equal(f.receipts.at(-1).totalCpuCores, 0.2);
  f.pods[1].metadata.deletionTimestamp = new Date(f.options.now()).toISOString();
  f.pods[1].status.containerStatuses = [{ name: 'proxy', state: { terminated: { exitCode: 0 } } }];
  f.metrics.pop();
  await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /insufficient/);
  assert.equal(f.receipts.at(-1).availableServingOwners, 1);
});

test('a stopped proxy container cannot hide live or unknown containers from the CPU check', async () => {
  for (const state of ['running', 'unknown', 'sidecar', 'debug-container', 'not-terminating']) {
    const f = proxyFixture(),
      draining = addProxyPod(f, { terminating: true });
    draining.status.containerStatuses = [{ name: 'proxy', state: { terminated: { exitCode: 0 } } }];
    if (state === 'running') draining.status.containerStatuses[0].state = { running: {} };
    if (state === 'unknown') delete draining.status.containerStatuses;
    if (state === 'not-terminating') delete draining.metadata.deletionTimestamp;
    if (state === 'sidecar') {
      draining.spec.initContainers = [{ name: 'sidecar', restartPolicy: 'Always' }];
      draining.status.initContainerStatuses = [{ name: 'sidecar', state: { running: {} } }];
    }
    if (state === 'debug-container') {
      draining.spec.ephemeralContainers = [{ name: 'debug' }];
      draining.status.ephemeralContainerStatuses = [{ name: 'debug', state: { running: {} } }];
    }
    f.metrics.pop();
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /headroom is unconfirmed/);
  }
});

test('already-terminating proxies may finish during CPU confirmation without losing their measured demand', async () => {
  for (const finished of ['absent', 'Succeeded', 'Failed', 'containers-stopped']) {
    const f = proxyFixture(4);
    addProxyPod(f);
    const terminating = addProxyPod(f, { terminating: true }),
      kube = f.options.kube;
    let podReads = 0;
    f.options.kube = async (args) => {
      if (!args[2].includes('/metrics.k8s.io/') && args[2].split('?')[0].endsWith('/pods') && ++podReads === 2) {
        if (finished === 'absent') f.pods.pop();
        else if (finished === 'containers-stopped')
          terminating.status.containerStatuses = [{ name: 'proxy', state: { terminated: { exitCode: 0 } } }];
        else terminating.status.phase = finished;
      }
      return kube(args);
    };
    await createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' });
    assert.equal(f.receipts.at(-1).availableServingOwners, 4);
    assert.ok(Math.abs(f.receipts.at(-1).totalCpuCores - 0.6) < 1e-9);
  }
});

test('serving proxies disappearing or starting termination during CPU confirmation still block retirement', async () => {
  for (const change of ['absent', 'terminating']) {
    const f = proxyFixture(),
      kube = f.options.kube;
    let podReads = 0;
    f.options.kube = async (args) => {
      if (!args[2].includes('/metrics.k8s.io/') && args[2].split('?')[0].endsWith('/pods') && ++podReads === 2) {
        if (change === 'absent') f.pods.pop();
        else f.pods[0].metadata.deletionTimestamp = new Date(f.options.now()).toISOString();
      }
      return kube(args);
    };
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /headroom is unconfirmed/);
  }
});

test('allowing a draining proxy to finish does not admit a changed or unmeasured owner', async () => {
  for (const change of ['uid', 'termination-cleared', 'new-owner']) {
    const f = proxyFixture(),
      terminating = addProxyPod(f, { terminating: true }),
      kube = f.options.kube;
    let podReads = 0;
    f.options.kube = async (args) => {
      if (!args[2].includes('/metrics.k8s.io/') && args[2].split('?')[0].endsWith('/pods') && ++podReads === 2) {
        if (change === 'uid') terminating.metadata.uid = 'replacement';
        if (change === 'termination-cleared') delete terminating.metadata.deletionTimestamp;
        if (change === 'new-owner') {
          f.pods.pop();
          addProxyPod(f).metadata.uid = 'unmeasured-new-owner';
        }
      }
      return kube(args);
    };
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /headroom is unconfirmed/);
  }
});

test('proxy headroom uses current CPU demand rather than HPA desired replicas', async () => {
  const f = proxyFixture(),
    guard = createHaProxyHeadroomGuard(f.options);
  await guard({ stage: 'preflight' });
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.equal(f.receipts.at(-1).availableServingOwners, 2);
  assert.equal(f.receipts.at(-1).totalCpuCores, 0.2);
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '700m';
  await assert.rejects(guard({ stage: 'retirement' }), /proxy headroom is insufficient/);
  assert.equal(f.receipts.at(-1).requiredServingOwners, 3);
  assert.equal(f.receipts.at(-1).targetServingOwners, 4);
  assert.equal(f.receipts.at(-1).autoscalingFrozen, false);
  assert.equal(f.receipts.at(-1).scaleDownPaused, true);
});

test('proxy utilization above its scaling target can roll within its reserved CPU capacity', async () => {
  const f = proxyFixture();
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '450m';
  await createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' });
  assert.equal(f.receipts.at(-1).requiredServingOwners, 2);
  assert.equal(f.receipts.at(-1).targetServingOwners, 3);
  assert.equal(f.receipts.at(-1).spareOwnersAtTarget, -1);
  assert.equal(f.receipts.at(-1).outcome, 'passed');
});

test('proxy capacity growth is observed without scaling or withdrawing from the guard', async () => {
  const f = proxyFixture();
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '700m';
  let clock = 0,
    pauses = 0;
  const guard = createHaProxyHeadroomGuard(f.options);
  await waitForHaHeadroom(() => guard({ stage: 'retirement' }), {
    timeoutMs: 2000,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
      pauses++;
      f.deployment.spec.replicas = 3;
      addProxyPod(f);
    },
  });
  assert.equal(pauses, 1);
  assert.equal(f.receipts.at(-1).requiredServingOwners, 3);
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.ok(f.calls.every((args) => args[0] === 'get' && args[1] === '--raw'));
});

test('loss of the two-owner floor fails immediately rather than waiting for utilization to fall', async () => {
  const f = proxyFixture();
  f.pods[0].status.conditions[0].status = 'False';
  let pauses = 0;
  const guard = createHaProxyHeadroomGuard(f.options);
  await assert.rejects(
    waitForHaHeadroom(() => guard({ stage: 'retirement' }), {
      timeoutMs: 2000,
      pause: async () => pauses++,
    }),
    /insufficient/,
  );
  assert.equal(pauses, 0);
});

test('a successful observation cannot extend the headroom deadline', async () => {
  let clock = 0;
  await assert.rejects(
    waitForHaHeadroom(
      async () => {
        clock = 2000;
      },
      { timeoutMs: 2000, now: () => clock },
    ),
    /deadline exceeded/,
  );
});

test('proxy surge is not accepted as enduring baseline capacity', async () => {
  const f = proxyFixture();
  f.pods.push({
    ...structuredClone(f.pods[0]),
    metadata: { ...f.pods[0].metadata, name: 'proxy-2', uid: 'proxy-2-uid' },
  });
  f.metrics.push({ ...structuredClone(f.metrics[0]), metadata: { name: 'proxy-2' } });
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '350m';
  await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /insufficient/);
  assert.equal(f.receipts.at(-1).availableServingOwners, 2);
  assert.equal(f.receipts.at(-1).requiredServingOwners, 3);
});

test('proxy missing CPU, stale metrics and foreign ownership fail closed', async () => {
  for (const change of [
    (f) => {
      delete f.pods[0].spec.containers[0].resources.requests.cpu;
    },
    (f) => {
      f.metrics[0].timestamp = new Date(0).toISOString();
    },
    (f) => {
      f.metrics.pop();
    },
    (f) => {
      f.sets[0].metadata.ownerReferences[0].uid = 'foreign';
    },
    (f) => {
      f.pods[1].metadata.uid = f.pods[0].metadata.uid;
    },
  ]) {
    const f = proxyFixture();
    change(f);
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'preflight' }), /headroom is unconfirmed/);
    assert.equal(f.receipts.at(-1).outcome, 'blocked');
  }
});

test('proxy confirms pod and deployment identities after sampling CPU', async () => {
  for (const changed of ['pod', 'deployment']) {
    const f = proxyFixture(),
      kube = f.options.kube;
    let metricRead = false;
    f.options.kube = async (args) => {
      const result = await kube(args);
      if (args[2].includes('/metrics.k8s.io/')) metricRead = true;
      if (metricRead && args[2].split('?')[0].endsWith('/pods')) {
        if (changed === 'pod') f.pods[0].metadata.uid = 'replacement';
        else f.deployment.metadata.uid = 'replacement';
        return kube(args);
      }
      return result;
    };
    await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'preflight' }), /headroom is unconfirmed/);
  }
});

test('proxy headroom rejects additional owners appearing after the sampled inventory', async () => {
  const f = proxyFixture(),
    kube = f.options.kube;
  let podReads = 0;
  f.options.kube = async (args) => {
    if (!args[2].includes('/metrics.k8s.io/') && args[2].split('?')[0].endsWith('/pods') && ++podReads === 2) {
      f.pods.push({
        ...structuredClone(f.pods[0]),
        metadata: {
          ...f.pods[0].metadata,
          name: 'proxy-new',
          uid: 'new-owner-with-unmeasured-demand',
        },
      });
    }
    return kube(args);
  };
  await assert.rejects(createHaProxyHeadroomGuard(f.options)({ stage: 'retirement' }), /headroom is unconfirmed/);
});

test('proxy HPA growth during CPU confirmation waits for a fresh owned sample', async () => {
  for (const scenario of ['growth', 'foreign-owner', 'changed-peer', 'changed-template', 'outside-cap']) {
    const f = proxyFixture(),
      kube = f.options.kube;
    let reads = 0,
      clock = 0,
      pauses = 0;
    f.options.kube = async (args) => {
      if (!args[2].includes('/metrics.k8s.io/') && args[2].split('?')[0].endsWith('/pods') && ++reads === 2) {
        f.deployment.spec.replicas = scenario === 'outside-cap' ? 5 : 3;
        const added = addProxyPod(f);
        if (scenario === 'foreign-owner') added.metadata.ownerReferences[0].uid = 'foreign';
        if (scenario === 'changed-peer') f.pods[0].metadata.uid = 'rebound';
        if (scenario === 'changed-template') f.deployment.spec.template = { unexpected: true };
      }
      return kube(args);
    };
    const guard = createHaProxyHeadroomGuard(f.options);
    const work = waitForHaHeadroom(() => guard({ stage: 'retirement' }), {
      timeoutMs: 2000,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        pauses++;
      },
    });
    if (scenario === 'growth') {
      await work;
      assert.equal(pauses, 1);
      assert.equal(f.receipts.at(-1).availableServingOwners, 3);
    } else {
      await assert.rejects(work, /headroom is unconfirmed/);
      assert.equal(pauses, 0);
    }
    assert.ok(f.calls.every((args) => args[0] === 'get'));
  }
});

test('proxy guard requires zero-unavailable and one-surge policy and no unrelated metrics', async () => {
  const f = proxyFixture();
  f.options.resources[0].spec.strategy.rollingUpdate.maxUnavailable = 1;
  assert.throws(() => createHaProxyHeadroomGuard(f.options), /one-surge policy/);
  await createHaProxyHeadroomGuard({ ...f.options, resources: [] })();
  assert.equal(f.calls.length, 0);
});

test('missing execution scrape waits without parsing it as CPU or accepting a replacement workload', async () => {
  for (const scenario of ['fresh-scrape', 'changed-identity', 'malformed-cpu']) {
    const f = fixture(),
      missing = f.metrics.pop();
    let pauses = 0,
      clock = 0;
    const guard = createHaExecutionHeadroomGuard(f.options);
    const work = waitForHaHeadroom(() => guard({ stage: 'preflight' }), {
      timeoutMs: 2000,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        pauses++;
        if (scenario === 'changed-identity') f.owner.metadata.uid = 'replacement';
        else {
          if (scenario === 'malformed-cpu') missing.containers[0].usage.cpu = 'not-a-quantity';
          f.metrics.push(missing);
        }
      },
    });
    if (scenario === 'fresh-scrape') await work;
    else await assert.rejects(work);
    assert.equal(pauses, 1, 'only missing samples may wait, not malformed data or identity changes');
    assert.ok(f.calls.every((args) => args[0] === 'get' || args[0] === 'exec'));
  }
});

test('stale execution CPU observations can refresh within the original deadline', async () => {
  for (const scenario of [
    'fresh-scrape',
    'stale-forever',
    'changed-identity',
    'malformed-cpu',
    'invalid-time',
    'future-time',
  ]) {
    const f = fixture();
    f.metrics[0].timestamp =
      scenario === 'invalid-time' ? 'invalid' : new Date(scenario === 'future-time' ? 1006000 : 0).toISOString();
    if (scenario === 'malformed-cpu') f.metrics[0].containers[0].usage.cpu = 'invalid';
    let clock = 0,
      pauses = 0;
    const guard = createHaExecutionHeadroomGuard(f.options);
    const work = waitForHaHeadroom(() => guard({ stage: 'preflight' }), {
      timeoutMs: 2000,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        pauses++;
        if (scenario === 'fresh-scrape') f.metrics[0].timestamp = f.metrics[1].timestamp;
        if (scenario === 'changed-identity') f.owner.metadata.uid = 'replaced';
      },
    });
    if (scenario === 'fresh-scrape') {
      await work;
      assert.equal(f.receipts.at(-1).outcome, 'passed');
    } else await assert.rejects(work, /headroom is unconfirmed/);
    assert.equal(
      pauses,
      scenario === 'stale-forever' ? 2 : ['fresh-scrape', 'changed-identity'].includes(scenario) ? 1 : 0,
    );
    assert.ok(f.calls.every((args) => args[0] === 'get' || args[0] === 'exec'));
  }
});

test('CPU freshness expiring during final execution inventory confirmation is reobserved', async () => {
  const f = fixture(),
    kube = f.options.kube;
  let now = 1000000,
    lists = 0,
    pauses = 0,
    clock = 0;
  f.options.now = () => now;
  f.options.kube = async (args) => {
    const result = await kube(args);
    if (args[0] === 'get' && args[2].split('?')[0].endsWith('/pods') && ++lists === 2) now += 90001;
    return result;
  };
  const guard = createHaExecutionHeadroomGuard(f.options);
  await waitForHaHeadroom(() => guard({ stage: 'preflight' }), {
    timeoutMs: 2000,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
      pauses++;
      for (const metric of f.metrics) metric.timestamp = new Date(now).toISOString();
    },
  });
  assert.equal(pauses, 1);
  assert.equal(f.receipts.at(-1).outcome, 'passed');
});

test('replacement CPU scrape delay waits read-only; stale forever, changed identity and insufficient capacity still block', async () => {
  for (const scenario of ['fresh-scrape', 'stale-forever', 'changed-identity', 'insufficient']) {
    const f = proxyFixture();
    const absent = f.metrics.pop();
    const guard = createHaProxyHeadroomGuard(f.options);
    let clock = 0,
      pauses = 0,
      decisions = 0;
    const work = waitForHaHeadroom(
      async () => {
        await guard({ stage: 'retirement' });
        decisions++;
      },
      {
        timeoutMs: 2000,
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
          pauses++;
          if ((scenario === 'fresh-scrape' || scenario === 'insufficient') && !f.metrics.includes(absent))
            f.metrics.push(absent);
          if (scenario === 'changed-identity') f.deployment.metadata.uid = 'replacement';
          if (scenario === 'insufficient') for (const sample of f.metrics) sample.containers[0].usage.cpu = '700m';
        },
      },
    );
    if (scenario === 'fresh-scrape') {
      await work;
      assert.equal(decisions, 1);
    } else {
      await assert.rejects(work);
      assert.equal(decisions, 0);
    }
    assert.equal(pauses, scenario === 'stale-forever' || scenario === 'insufficient' ? 2 : 1);
    assert.ok(f.calls.every((args) => args[0] === 'get' && args[1] === '--raw'));
  }
});
