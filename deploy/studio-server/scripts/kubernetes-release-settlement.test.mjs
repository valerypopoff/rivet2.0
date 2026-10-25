import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectReleaseSettlement,
  waitForReleaseSettlement,
  waitForExecutionAutoscalerActivation,
} from './lib/kubernetes-release-settlement.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';

const release = 'rivet';
const namespace = 'fixture';
const instance = 'app.kubernetes.io/instance';
const component = 'app.kubernetes.io/component';
const clone = structuredClone;
const ref = (resource) => ({
  kind: resource.kind,
  name: resource.metadata.name,
  uid: resource.metadata.uid,
  controller: true,
});
function fixture({ kind = 'StatefulSet', replicas = 2, rendered = 2, name = 'execution', automatic = false } = {}) {
  const labels = { [instance]: release, [component]: name };
  const candidate = {
    apiVersion: 'apps/v1',
    kind,
    metadata: { name, labels },
    spec: {
      replicas: rendered,
      selector: { matchLabels: labels },
      ...(kind === 'StatefulSet' ? { updateStrategy: { type: 'OnDelete' } } : {}),
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'rivet@sha256:candidate',
              env: [{ name: 'PRIVATE_SETTING', value: 'do-not-disclose-this' }],
            },
          ],
          initContainers: [{ name: 'prepare', image: 'rivet@sha256:candidate' }],
        },
      },
    },
  };
  const controller = clone(candidate);
  Object.assign(controller.metadata, {
    namespace,
    uid: `${name}-controller`,
    generation: 4,
    annotations: { 'deployment.kubernetes.io/revision': '8' },
  });
  controller.status = {
    observedGeneration: 4,
    replicas,
    readyReplicas: replicas,
    updatedReplicas: replicas,
    availableReplicas: replicas,
    updateRevision: `${name}-revision-8`,
  };
  controller.spec.replicas = replicas;
  const replicaSet = {
    kind: 'ReplicaSet',
    metadata: {
      name: `${name}-hash8`,
      namespace,
      uid: `${name}-rs8`,
      labels: { ...labels, 'pod-template-hash': 'hash8' },
      ownerReferences: [ref(controller)],
      annotations: { 'deployment.kubernetes.io/revision': '8' },
    },
    spec: { replicas, template: clone(candidate.spec.template) },
  };
  const pods = Array.from({ length: replicas }, (_, index) => ({
    kind: 'Pod',
    metadata: {
      name: `${name}-${index}`,
      namespace,
      uid: `${name}-pod-${index}`,
      labels: { ...labels, 'controller-revision-hash': `${name}-revision-8`, 'pod-template-hash': 'hash8' },
      ownerReferences: [ref(kind === 'StatefulSet' ? controller : replicaSet)],
    },
    spec: clone(candidate.spec.template.spec),
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  }));
  const resources = [candidate];
  const hpa = {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name, labels },
    spec: {
      minReplicas: 2,
      maxReplicas: 7,
      scaleTargetRef: { apiVersion: 'apps/v1', kind, name },
      metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } } },
      ],
    },
  };
  const items = [controller, ...(kind === 'Deployment' ? [replicaSet] : []), ...pods];
  const liveHpa = clone(hpa);
  Object.assign(liveHpa.metadata, { namespace, uid: `${name}-hpa`, generation: 2 });
  liveHpa.status = {
    observedGeneration: 2,
    conditions: [
      { type: 'AbleToScale', status: 'True' },
      { type: 'ScalingActive', status: 'True' },
    ],
  };
  if (automatic) {
    resources.push(hpa);
    items.push(liveHpa);
  }
  return { resources, items, controller, candidate, replicaSet, pods, hpa, liveHpa, release, namespace };
}
const inspect = (state) => inspectReleaseSettlement(state);

function withExecutionAutoscaler(state = fixture({ replicas: 5 })) {
  const autoscaler = fixture({ kind: 'Deployment', replicas: 1, rendered: 1, name: 'autoscaler' });
  const config = {
    release,
    namespace,
    workload: 'execution',
    manifestDigest: 'sha256:release',
    policy: { minReplicas: 2, maxReplicas: 7 },
  };
  for (const template of [
    autoscaler.candidate.spec.template,
    autoscaler.controller.spec.template,
    autoscaler.replicaSet.spec.template,
    ...autoscaler.pods,
  ])
    template.spec.containers[0].env.push({ name: 'RIVET_AUTOSCALER_CONFIG', value: JSON.stringify(config) });
  state.resources.push(...autoscaler.resources);
  state.items.push(...autoscaler.items);
  return { ...state, autoscaler, config };
}

test('accepts exact candidate controllers and revision-owned pods without exposing configuration', () => {
  for (const kind of ['Deployment', 'StatefulSet']) {
    const report = inspect(fixture({ kind }));
    assert.equal(report.settled, true, report.pending.join('\n'));
    assert.equal(report.workloads[0].desiredReplicas, 2);
    assert.equal(JSON.stringify(report).includes('do-not-disclose-this'), false);
  }
});

test('honors live HPA desired capacity above the rendered idle baseline', () => {
  for (const kind of ['Deployment', 'StatefulSet']) {
    const report = inspect(fixture({ kind, replicas: 5, rendered: 2, automatic: true }));
    assert.equal(report.settled, true, report.pending.join('\n'));
    assert.equal(report.workloads[0].desiredReplicas, 5);
  }
});

test('honors custom execution autoscaling while retaining fixed developer capacity', () => {
  const state = withExecutionAutoscaler();
  assert.equal(inspect(state).settled, true);
  state.controller.spec.replicas = 0;
  assert.match(inspect(state).pending.join('\n'), /outside the rendered capacity policy/);
});

test('topology settlement permits only its exact retained execution revision, controller and pod UIDs', () => {
  const state = fixture();
  const retainedExecution = [
    {
      name: state.controller.metadata.name,
      uid: state.controller.metadata.uid,
      revision: state.controller.status.updateRevision,
      replicas: 2,
      pods: state.pods.map((p) => p.metadata.uid),
    },
  ];
  state.controller.status.updateRevision = 'new-control-mode-revision';
  state.controller.status.updatedReplicas = 0;
  assert.equal(inspect(state).settled, false, 'ordinary upgrades must still require the current revision');
  assert.equal(inspectReleaseSettlement({ ...state, retainedExecution }).settled, true);
  for (const mutate of [
    (s) => {
      s.pods[0].metadata.uid = 'replacement';
    },
    (s) => {
      s.pods[0].metadata.labels['controller-revision-hash'] = 'unexpected';
    },
    (s) => {
      s.controller.metadata.uid = 'replacement';
    },
    (s) => {
      s.controller.spec.replicas = 3;
    },
    (s) => {
      s.pods[0].spec.containers[0].image = 'different';
    },
    (s) => {
      s.pods[0].status.conditions[0].status = 'False';
    },
  ]) {
    const changed = clone(state);
    mutate(changed);
    assert.equal(inspectReleaseSettlement({ ...changed, retainedExecution }).settled, false);
  }
  assert.throws(
    () => inspectReleaseSettlement({ ...state, retainedExecution: [{ ...retainedExecution[0], pods: [] }] }),
    /identity is incomplete/,
  );
});

test('requires installed HPA identity, exact policy and healthy scaling conditions', () => {
  for (const change of [
    (state) => {
      state.items.splice(state.items.indexOf(state.liveHpa), 1);
    },
    (state) => {
      state.liveHpa.spec.scaleTargetRef.name = 'other';
    },
    (state) => {
      state.liveHpa.spec.minReplicas = 1;
    },
    (state) => {
      state.liveHpa.spec.maxReplicas = 8;
    },
    (state) => {
      state.liveHpa.spec.metrics[0].resource.target.averageUtilization = 90;
    },
    (state) => {
      state.liveHpa.spec.behavior = { scaleDown: { selectPolicy: 'Disabled' } };
    },
    (state) => {
      state.liveHpa.status.observedGeneration = 1;
    },
    (state) => {
      state.liveHpa.status.conditions = [];
    },
    (state) => {
      state.liveHpa.status.conditions[0].status = 'False';
    },
    (state) => {
      state.liveHpa.status.conditions[1].status = 'False';
    },
    (state) => {
      state.liveHpa.status.conditions[1].observedGeneration = 1;
    },
    (state) => {
      state.liveHpa.metadata.labels[instance] = 'other';
    },
    (state) => {
      state.liveHpa.metadata.deletionTimestamp = '2026-10-23T00:00:00Z';
    },
  ]) {
    const state = fixture({ automatic: true });
    change(state);
    const report = inspect(state);
    assert.equal(report.settled, false, change.toString());
    assert.match(report.pending.join('\n'), /HPA/);
  }
});

test('supports clusters without the optional HPA observed-generation feature', () => {
  const state = fixture({ automatic: true });
  delete state.liveHpa.status.observedGeneration;
  assert.equal(inspect(state).settled, true);
});

test('normalizes HPA API defaults without hiding an explicit downscale-window difference', () => {
  const state = fixture({ automatic: true });
  state.liveHpa.spec.behavior = {
    scaleUp: {
      stabilizationWindowSeconds: 0,
      selectPolicy: 'Max',
      policies: [
        { type: 'Percent', value: 100, periodSeconds: 15 },
        { type: 'Pods', value: 4, periodSeconds: 15 },
      ],
    },
    scaleDown: { selectPolicy: 'Max', policies: [{ type: 'Percent', value: 100, periodSeconds: 15 }] },
  };
  assert.equal(inspect(state).settled, true);
  state.liveHpa.spec.behavior.scaleDown.stabilizationWindowSeconds = 300;
  assert.match(inspect(state).pending.join('\n'), /installed HPA target or policy/);
  state.hpa.spec.behavior = { scaleDown: { stabilizationWindowSeconds: 300 } };
  assert.equal(inspect(state).settled, true);
});

test('unexpected HPAs cannot compete for owned targets even without release labels', () => {
  const state = fixture();
  state.liveHpa.metadata.labels = {};
  state.items.push(state.liveHpa);
  assert.match(inspect(state).pending.join('\n'), /unexpected HPA may compete/);
  state.liveHpa.spec.scaleTargetRef.name = 'unrelated';
  assert.equal(inspect(state).settled, true);
});

test('custom controller and its running pod must use the rendered literal policy and target', () => {
  for (const target of ['controller', 'pod']) {
    for (const change of [
      (binding) => {
        const config = JSON.parse(binding.value);
        config.workload = 'other';
        binding.value = JSON.stringify(config);
      },
      (binding) => {
        const config = JSON.parse(binding.value);
        config.policy.maxReplicas = 20;
        binding.value = JSON.stringify(config);
      },
      (binding) => {
        const config = JSON.parse(binding.value);
        config.manifestDigest = 'old';
        binding.value = JSON.stringify(config);
      },
      (binding) => {
        binding.valueFrom = { secretKeyRef: { name: 'secret', key: 'key' } };
      },
      (binding) => {
        binding.value = '{invalid-json';
      },
    ]) {
      const state = withExecutionAutoscaler();
      const template = target === 'controller' ? state.autoscaler.controller.spec.template : state.autoscaler.pods[0];
      change(template.spec.containers[0].env.find((entry) => entry.name === 'RIVET_AUTOSCALER_CONFIG'));
      assert.match(inspect(state).pending.join('\n'), /autoscaler configuration differs/, `${target}: ${change}`);
    }
  }
  const state = withExecutionAutoscaler();
  state.autoscaler.controller.spec.replicas = 0;
  assert.match(inspect(state).pending.join('\n'), /outside the rendered capacity policy/);
  state.autoscaler.candidate.spec.replicas = 0;
  assert.throws(() => inspect(state), /autoscaler must be active/);
});

test('rejects unconfigured scaling or capacity beyond an autoscaling range', () => {
  assert.match(inspect(fixture({ replicas: 3 })).pending.join('\n'), /capacity policy/);
  assert.match(inspect(fixture({ replicas: 8, automatic: true })).pending.join('\n'), /capacity policy/);
});

test('does not accept partial Helm completion, stale observations or controller rollout failures', () => {
  for (const change of [
    (state) => {
      state.controller.status.readyReplicas = 1;
    },
    (state) => {
      state.controller.status.updatedReplicas = 1;
    },
    (state) => {
      state.controller.status.observedGeneration = 3;
    },
    (state) => {
      state.controller.status.conditions = [{ type: 'Progressing', status: 'False' }];
    },
    (state) => {
      state.controller.status.conditions = [{ type: 'ReplicaFailure', status: 'True' }];
    },
    (state) => {
      state.pods[0].status.conditions = [{ type: 'Ready', status: 'False' }];
    },
    (state) => {
      state.items.splice(state.items.indexOf(state.controller), 1);
    },
  ]) {
    const state = fixture({ kind: 'Deployment' });
    change(state);
    assert.equal(inspect(state).settled, false);
  }
});

test('requires frontend availability as well as readiness', () => {
  const state = fixture({ kind: 'Deployment' });
  state.controller.status.availableReplicas = 1;
  assert.match(inspect(state).pending.join('\n'), /not yet available/);
});

test('rejects old images in either controller, pod or init container', () => {
  for (const change of [
    (state) => {
      state.controller.spec.template.spec.containers[0].image = 'old';
    },
    (state) => {
      state.pods[0].spec.containers[0].image = 'old';
    },
    (state) => {
      state.pods[0].spec.initContainers[0].image = 'old';
    },
    (state) => {
      state.pods[0].spec.initContainers = [];
    },
  ]) {
    const state = fixture();
    change(state);
    assert.match(inspect(state).pending.join('\n'), /candidate images/);
  }
});

test('permits admission-injected sidecars while checking all declared images', () => {
  const state = fixture();
  state.pods[0].spec.containers.push({ name: 'vault-agent', image: 'vault:approved' });
  state.pods[0].spec.initContainers.push({ name: 'vault-agent-init', image: 'vault:approved' });
  assert.equal(inspect(state).settled, true);
});

test('OnDelete owners must adopt the updateRevision even when the image did not change', () => {
  const state = fixture();
  state.pods[0].metadata.labels['controller-revision-hash'] = 'previous-config';
  assert.match(inspect(state).pending.join('\n'), /desired StatefulSet revision/);
});

test('Deployment pods must belong to the current revision and ReplicaSet hash', () => {
  for (const change of [
    (state) => {
      state.replicaSet.metadata.annotations['deployment.kubernetes.io/revision'] = '7';
    },
    (state) => {
      state.pods[0].metadata.labels['pod-template-hash'] = 'old';
    },
    (state) => {
      state.replicaSet.spec.template.spec.containers[0].image = 'old';
    },
  ]) {
    const state = fixture({ kind: 'Deployment' });
    change(state);
    assert.match(inspect(state).pending.join('\n'), /desired Deployment revision/);
  }
});

test('terminating, failed and superseded workload pods prevent completion', () => {
  for (const change of [
    (state) => {
      state.pods[0].metadata.deletionTimestamp = '2026-10-23T00:00:00Z';
    },
    (state) => {
      state.pods[0].status.phase = 'Failed';
    },
    (state) => {
      const old = clone(state.pods[0]);
      old.metadata.name = 'old';
      old.metadata.uid = 'old';
      state.items.push(old);
    },
  ]) {
    const state = fixture();
    change(state);
    assert.equal(inspect(state).settled, false);
  }
});

test('foreign owner UIDs and release identities cannot impersonate expected workloads', () => {
  for (const change of [
    (state) => {
      state.pods[0].metadata.ownerReferences[0].uid = 'foreign';
    },
    (state) => {
      state.controller.metadata.labels[instance] = 'other';
    },
    (state) => {
      delete state.pods[0].metadata.labels[instance];
    },
  ]) {
    const state = fixture();
    change(state);
    assert.equal(inspect(state).settled, false);
  }
  const state = fixture({ kind: 'Deployment' });
  state.replicaSet.metadata.ownerReferences[0].uid = 'foreign';
  assert.match(inspect(state).pending.join('\n'), /no expected deployment owner/);
});

test('unexpected release controllers and orphan pods block settlement, unrelated namespace resources do not', () => {
  const state = fixture();
  const other = fixture({ kind: 'Deployment', name: 'temporary' });
  state.items.push(...other.items);
  assert.match(inspect(state).pending.join('\n'), /unexpected release controller/);
  state.items = state.items.filter((item) => !other.items.includes(item));
  const orphan = clone(state.pods[0]);
  orphan.metadata.name = 'unknown';
  orphan.metadata.uid = 'unknown';
  orphan.metadata.ownerReferences = [];
  state.items.push(orphan);
  assert.match(inspect(state).pending.join('\n'), /unexpected or superseded release pod/);
  orphan.metadata.labels[instance] = 'another-release';
  assert.equal(inspect(state).settled, true);
});

test('old zero-replica ReplicaSets owned by the expected Deployment are harmless', () => {
  const state = fixture({ kind: 'Deployment' });
  const old = clone(state.replicaSet);
  old.metadata.name = 'old-replica-set';
  old.metadata.uid = 'old-rs';
  old.spec.replicas = 0;
  old.metadata.annotations['deployment.kubernetes.io/revision'] = '7';
  state.items.push(old);
  assert.equal(inspect(state).settled, true);
  old.spec.replicas = 1;
  assert.match(inspect(state).pending.join('\n'), /superseded ReplicaSet/);
});

test('allows terminal schema migration history only through its actual Job owner', () => {
  const state = fixture();
  const job = {
    kind: 'Job',
    metadata: {
      name: 'schema',
      uid: 'schema-job',
      namespace,
      labels: { [instance]: release, [component]: 'workflow-schema-migration' },
    },
    status: { conditions: [{ type: 'Complete', status: 'True' }] },
  };
  const pod = {
    kind: 'Pod',
    metadata: {
      name: 'schema-pod',
      uid: 'schema-pod',
      namespace,
      labels: job.metadata.labels,
      ownerReferences: [ref(job)],
    },
    status: { phase: 'Succeeded' },
  };
  state.items.push(job, pod);
  assert.equal(inspect(state).settled, true);
  pod.metadata.ownerReferences[0].uid = 'foreign';
  assert.equal(inspect(state).settled, false);
  pod.metadata.ownerReferences[0].uid = job.metadata.uid;
  job.status.conditions = [];
  assert.match(inspect(state).pending.join('\n'), /migration has not finished/);
});

function simulation(snapshots, options = {}) {
  let time = 0;
  let reads = 0;
  const artifacts = [];
  const first = snapshots[0];
  return {
    artifacts,
    get time() {
      return time;
    },
    get reads() {
      return reads;
    },
    run: () =>
      waitForReleaseSettlement({
        resources: first.resources,
        release,
        namespace,
        timeoutMs: 6_000,
        stableMs: 2_000,
        clock: {
          now: () => time,
          sleep: async (ms) => {
            time += ms;
          },
        },
        kube: async (args) => {
          assert.equal(args[0], 'get');
          assert.ok(args.includes(namespace));
          return { stdout: JSON.stringify({ items: snapshots[Math.min(reads++, snapshots.length - 1)].items }) };
        },
        artifact: async (name, content) => artifacts.push({ name, report: JSON.parse(content) }),
        ...options,
      }),
  };
}

test('waiter does not return on partial Helm success and records only sanitized stable settlement', async () => {
  const initial = fixture();
  initial.pods[0].status.conditions[0].status = 'False';
  const runner = simulation([initial, fixture()]);
  const report = await runner.run();
  assert.equal(runner.time, 3_000);
  assert.equal(report.stableMs, 2_000);
  assert.equal(runner.artifacts[0].name, 'release-settlement.json');
  assert.equal(JSON.stringify(runner.artifacts).includes('do-not-disclose-this'), false);
});

test('healthy pod replacement restarts stability observation instead of permanently rejecting it', async () => {
  const replacement = fixture();
  replacement.pods[0].metadata.uid = 'replacement';
  const runner = simulation([fixture(), replacement]);
  await runner.run();
  assert.equal(runner.time, 3_000);
});

test('legitimate scale-up restarts the stable window and settles at the higher capacity', async () => {
  const runner = simulation([fixture({ automatic: true }), fixture({ automatic: true, replicas: 4 })]);
  const report = await runner.run();
  assert.equal(runner.time, 3_000);
  assert.equal(report.workloads[0].desiredReplicas, 4);
});

test('timeouts retain a clear sanitized failure receipt without mutating workloads', async () => {
  const state = fixture();
  state.pods[0].metadata.labels['controller-revision-hash'] = 'previous';
  const runner = simulation([state], { timeoutMs: 2_000 });
  await assert.rejects(runner.run(), /settlement timed out: .*desired StatefulSet revision/);
  assert.equal(runner.artifacts.length, 2);
  assert.equal(runner.artifacts.at(-1).report.settled, false);
});

test('a healthy snapshot cannot produce a settled receipt before the stability window ends', async () => {
  const runner = simulation([fixture()], { timeoutMs: 1_000, stableMs: 2_000 });
  await assert.rejects(runner.run(), /not remained stable long enough/);
  assert.equal(runner.artifacts.at(-1).report.healthy, true);
  assert.equal(runner.artifacts.at(-1).report.settled, false);
});

test('replacement HPA identity resets the stable window', async () => {
  const first = fixture({ automatic: true });
  const second = fixture({ automatic: true });
  second.liveHpa.metadata.uid = 'replacement-hpa';
  const runner = simulation([first, second]);
  await runner.run();
  assert.equal(runner.time, 3_000);
});

test('a stalled management read cannot count a blind interval as continuous settlement', async () => {
  const state = fixture();
  let time = 0;
  let reads = 0;
  const report = await waitForReleaseSettlement({
    resources: state.resources,
    release,
    namespace,
    timeoutMs: 70_000,
    stableMs: 30_000,
    clock: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
    kube: async () => {
      if (++reads === 2) time += 30_000;
      return { stdout: JSON.stringify({ items: state.items }) };
    },
  });
  assert.equal(time, 61_000);
  assert.equal(report.stableMs, 30_000);
  assert.ok(reads > 2);
});

test('a healthy inventory returned after the deadline cannot produce successful settlement', async () => {
  const state = fixture();
  let time = 0;
  let reads = 0;
  const receipts = [];
  await assert.rejects(
    waitForReleaseSettlement({
      resources: state.resources,
      release,
      namespace,
      timeoutMs: 1_500,
      stableMs: 1_000,
      clock: {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
      kube: async () => {
        if (++reads === 2) time += 1_000;
        return { stdout: JSON.stringify({ items: state.items }) };
      },
      artifact: async (_name, content) => receipts.push(JSON.parse(content)),
    }),
    /settlement timed out/,
  );
  assert.equal(receipts.length, 2);
  assert.equal(receipts.at(-1).healthy, true);
  assert.equal(receipts.at(-1).settled, false);
});

test('a clock reversal restarts stable observation and a failed inventory cannot complete it', async () => {
  const state = fixture();
  let time = 0;
  let reads = 0;
  const report = await waitForReleaseSettlement({
    resources: state.resources,
    release,
    namespace,
    timeoutMs: 10_000,
    stableMs: 3_000,
    clock: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
    kube: async () => {
      if (++reads === 3) time = 500;
      return { stdout: JSON.stringify({ items: state.items }) };
    },
  });
  assert.equal(time, 3_500);
  assert.equal(report.stableMs, 3_000);

  let failedReads = 0;
  let receipts = 0;
  await assert.rejects(
    waitForReleaseSettlement({
      resources: state.resources,
      release,
      namespace,
      timeoutMs: 10_000,
      stableMs: 3_000,
      clock: {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
      kube: async () => {
        if (++failedReads === 2) throw new Error('inventory unavailable');
        return { stdout: JSON.stringify({ items: state.items }) };
      },
      artifact: async () => {
        receipts += 1;
      },
    }),
    /inventory unavailable/,
  );
  assert.equal(receipts, 1);
});

test('a new settlement attempt clears prior success before a failed read or parse', async () => {
  for (const failure of ['read', 'parse']) {
    const state = fixture();
    const files = new Map([['release-settlement.json', JSON.stringify({ settled: true, observedAt: 'old-attempt' })]]);
    let attempts = 0;
    await assert.rejects(
      waitForReleaseSettlement({
        resources: state.resources,
        release,
        namespace,
        timeoutMs: 5_000,
        stableMs: 2_000,
        clock: { now: () => 100_000, sleep: async () => assert.fail('must not retry a failed inventory') },
        artifact: async (name, content) => files.set(name, content),
        kube: async () => {
          attempts += 1;
          const receipt = JSON.parse(files.get('release-settlement.json'));
          assert.equal(receipt.settled, false, 'old success must be overwritten before the first read');
          assert.equal(receipt.healthy, false);
          if (failure === 'read') throw new Error('private provider error');
          return { stdout: '{private malformed inventory' };
        },
      }),
      failure === 'read' ? /private provider error/ : /Could not parse release settlement inventory/,
    );
    const receipt = JSON.parse(files.get('release-settlement.json'));
    assert.equal(attempts, 1);
    assert.equal(receipt.settled, false);
    assert.match(receipt.pending.join('; '), /in progress/);
    assert.equal(files.get('release-settlement.json').includes('private'), false);
  }
});

function activationSimulation(change = () => {}, options = {}) {
  const state = withExecutionAutoscaler();
  let time = 100_000;
  let reads = 0;
  const artifacts = [];
  return {
    artifacts,
    get reads() {
      return reads;
    },
    get time() {
      return time;
    },
    run: () =>
      waitForExecutionAutoscalerActivation({
        resources: state.resources,
        release,
        namespace,
        timeoutMs: 3_000,
        after: 100_000,
        clock: {
          now: () => time,
          sleep: async (ms) => {
            time += ms;
          },
        },
        kube: async (args) => {
          assert.deepEqual(args, [
            'get',
            'configmap',
            releaseOperationJournalName(release),
            '--namespace',
            namespace,
            '--ignore-not-found',
            '-o',
            'json',
          ]);
          const record = {
            autoscalingProtocol: 1,
            release,
            namespace,
            manifestDigest: state.config.manifestDigest,
            policyDigest: autoscalerPolicyDigest(state.config.policy),
            phase: 'complete',
            runner: 'controller',
            token: 'token',
            leaseExpiresAt: 0,
            lastSampleAt: time,
            lastScaleAt: 0,
          };
          const cm = {
            kind: 'ConfigMap',
            metadata: {
              name: releaseOperationJournalName(release),
              namespace,
              labels: { [instance]: release },
              uid: 'journal-uid',
              resourceVersion: String(++reads),
            },
          };
          change(record, cm, reads, time);
          cm.data = { record: JSON.stringify(record) };
          return { stdout: JSON.stringify(cm) };
        },
        artifact: async (name, content) => artifacts.push({ name, report: JSON.parse(content) }),
        ...options,
      }),
  };
}

test('activation waits for a fresh completed tick after the deployment journal lease is released', async () => {
  const runner = activationSimulation((record, cm, reads) => {
    if (reads === 1) {
      delete record.autoscalingProtocol;
      record.protocol = 1;
      record.leaseExpiresAt = 120_000;
    }
  });
  const report = await runner.run();
  assert.equal(report.activated, true);
  assert.equal(runner.reads, 2);
  assert.equal(report.elapsedMs, 1_000);
  assert.equal(runner.artifacts[0].name, 'execution-autoscaler-activation.json');
  assert.equal(JSON.stringify(runner.artifacts).includes('do-not-disclose-this'), false);
});

test('activation accepts a fresh completed scale-up tick without requiring an idle sample', async () => {
  const runner = activationSimulation((record, cm, reads, time) => {
    record.lastSampleAt = null;
    record.lastScaleAt = time;
  });
  assert.equal((await runner.run()).activated, true);
});

test('activation cannot accept stale, wrong-policy, in-flight or unowned journal evidence', async () => {
  for (const change of [
    (record) => {
      record.lastSampleAt = 99_999;
    },
    (record) => {
      record.lastSampleAt = 999_999;
    },
    (record) => {
      record.manifestDigest = 'old';
    },
    (record) => {
      record.policyDigest = 'old';
    },
    (record) => {
      record.leaseExpiresAt = 200_000;
    },
    (record) => {
      record.namespace = 'other';
    },
    (record, cm) => {
      cm.metadata.uid = '';
    },
    (record, cm) => {
      cm.metadata.labels[instance] = 'other';
    },
  ]) {
    const runner = activationSimulation(change);
    const report = await runner.run();
    assert.equal(report.activated, false, change.toString());
    assert.equal(report.elapsedMs, 3_000);
    assert.equal(runner.artifacts.length, 2);
  }
});

test('activation cannot accept a fresh demand sample attached to an unfinished failed intent', async () => {
  for (const phase of ['scaling', 'fencing', 'withdrawing', 'draining', 'removing', 'unfencing']) {
    const runner = activationSimulation((record) => {
      record.phase = phase;
    });
    const report = await runner.run();
    assert.equal(report.activated, false, phase);
    assert.equal(report.elapsedMs, 3_000);
  }
});

test('activation replaces previous success before the first journal read', async () => {
  let saved = { activated: true, observedAt: 'previous-attempt' };
  const runner = activationSimulation(
    (_record, _cm, reads) => {
      if (reads !== 1) return;
      assert.equal(saved.activated, false);
      assert.match(saved.pending, /in progress/);
      assert.notEqual(saved.observedAt, 'previous-attempt');
    },
    {
      artifact: async (_name, content) => {
        saved = JSON.parse(content);
      },
    },
  );
  assert.equal((await runner.run()).activated, true);
  assert.equal(saved.activated, true);
});

test('activation does not report a late journal read as success within its bounded window', async () => {
  let now = 100_000;
  const runner = activationSimulation(
    () => {
      now += 4_000;
    },
    {
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    },
  );
  const report = await runner.run();
  assert.equal(report.activated, false);
  assert.equal(report.elapsedMs, 4_000);
});

test('activation is a no-op without a rendered custom autoscaler', async () => {
  const report = await waitForExecutionAutoscalerActivation({
    resources: fixture().resources,
    release,
    namespace,
    kube: () => assert.fail('unexpected Kubernetes read'),
  });
  assert.equal(report.skipped, true);
});
