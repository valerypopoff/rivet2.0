import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertInstalledReleaseManifest,
  assertInstalledExecutionSettings,
  assertCutoverVerificationInventory,
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
