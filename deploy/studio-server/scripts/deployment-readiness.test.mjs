import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertInstalledReleaseManifest,
  assertInstalledExecutionSettings,
  assertCutoverVerificationInventory,
  assertCutoverVerificationTarget,
  assertNoExecutionStartupFences,
  readAvailableReleaseJournal,
} from './lib/deployment-readiness.mjs';

test('final configuration comparison ignores only hooks and private CAS guards, not application policy', () => {
  const resource = { kind: 'ConfigMap', metadata: { name: 'settings' }, data: { setting: 'approved' } };
  const installed = structuredClone(resource);
  installed.metadata.resourceVersion = 'previous-operation';
  const hook = { kind: 'Job', metadata: { name: 'migration', annotations: { 'helm.sh/hook': 'pre-upgrade' } } };
  assert.doesNotThrow(() => assertInstalledReleaseManifest([resource, hook], [installed]));
  installed.data.setting = 'changed';
  assert.throws(() => assertInstalledReleaseManifest([resource], [installed]), /differs/);
  assert.throws(() => assertInstalledReleaseManifest([resource], []), /differs/);
});

test('verification recovery requires identical final workload and storage identities and no startup fences', () => {
  const inventory = {
    workloads: [{ kind: 'statefulset', name: 'backend', uid: 'original' }],
    claims: [{ name: 'data', uid: 'claim' }],
  };
  assert.doesNotThrow(() => assertCutoverVerificationInventory(inventory, structuredClone(inventory)));
  for (const key of ['workloads', 'claims']) {
    const current = structuredClone(inventory);
    current[key][0].uid = 'replacement';
    assert.throws(() => assertCutoverVerificationInventory(inventory, current), /identities changed/);
  }
  assert.throws(
    () => assertCutoverVerificationInventory({ workloads: inventory.workloads }, inventory),
    /claim identities/,
  );
  for (const item of [
    { metadata: { annotations: { 'rivet.dev/execution-retirement-fence': 'old-pod' } } },
    { spec: { template: { metadata: { annotations: { 'rivet.dev/execution-retirement-fence': 'old-pod' } } } } },
  ])
    assert.throws(() => assertNoExecutionStartupFences([item]), /startup fence remains/);
});

test('stored autoscaled capacity may differ only within its approved policy; static capacity and settings stay exact', () => {
  const workload = {
    kind: 'Deployment',
    metadata: { name: 'proxy' },
    spec: {
      replicas: 2,
      template: { spec: { containers: [{ name: 'proxy', env: [{ name: 'SETTING', value: 'approved' }] }] } },
    },
  };
  const hpa = {
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'proxy' },
    spec: {
      scaleTargetRef: { kind: 'Deployment', name: 'proxy' },
      minReplicas: 2,
      maxReplicas: 4,
    },
  };
  const expected = [workload, hpa],
    installed = structuredClone(expected);
  installed[0].spec.replicas = 3;
  const identity = { release: 'rivet', namespace: 'fixture' };
  assert.doesNotThrow(() => assertInstalledReleaseManifest(expected, installed, identity));
  assert.equal(installed[0].spec.replicas, 3, 'comparison must not edit saved or rendered resources');
  assert.throws(() => assertInstalledReleaseManifest([workload], [installed[0]], identity), /differs/);
  for (const replicas of [0, 1, 5, 2.5]) {
    const changed = structuredClone(installed);
    changed[0].spec.replicas = replicas;
    assert.throws(() => assertInstalledReleaseManifest(expected, changed, identity), /capacity is outside/);
  }
  installed[0].spec.template.spec.containers[0].env[0].value = 'changed';
  assert.throws(() => assertInstalledReleaseManifest(expected, installed, identity), /differs/);
  const changedPolicy = structuredClone(expected);
  changedPolicy[1].spec.maxReplicas = 5;
  assert.throws(() => assertInstalledReleaseManifest(expected, changedPolicy, identity), /differs/);
});

test('same-image settings drift cannot pass verification, while API-defaulted mount fields can', () => {
  const resource = {
    kind: 'StatefulSet',
    metadata: { name: 'backend' },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'api',
              env: [{ name: 'DATABASE', value: 'approved' }],
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
            },
          ],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'approved' } }],
        },
      },
    },
  };
  const live = structuredClone(resource);
  live.spec.template.spec.containers[0].volumeMounts[0].readOnly = false;
  assert.doesNotThrow(() => assertInstalledExecutionSettings([resource], [live]));
  live.spec.template.spec.containers[0].env[0].value = 'another-database';
  assert.throws(() => assertInstalledExecutionSettings([resource], [live]), /execution settings differ/);
});

test('only literal empty env values may be omitted; sources, ordering, arguments and real values remain guarded', () => {
  const resource = {
    kind: 'StatefulSet',
    metadata: { name: 'backend' },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'api',
              env: [
                { name: 'EMPTY', value: '' },
                { name: 'VALUE', value: 'approved' },
              ],
              args: [''],
            },
          ],
        },
      },
    },
  };
  const live = structuredClone(resource);
  delete live.spec.template.spec.containers[0].env[0].value;
  assert.doesNotThrow(() => assertInstalledExecutionSettings([resource], [live]));
  assert.doesNotThrow(() => assertInstalledExecutionSettings([live], [resource]));
  for (const mutate of [
    (c) => {
      c.env[0].value = 'changed';
    },
    (c) => {
      c.env[0].value = null;
    },
    (c) => {
      c.env[0].valueFrom = { secretKeyRef: { name: 'other', key: 'key' } };
    },
    (c) => {
      c.env.reverse();
    },
    (c) => {
      c.args = [];
    },
  ]) {
    const changed = structuredClone(live);
    mutate(changed.spec.template.spec.containers[0]);
    assert.throws(() => assertInstalledExecutionSettings([resource], [changed]), /execution settings differ/);
  }
  const fromField = structuredClone(live);
  fromField.spec.template.spec.containers[0].env[0].valueFrom = { fieldRef: { fieldPath: 'metadata.uid' } };
  const defaulted = structuredClone(fromField);
  defaulted.spec.template.spec.containers[0].env[0].valueFrom.fieldRef.apiVersion = 'v1';
  assert.doesNotThrow(() => assertInstalledExecutionSettings([fromField], [defaulted]));
  defaulted.spec.template.spec.containers[0].env[0].valueFrom.fieldRef.fieldPath = 'metadata.name';
  assert.throws(() => assertInstalledExecutionSettings([fromField], [defaulted]), /execution settings differ/);
});

test('missing final inventory can adopt observed intended controllers, never changed storage or extra workloads', () => {
  const resources = [{ kind: 'Deployment', metadata: { name: 'autoscaler' } }];
  const claims = [{ name: 'data', uid: 'retained' }];
  const current = {
    workloads: [{ kind: 'deployment', name: 'autoscaler', uid: 'intentionally-recreated' }],
    claims,
    autoscalers: [],
  };
  assert.equal(assertCutoverVerificationTarget(resources, current, claims), current);
  assert.throws(
    () => assertCutoverVerificationTarget(resources, current, [{ name: 'data', uid: 'changed' }]),
    /claim identities/,
  );
  assert.throws(() => assertCutoverVerificationTarget([], current, claims), /complete approved candidate/);
  assert.throws(() => assertCutoverVerificationTarget(resources, current, undefined), /claim identities/);
});

test('journal admission waits only on completed sampling and refuses busy, changed or indefinitely held ownership', async () => {
  let time = 100,
    reads = 0;
  const resource = {
    metadata: { name: 'journal', namespace: 'ns', uid: 'uid', resourceVersion: '1' },
    data: { record: '' },
  };
  const record = {
    autoscalingProtocol: 1,
    release: 'rivet',
    namespace: 'ns',
    phase: 'complete',
    token: 'token',
    runner: 'runner',
    manifestDigest: 'digest',
    leaseExpiresAt: 200,
  };
  const options = {
    name: 'journal',
    release: 'rivet',
    namespace: 'ns',
    kind: 'cutover',
    timeoutMs: 300,
    now: () => time,
    sleep: async () => {
      time = 201;
    },
    kube: async () => {
      reads++;
      resource.data.record = JSON.stringify(record);
      return { stdout: JSON.stringify(resource) };
    },
  };
  const result = await readAvailableReleaseJournal(options);
  assert.equal(reads, 2);
  assert.equal(result.record, null);
  assert.equal(result.resource.metadata.resourceVersion, '1');
  record.phase = 'fencing';
  await assert.rejects(readAvailableReleaseJournal(options), /autoscaling operation owns/);
  record.phase = 'complete';
  record.leaseExpiresAt = 1000;
  await assert.rejects(
    readAvailableReleaseJournal({
      ...options,
      sleep: async () => {
        time += 301;
      },
    }),
    /sampling lease did not settle/,
  );
  resource.metadata.uid = '';
  await assert.rejects(readAvailableReleaseJournal(options), /resource identity is unconfirmed/);
  resource.metadata.uid = 'original';
  time = 100;
  await assert.rejects(
    readAvailableReleaseJournal({
      ...options,
      sleep: async () => {
        resource.metadata.uid = 'replacement';
      },
    }),
    /immutable identity changed/,
  );
  await assert.rejects(readAvailableReleaseJournal({ ...options, timeoutMs: 0 }), /bounded positive timeout/);
});

test('claim refresh accepts only the original journal and bindings; completed sampling may advance its CAS version', async () => {
  const previous = {
    metadata: { name: 'journal', namespace: 'ns', uid: 'original', resourceVersion: '1' },
    data: {
      record: JSON.stringify({
        autoscalingProtocol: 1,
        release: 'rivet',
        namespace: 'ns',
        manifestDigest: 'installed',
        policyDigest: 'policy',
        phase: 'complete',
        token: 'sample-1',
        runner: 'sampler-1',
        leaseExpiresAt: 99,
      }),
    },
  };
  const current = structuredClone(previous);
  current.metadata.resourceVersion = '2';
  current.data.record = JSON.stringify({
    ...JSON.parse(previous.data.record),
    token: 'sample-2',
    runner: 'sampler-2',
    lastSampleAt: 100,
  });
  const options = {
    name: 'journal',
    kind: 'cutover',
    release: 'rivet',
    namespace: 'ns',
    timeoutMs: 100,
    previousResource: previous,
    now: () => 100,
    kube: async () => ({ stdout: JSON.stringify(current) }),
  };
  assert.equal((await readAvailableReleaseJournal(options)).resource.metadata.resourceVersion, '2');
  for (const edit of [
    (r) => (r.metadata.uid = 'replacement'),
    ...['manifestDigest', 'policyDigest', 'autoscalingProtocol', 'release', 'namespace'].map((field) => (r) => {
      r.data.record = JSON.stringify({ ...JSON.parse(r.data.record), [field]: 'changed' });
    }),
    ...['scale', 'target', 'fence', 'fenceRepair', 'removal'].map((field) => (r) => {
      r.data.record = JSON.stringify({ ...JSON.parse(r.data.record), [field]: { pending: true } });
    }),
    (r) => (r.data.record = JSON.stringify({ ...JSON.parse(r.data.record), phase: 'fencing' })),
  ]) {
    const changed = structuredClone(current);
    edit(changed);
    await assert.rejects(
      readAvailableReleaseJournal({ ...options, kube: async () => ({ stdout: JSON.stringify(changed) }) }),
    );
  }
  await assert.rejects(readAvailableReleaseJournal({ ...options, kube: async () => ({ stdout: '' }) }), /disappeared/);
  await assert.rejects(
    readAvailableReleaseJournal({ ...options, previousResource: null }),
    /immutable identity changed/,
  );
  const absent = await readAvailableReleaseJournal({
    ...options,
    previousResource: null,
    kube: async () => ({ stdout: '' }),
  });
  assert.equal(absent.resource, null);
  assert.equal(previous.metadata.resourceVersion, '1', 'Refreshing cannot rewrite the previous observation');
  const completed = { ...JSON.parse(previous.data.record), autoscalingProtocol: undefined, formatVersion: 1 };
  const cutover = structuredClone(previous);
  cutover.data.record = JSON.stringify(completed);
  for (const field of ['token', 'runner']) {
    const changed = structuredClone(cutover);
    changed.data.record = JSON.stringify({ ...completed, [field]: 'different-owner' });
    await assert.rejects(
      readAvailableReleaseJournal({
        ...options,
        previousResource: cutover,
        kube: async () => ({ stdout: JSON.stringify(changed) }),
      }),
      /owner changed/,
    );
  }
});
