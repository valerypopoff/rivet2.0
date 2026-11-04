import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionAutoscalerIO } from './lib/execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicy, reconcileExecutionAutoscaling } from './lib/execution-autoscaler.mjs';

const image = 'registry/api@sha256:fixture';
function fixture() {
  const policy = autoscalerPolicy({ maxReplicas: 7 });
  const names = ['execution', 'execution-next'];
  const owners = names.map((name) => ({
    metadata: { name, uid: name + '-uid', resourceVersion: '1', labels: { 'app.kubernetes.io/instance': 'rivet' } },
    spec: {
      replicas: 2,
      updateStrategy: { type: 'OnDelete' },
      template: { spec: { containers: [{ name: 'api', image }] } },
    },
  }));
  const pods = owners.flatMap((owner) =>
    [0, 1].map((index) => ({
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
            timestamp: new Date().toISOString(),
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
  const io = (workload) =>
    createExecutionAutoscalerIO({
      transport,
      release: 'rivet',
      namespace: 'fixture',
      workload,
      service: 'execution',
      image,
      policy,
      poolWorkloads: names,
    });
  return {
    policy,
    owners,
    pods,
    writes,
    io,
    select: (name) => {
      active = name;
    },
  };
}

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
