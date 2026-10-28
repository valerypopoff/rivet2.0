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

test('headroom accounts for the departing owner and all accepted work', () => {
  const sample = snapshot();
  let result = assessHaExecutionHeadroom(sample, policy, sample.pods[2]);
  assert.equal(result.availableServingOwners, 2);
  assert.equal(result.sufficient, true);
  sample.pods[2].active = 20;
  Object.assign(sample.pods[2], { state: 'withdrawing', ready: false, operationId: 'owned' });
  result = assessHaExecutionHeadroom(sample, policy, sample.pods[2]);
  assert.equal(result.activeSlots, 24);
  assert.equal(result.requiredServingOwners, 4);
  assert.equal(result.sufficient, false);
  assert.equal(result.spareOwnersAtTarget, -2);
});

test('CPU demand and overload beyond the autoscaler maximum cannot be hidden by clamping', () => {
  const sample = snapshot(8);
  for (const pod of sample.pods) pod.cpuRatio = 3;
  const result = assessHaExecutionHeadroom(sample, policy);
  assert.equal(result.requiredServingOwners, 32);
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

function fixture() {
  const now = 1_000_000;
  const oldImage = `api@sha256:${'a'.repeat(64)}`,
    candidate = `api@sha256:${'b'.repeat(64)}`;
  const workload = { name: 'execution', uid: 'workload-uid', role: 'execution', replicas: 2, image: candidate };
  const owner = {
    metadata: { name: 'execution', uid: workload.uid, labels: { 'app.kubernetes.io/instance': 'rivet' } },
    spec: {
      replicas: 2,
      updateStrategy: { type: 'OnDelete' },
      template: {
        spec: { containers: [{ name: 'api', image: oldImage }] },
      },
    },
  };
  const initial = structuredClone(owner);
  const pods = snapshot(2).pods.map((pod) => ({
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
        stdout: `rivet_published_execution_active_runs ${active}\nrivet_published_execution_admission_limit{mode="enforce"} 10\n`,
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
  f.setActive(7);
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

test('profiles without the execution controller do not acquire an unrelated metrics dependency', async () => {
  const f = fixture();
  await createHaExecutionHeadroomGuard({ ...f.options, resources: [] })({ stage: 'preflight' });
  assert.equal(f.calls.length, 0);
});

function proxyFixture() {
  const now = 1_000_000,
    receipts = [],
    calls = [];
  const labels = { 'app.kubernetes.io/instance': 'rivet', 'app.kubernetes.io/component': 'proxy' };
  const deployment = {
    kind: 'Deployment',
    metadata: { name: 'proxy', uid: 'proxy-uid', labels },
    spec: {
      replicas: 2,
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
  const pods = Array.from({ length: 2 }, (_, ordinal) => ({
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

test('proxy headroom uses current CPU demand rather than HPA desired replicas', async () => {
  const f = proxyFixture(),
    guard = createHaProxyHeadroomGuard(f.options);
  await guard({ stage: 'preflight' });
  assert.equal(f.receipts.at(-1).outcome, 'passed');
  assert.equal(f.receipts.at(-1).availableServingOwners, 2);
  assert.equal(f.receipts.at(-1).totalCpuCores, 0.2);
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '700m';
  await assert.rejects(guard({ stage: 'retirement' }), /proxy headroom is insufficient/);
  assert.equal(f.receipts.at(-1).requiredServingOwners, 4);
  assert.equal(f.receipts.at(-1).autoscalingFrozen, false);
  assert.equal(f.receipts.at(-1).scaleDownPaused, true);
});

test('proxy surge is not accepted as enduring baseline capacity', async () => {
  const f = proxyFixture();
  f.pods.push({
    ...structuredClone(f.pods[0]),
    metadata: { ...f.pods[0].metadata, name: 'proxy-2', uid: 'proxy-2-uid' },
  });
  f.metrics.push({ ...structuredClone(f.metrics[0]), metadata: { name: 'proxy-2' } });
  for (const sample of f.metrics) sample.containers[0].usage.cpu = '300m';
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
          if (scenario === 'fresh-scrape' || scenario === 'insufficient') f.metrics.push(absent);
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
    assert.equal(pauses, scenario === 'stale-forever' ? 2 : 1);
    assert.ok(f.calls.every((args) => args[0] === 'get' && args[1] === '--raw'));
  }
});
