import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionAutoscalerIO, PendingExecutionCpuSample } from './lib/execution-autoscaler-kubernetes.mjs';
import {
  autoscalerPolicy,
  autoscalerPolicyDigest,
  autoscalerPolicyFromConfig,
  executionPoolLimit,
  executionPoolDemand,
  recommendExecutionReplicas,
  reconcileExecutionAutoscaling,
} from './lib/execution-autoscaler.mjs';

const image = 'registry/api@sha256:fixture';
function fixture(count = 2) {
  const policy = autoscalerPolicy({ maxReplicas: 7 });
  const sampleAt = new Date().toISOString();
  const names = ['execution', 'execution-next'];
  const owners = names.map((name) => ({
    metadata: { name, uid: name + '-uid', resourceVersion: '1', labels: { 'app.kubernetes.io/instance': 'rivet' } },
    spec: {
      replicas: count,
      updateStrategy: { type: 'OnDelete' },
      template: { spec: { containers: [{ name: 'api', image }] } },
    },
  }));
  const pods = owners.flatMap((owner) =>
    Array.from({ length: count }, (_, index) => ({
      metadata: {
        name: owner.metadata.name + '-' + index,
        uid: owner.metadata.name + '-pod-' + index,
        ownerReferences: [
          { controller: true, kind: 'StatefulSet', uid: owner.metadata.uid, name: owner.metadata.name },
        ],
      },
      spec: { containers: [{ name: 'api', resources: { requests: { cpu: '100m' } } }] },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    })),
  );
  const writes = [];
  let active = names[1];
  const transport = {
    json: async (method, url, body) => {
      if (method !== 'GET') {
        writes.push({ method, url, body });
        return { metadata: { resourceVersion: '2' } };
      }
      if (url.includes('/services/'))
        return { metadata: { annotations: { 'rivet.dev/active-execution-workload': active } } };
      if (url.includes('/statefulsets/'))
        return structuredClone(owners.find((owner) => url.endsWith('/' + owner.metadata.name)) ?? null);
      if (url.includes('/metrics.k8s.io/'))
        return {
          items: pods.map((pod) => ({
            metadata: pod.metadata,
            timestamp: sampleAt,
            containers: [{ name: 'api', usage: { cpu: '10m' } }],
          })),
        };
      if (url.endsWith('/horizontalpodautoscalers')) return { items: [] };
      if (url.includes('/pods?')) return { items: structuredClone(pods) };
      if (url.includes('/pods/')) return structuredClone(pods.find((pod) => url.endsWith('/' + pod.metadata.name)));
      throw Error('Unexpected fixture read ' + url);
    },
    exec: async (url, command) =>
      command[1] === '/opt/rivet/retire-backend.mjs'
        ? JSON.stringify({ protocol: 1, withdrawalProtocol: 1, incarnation: url, state: 'serving', operationId: null })
        : 'rivet_published_execution_active_runs 0\nrivet_published_execution_admission_limit{mode="enforce"} 4\n',
  };
  const io = (workload, options = {}) =>
    createExecutionAutoscalerIO({
      transport,
      release: 'rivet',
      namespace: 'fixture',
      workload,
      service: 'execution',
      image,
      policy,
      poolWorkloads: names,
      ...options,
    });
  return {
    policy,
    owners,
    pods,
    writes,
    transport,
    io,
    select: (name) => {
      active = name;
    },
  };
}

for (const count of [2, 3])
  test(`shared ${count}-worker pool observation reduces reads and bounds combined exec concurrency`, async (t) => {
    const f = fixture(count),
      calls = [];
    const original = { ...f.transport };
    let running = 0,
      maximum = 0;
    f.transport.json = async (...args) => {
      calls.push('json');
      await delay(5);
      return original.json(...args);
    };
    f.transport.exec = async (...args) => {
      calls.push('exec');
      running++;
      maximum = Math.max(maximum, running);
      try {
        await delay(5);
        return await original.exec(...args);
      } finally {
        running--;
      }
    };
    const io = f.io('execution-next'),
      before = performance.now();
    const old = { snapshot: await io.snapshot(), peer: await io.peerSnapshot() };
    const oldMs = performance.now() - before,
      oldReads = calls.length;
    calls.length = 0;
    const shared = await io.poolSnapshot();
    assert.deepEqual(shared.snapshot, old.snapshot);
    assert.deepEqual(shared.peer, old.peer);
    assert.equal(oldReads, 13 + 6 * count);
    assert.equal(calls.length, 9 + 4 * count);
    assert.equal(shared.observation.reads, 9);
    assert.equal(shared.observation.execs, 4 * count);
    assert.ok(maximum <= 4);
    assert.equal(running, 0);
    assert.equal(f.writes.length, 0);
    t.diagnostic(
      JSON.stringify({
        count,
        oldReads,
        newReads: calls.length,
        oldMs,
        newMs: shared.observation.elapsedMs,
        delayPerReadMs: 5,
      }),
    );
    // No cache survives a decision, even on the same IO object.
    calls.length = 0;
    await io.poolSnapshot();
    assert.equal(calls.length, 9 + 4 * count);
  });

for (const change of ['readiness', 'uid', 'restart', 'scale', 'hpa'])
  test(`shared pool observation rejects ${change} changes during sampling without writes`, async () => {
    const f = fixture(3);
    f.pods[0].status.containerStatuses = [{ name: 'api', containerID: 'old', restartCount: 0 }];
    const original = { ...f.transport };
    let changed = false;
    f.transport.exec = async (...args) => {
      const result = await original.exec(...args);
      if (!changed) {
        changed = true;
        if (change === 'readiness') f.pods[0].status.conditions[0].status = 'False';
        if (change === 'uid') f.pods[0].metadata.uid = 'replacement';
        if (change === 'restart') f.pods[0].status.containerStatuses[0].restartCount++;
        if (change === 'scale') f.owners[0].spec.replicas++;
      }
      return result;
    };
    f.transport.json = async (...args) =>
      change === 'hpa' && changed && args[1].endsWith('/horizontalpodautoscalers')
        ? { items: [{ spec: { scaleTargetRef: { name: 'execution' } } }] }
        : original.json(...args);
    await assert.rejects(f.io('execution-next').poolSnapshot(), /changed during observation|competing HPA/);
    assert.equal(f.writes.length, 0);
  });

test('shared observation settles started reads on failure and preserves mixed-image peer demand', async () => {
  const f = fixture(3);
  f.owners[0].spec.template.spec.containers[0].image = 'registry/api@sha256:old';
  const original = f.transport.exec;
  let active = 0,
    completed = 0;
  f.transport.exec = async (...args) => {
    active++;
    try {
      await delay(5);
      if (args[0].includes('/execution-0/')) throw Error('fixture read failure');
      return await original(...args);
    } finally {
      active--;
      completed++;
    }
  };
  await assert.rejects(f.io('execution-next').poolSnapshot(), /fixture read failure/);
  assert.equal(active, 0);
  assert.ok(completed > 1);
  f.transport.exec = original;
  const { snapshot, peer } = await f.io('execution-next').poolSnapshot();
  assert.equal(executionPoolDemand(snapshot, peer, f.policy), 2);
});

for (const fault of ['missing', 'stale', 'ages-during-read'])
  test(`shared pool metrics remain fresh across the complete observation (${fault})`, async () => {
    const f = fixture(3),
      original = f.transport.json,
      sampledAt = Date.now();
    let time = sampledAt,
      inventories = 0,
      execs = 0;
    const exec = f.transport.exec;
    f.transport.exec = async (...args) => {
      execs++;
      return exec(...args);
    };
    f.transport.json = async (...args) => {
      const value = await original(...args);
      if (args[1].includes('/metrics.k8s.io/')) {
        if (fault === 'missing') value.items.length = 0;
        if (fault === 'stale')
          for (const metric of value.items)
            metric.timestamp = new Date(sampledAt - (f.policy.metricsMaxAgeSeconds + 1) * 1000).toISOString();
      }
      if (args[1].includes('/pods?') && ++inventories === 2 && fault === 'ages-during-read')
        time += (f.policy.metricsMaxAgeSeconds + 1) * 1000;
      return value;
    };
    await assert.rejects(f.io('execution-next', { now: () => time }).poolSnapshot(), PendingExecutionCpuSample);
    if (fault !== 'ages-during-read') assert.equal(execs, 0, 'Known unavailable CPU metrics need no Pod exec');
    assert.equal(f.writes.length, 0);
  });

test('a terminating peer still consumes physical overlap capacity', async () => {
  const f = fixture();
  const departing = structuredClone(f.pods[0]);
  Object.assign(departing.metadata, {
    name: 'execution-2',
    uid: 'terminating-peer',
    deletionTimestamp: new Date().toISOString(),
  });
  f.pods.push(departing);
  const { snapshot, peer } = await f.io('execution-next').poolSnapshot();
  assert.equal(snapshot.poolCapacity.totalPods, 5);
  assert.equal(snapshot.poolCapacity.otherReplicas, 3);
  assert.equal(peer.pods.find((pod) => pod.uid === departing.metadata.uid).terminating, true);
  assert.throws(() => executionPoolDemand(snapshot, peer, f.policy));
  assert.equal(f.writes.length, 0);
});

test('temporary surge separates physical overlap from steady demand and binds its qualification', () => {
  const old = autoscalerPolicy({ maxReplicas: 7 });
  assert.equal(autoscalerPolicyDigest(old), autoscalerPolicyDigest({ ...old, maxSurgeReplicas: 0 }));
  const policy = autoscalerPolicy({ maxReplicas: 7, maxSurgeReplicas: 7 });
  assert.equal(autoscalerPolicyDigest(policy), autoscalerPolicyDigest(old));
  assert.equal(autoscalerPolicyDigest(policy), 'b20b68bade6e83008baac469bac19464ac36805aea595395f6d3a39f2fb41486');
  assert.deepEqual(autoscalerPolicyFromConfig({ policy: old, maxSurgeReplicas: 7 }), policy);
  assert.throws(() => autoscalerPolicyFromConfig({ policy }), /outside its steady scaling policy/);
  for (const value of [-1, 8, '7', null, true])
    assert.throws(() => autoscalerPolicyFromConfig({ policy: old, maxSurgeReplicas: value }));
  assert.equal(executionPoolLimit(policy), 14);
  for (const surge of [-1, 1.5, 8, '7'])
    assert.throws(() => autoscalerPolicy({ maxReplicas: 7, maxSurgeReplicas: surge }));
  const pod = (_, ordinal) => ({
    name: 'pod-' + ordinal,
    uid: 'uid-' + ordinal,
    ordinal,
    incarnation: 'process',
    ready: true,
    sampleFresh: true,
    state: 'serving',
    active: 4,
    limit: 4,
    cpuRatio: 1,
  });
  const snapshot = { replicas: 7, pods: Array.from({ length: 7 }, pod) };
  const peer = {
    ...snapshot,
    pods: snapshot.pods.map((p) => ({ ...p, name: 'peer-' + p.name, uid: 'peer-' + p.uid })),
  };
  assert.equal(recommendExecutionReplicas(snapshot, policy), 7);
  assert.equal(executionPoolDemand(snapshot, peer, policy), 7);
  assert.throws(() => executionPoolDemand(snapshot, peer, old), /outside approved bounds/);
});

test('pool inventory partitions exact controller UIDs, counts physical peers and fences inactive writes', async () => {
  const f = fixture(),
    io = f.io('execution-next');
  const snapshot = await io.snapshot(),
    peer = await io.peerSnapshot();
  assert.equal(snapshot.pods.length, 2);
  assert.equal(peer.pods.length, 2);
  assert.deepEqual(snapshot.poolCapacity, { otherReplicas: 2, totalPods: 4, otherUid: 'execution-uid' });
  await assert.rejects(f.io('execution').writeJournal({}, undefined), /Inactive execution pool/);
  assert.equal(f.writes.length, 0);
  f.pods[0].metadata.ownerReferences[0].uid = 'foreign';
  await assert.rejects(io.snapshot(), /foreign controller/);
});

for (const totalPods of [4, 7])
  test(`cooperative growth respects both logical and physical capacity (${totalPods} Pods)`, async () => {
    const policy = autoscalerPolicy({ maxReplicas: 7 });
    const pod = (name, index) => ({
      name: name + '-' + index,
      uid: name + '-uid-' + index,
      ordinal: index,
      incarnation: name + index,
      ready: true,
      sampleFresh: true,
      state: 'serving',
      active: 4,
      limit: 4,
      cpuRatio: 0.1,
    });
    const snapshot = {
      uid: 'candidate',
      resourceVersion: '3',
      replicas: 2,
      pods: [pod('new', 0), pod('new', 1)],
      poolCapacity: { totalPods, otherReplicas: 2, otherUid: 'previous' },
    };
    const peer = { uid: 'previous', replicas: 2, pods: [pod('old', 0), pod('old', 1)] };
    const record = {
      protocol: 1,
      release: 'rivet',
      namespace: 'fixture',
      resourceVersion: '2',
      phase: 'owners',
      token: 'token',
      runner: 'deployer',
      manifestDigest: 'manifest',
      leaseExpiresAt: Date.now() + 100000,
      executionPoolPlan: {
        protocol: 1,
        maxReplicas: 7,
        image,
        previous: { name: 'execution', uid: 'previous' },
        candidate: { name: 'execution-next' },
      },
      executionPool: { candidateUid: 'candidate' },
    };
    const scales = [];
    const result = await reconcileExecutionAutoscaling({
      release: 'rivet',
      namespace: 'fixture',
      workload: 'execution-next',
      image,
      manifestDigest: 'manifest',
      runner: 'controller',
      policy,
      io: {
        readJournal: async () => record,
        snapshot: async () => snapshot,
        peerSnapshot: async () => peer,
        scale: async (...args) => {
          scales.push(args);
        },
      },
    });
    assert.equal(result.state, totalPods === 4 ? 'candidate-pool-scaled-up' : 'candidate-pool-observing');
    assert.equal(scales.length, totalPods === 4 ? 1 : 0);
    if (scales.length) assert.equal(scales[0][2], 5);
  });
