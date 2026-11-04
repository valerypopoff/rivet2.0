import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForHaTemplateReadiness } from './lib/ha-template-readiness.mjs';

const component = 'app.kubernetes.io/component';
const instance = 'app.kubernetes.io/instance';
function fixture() {
  const labels = (role) => ({ [instance]: 'rivet', [component]: role });
  const template = (role) => ({
    metadata: { labels: labels(role) },
    spec: {
      containers: [
        {
          name: role,
          image: role + '@sha256:' + 'a'.repeat(64),
          env: [{ name: 'MODE', value: 'candidate' }],
          resources: { requests: { cpu: '100m' } },
        },
      ],
    },
  });
  const worker = {
    kind: 'StatefulSet',
    metadata: { name: 'workers', namespace: 'fixture', labels: labels('execution') },
    spec: { replicas: 2, updateStrategy: { type: 'OnDelete' }, template: template('execution') },
  };
  const controller = {
    kind: 'Deployment',
    metadata: { name: 'controller', namespace: 'fixture', labels: labels('autoscaler') },
    spec: { replicas: 1, template: template('autoscaler') },
  };
  const proxy = {
    kind: 'Deployment',
    metadata: { name: 'proxy', namespace: 'fixture', labels: labels('proxy') },
    spec: { replicas: 2, template: template('proxy') },
  };
  const resources = [
    worker,
    controller,
    proxy,
    {
      kind: 'HorizontalPodAutoscaler',
      spec: { minReplicas: 2, maxReplicas: 4, scaleTargetRef: { kind: 'Deployment', name: 'proxy' } },
    },
  ];
  const items = [];
  function deployment(desired, count) {
    const live = structuredClone(desired);
    Object.assign(live.metadata, { uid: desired.metadata.name + '-uid', generation: 2 });
    live.spec.replicas = count;
    live.status = { observedGeneration: 2, updatedReplicas: count, readyReplicas: count, availableReplicas: count };
    const set = {
      kind: 'ReplicaSet',
      metadata: {
        name: desired.metadata.name + '-rs',
        uid: desired.metadata.name + '-rs-uid',
        ownerReferences: [{ controller: true, kind: 'Deployment', uid: live.metadata.uid }],
      },
    };
    const pods = Array.from({ length: count }, (_, i) => ({
      kind: 'Pod',
      metadata: {
        ...structuredClone(desired.spec.template.metadata),
        name: desired.metadata.name + '-' + i,
        uid: desired.metadata.name + '-' + i,
        ownerReferences: [{ controller: true, kind: 'ReplicaSet', uid: set.metadata.uid }],
      },
      spec: structuredClone(desired.spec.template.spec),
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }));
    items.push(live, set, ...pods);
    return { live, set, pods };
  }
  const stateful = structuredClone(worker);
  Object.assign(stateful.metadata, { uid: 'worker-uid', generation: 2 });
  stateful.status = { observedGeneration: 2, updateRevision: 'candidate' };
  items.push(stateful);
  const scaler = deployment(controller, 1),
    frontend = deployment(proxy, 2);
  let time = 0,
    reads = 0;
  const artifacts = [];
  const options = {
    resources,
    workloads: [{ name: 'workers', uid: 'worker-uid' }],
    release: 'rivet',
    namespace: 'fixture',
    timeoutMs: 3000,
    kube: async (args) => {
      assert.deepEqual(args, ['get', 'statefulset,deployment,replicaset,pod', '-l', instance + '=rivet', '-o', 'json']);
      reads++;
      return { stdout: JSON.stringify({ items }) };
    },
    artifact: async (name, contents) => artifacts.push({ name, ...JSON.parse(contents) }),
    clock: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  };
  return {
    options,
    items,
    stateful,
    scaler,
    frontend,
    artifacts,
    advance: (ms) => {
      time += ms;
    },
    reads: () => reads,
  };
}

test('template prerequisites allow a slow frontend; final join waits for its draining predecessors', async () => {
  const f = fixture();
  const predecessor = structuredClone(f.frontend.pods[0]);
  predecessor.metadata.uid = 'draining-predecessor';
  predecessor.metadata.deletionTimestamp = new Date().toISOString();
  predecessor.spec.containers[0].image = 'old-image';
  f.items.push(predecessor);
  f.frontend.live.status.updatedReplicas = 1;
  await waitForHaTemplateReadiness(f.options);
  assert.equal(f.reads(), 1);
  let waited = false;
  const sleep = f.options.clock.sleep;
  f.options.clock.sleep = async (ms) => {
    waited = true;
    f.frontend.live.status.updatedReplicas = 2;
    f.items.splice(f.items.indexOf(predecessor), 1);
    await sleep(ms);
  };
  await waitForHaTemplateReadiness({ ...f.options, includeFrontends: true });
  assert.equal(waited, true);
  assert.deepEqual(
    f.artifacts.map((a) => a.name),
    ['ha-template-readiness.json', 'ha-frontend-readiness.json'],
  );
});

test('old ready controller Pods cannot acknowledge a candidate controller', async () => {
  const f = fixture();
  f.scaler.pods[0].spec.containers[0].image = 'old';
  const sleep = f.options.clock.sleep;
  f.options.clock.sleep = async (ms) => {
    f.scaler.pods[0].spec = structuredClone(f.scaler.live.spec.template.spec);
    await sleep(ms);
  };
  await waitForHaTemplateReadiness(f.options);
  assert.equal(f.reads(), 2);
});

test('a prior Deployment failure cannot reject a candidate generation the controller has not observed', async () => {
  const f = fixture();
  f.scaler.live.status.observedGeneration = 1;
  f.scaler.live.status.conditions = [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }];
  const sleep = f.options.clock.sleep;
  f.options.clock.sleep = async (ms) => {
    f.scaler.live.status.observedGeneration = f.scaler.live.metadata.generation;
    f.scaler.live.status.conditions = [{ type: 'Progressing', status: 'True' }];
    await sleep(ms);
  };
  await waitForHaTemplateReadiness(f.options);
  assert.equal(f.reads(), 2, 'Require a fresh acknowledgement before accepting the candidate');
});

test('OnDelete acknowledgement waits for observed generation before relying on its revision', async () => {
  const f = fixture();
  f.stateful.status = { observedGeneration: 1, updateRevision: 'old' };
  const sleep = f.options.clock.sleep;
  f.options.clock.sleep = async (ms) => {
    f.stateful.status = { observedGeneration: 2, updateRevision: 'candidate' };
    await sleep(ms);
  };
  await waitForHaTemplateReadiness(f.options);
  assert.equal(f.reads(), 2);
});

test('provider-adjusted requests are accepted, while runtime, identity and disabled-controller changes fail', async () => {
  const f = fixture();
  for (const item of [f.stateful, f.scaler.live, f.scaler.pods[0]])
    item.spec.template
      ? (item.spec.template.spec.containers[0].resources.requests.cpu = '500m')
      : (item.spec.containers[0].resources.requests.cpu = '500m');
  await waitForHaTemplateReadiness(f.options);
  for (const [change, pattern] of [
    [
      (f) => {
        f.stateful.metadata.uid = 'replacement';
      },
      /controller was replaced/,
    ],
    [
      (f) => {
        f.stateful.spec.template.spec.containers[0].env[0].value = 'foreign';
      },
      /template application/,
    ],
    [
      (f) => {
        f.scaler.live.spec.replicas = 0;
      },
      /capacity is outside/,
    ],
    [
      (f) => {
        f.scaler.live.metadata.namespace = 'foreign';
      },
      /foreign/,
    ],
    [
      (f) => {
        f.scaler.live.status.conditions = [{ type: 'Progressing', status: 'False' }];
      },
      /controller rollout failed/,
    ],
    [
      (f) => {
        f.options.resources.find((r) => r.metadata?.name === 'controller').spec.minReadySeconds = 120;
      },
      /stabilization was shortened/,
    ],
  ]) {
    const broken = fixture();
    change(broken);
    await assert.rejects(waitForHaTemplateReadiness(broken.options), pattern);
    assert.deepEqual(broken.artifacts, []);
  }
});

test('foreign controller Pods, timeout, lost lease and late reads cannot acknowledge readiness', async () => {
  const f = fixture();
  f.scaler.set.metadata.ownerReferences[0].uid = 'foreign-controller';
  await assert.rejects(waitForHaTemplateReadiness(f.options), /Timed out/);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.artifacts, []);
  const late = fixture(),
    read = late.options.kube;
  late.options.kube = async (args) => {
    const value = await read(args);
    late.advance(3000);
    return value;
  };
  await assert.rejects(waitForHaTemplateReadiness(late.options), /exceeded its deadline/);
  const lease = fixture();
  let assertions = 0;
  lease.options.assertLease = () => {
    if (++assertions === 2) throw Error('Lease lost');
  };
  await assert.rejects(waitForHaTemplateReadiness(lease.options), /Lease lost/);
  const denied = fixture();
  denied.options.kube = async () => {
    throw Error('Read denied');
  };
  await assert.rejects(waitForHaTemplateReadiness(denied.options), /Read denied/);
});

test('final frontend join accepts HPA growth within its bounds and rechecks controller identity', async () => {
  const f = fixture();
  const identities = new Map();
  await waitForHaTemplateReadiness({ ...f.options, identities });
  f.frontend.live.spec.replicas = 4;
  Object.assign(f.frontend.live.status, { updatedReplicas: 4, readyReplicas: 4, availableReplicas: 4 });
  f.items.push(
    ...[2, 3].map((i) => {
      const p = structuredClone(f.frontend.pods[0]);
      p.metadata.uid = 'proxy-' + i;
      return p;
    }),
  );
  await waitForHaTemplateReadiness({ ...f.options, includeFrontends: true, identities });
  f.scaler.live.metadata.uid = 'replaced';
  await assert.rejects(
    waitForHaTemplateReadiness({ ...f.options, includeFrontends: true, identities }),
    /controller was replaced/,
  );
  f.scaler.live.metadata.uid = 'controller-uid';
  f.frontend.live.spec.replicas = 5;
  await assert.rejects(waitForHaTemplateReadiness({ ...f.options, includeFrontends: true }), /capacity is outside/);
});
