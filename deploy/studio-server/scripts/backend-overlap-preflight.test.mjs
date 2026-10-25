import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBackendOverlap } from './lib/backend-overlap-preflight.mjs';

function fixture() {
  const backend = {
    metadata: { name: 'rivet-backend', uid: 'sts' },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'backend',
              env: [{ name: 'RIVET_NAMESPACE_UID', value: 'ns' }],
              resources: { requests: { cpu: '750m', memory: '1536Mi' } },
            },
          ],
          volumes: [{ name: 'legacy-restore', persistentVolumeClaim: { claimName: 'scratch' } }],
        },
      },
    },
  };
  const claim = {
    metadata: { uid: 'claim' },
    spec: { volumeName: 'pv', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } },
    status: { phase: 'Bound' },
  };
  const pod = {
    metadata: { ownerReferences: [{ controller: true, uid: 'sts' }] },
    spec: {
      nodeName: 'node',
      containers: [{ resources: { requests: { cpu: '1', memory: '2Gi' } } }],
    },
    status: { phase: 'Running' },
  };
  const node = {
    spec: {},
    status: { allocatable: { cpu: '2', memory: '4Gi', pods: '110' }, conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const kube = async (args) => {
    assert.equal(args[0], 'get', 'preflight must never mutate Kubernetes');
    const data = {
      pvc: claim,
      pv: { metadata: { uid: 'volume' }, spec: { claimRef: { uid: claim.metadata.uid } } },
      namespace: { metadata: { uid: 'ns' } },
      pod,
      node,
      pods: { items: [pod] },
    }[args[1]];
    assert.ok(data, `unexpected request ${args}`);
    return { stdout: JSON.stringify(data) };
  };
  return { backend, installed: backend, claim, pod, node, kube, namespace: 'fixture', capacity: true };
}
test('overlap preflight records the RWO identity and accounts for existing node requests', async () => {
  const f = fixture();
  const identity = await inspectBackendOverlap(f);
  assert.equal(identity.uid, 'claim');
  await inspectBackendOverlap({ ...f, expectedDisk: identity, capacity: false });
  await assert.rejects(
    inspectBackendOverlap({
      ...f,
      desiredClaim: { spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '40Gi' } } } },
    }),
    /may not change/,
  );
  f.claim.metadata.uid = 'replacement';
  await assert.rejects(inspectBackendOverlap({ ...f, expectedDisk: identity }), /identity\/access mode/);
});
test('insufficient CPU, memory, pod slots, claim access or namespace never permits overlap', async () => {
  for (const mutate of [
    (f) => {
      f.node.status.allocatable.cpu = '1500m';
    },
    (f) => {
      f.node.status.allocatable.memory = '3Gi';
    },
    (f) => {
      f.node.status.allocatable.pods = '1';
    },
    (f) => {
      f.node.spec.unschedulable = true;
    },
    (f) => {
      f.claim.spec.accessModes = ['ReadWriteOncePod'];
    },
    (f) => {
      f.backend.spec.template.spec.containers[0].env[0].value = 'foreign';
    },
    (f) => {
      f.backend.spec.template.spec.initContainers = [{ resources: { requests: { memory: '3Gi' } } }];
    },
    (f) => {
      f.pod.spec.overhead = { cpu: '500m' };
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(inspectBackendOverlap(f));
  }
});
