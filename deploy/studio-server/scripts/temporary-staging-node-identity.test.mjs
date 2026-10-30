import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryPlan } from './fixtures/temporary-staging-plan.mjs';
import { temporaryGcp, temporaryFoundationSpecs } from './lib/temporary-staging-gcp.mjs';
import { inspectTemporaryActorNodeIdentity } from './lib/temporary-staging-node-identity.mjs';

function fixture({ visible = false, autopilot = true } = {}) {
  const plan = temporaryPlan(),
    specs = temporaryFoundationSpecs(plan),
    values = new Map();
  const resources = specs
    .filter((s) => ['network', 'nodes', 'cluster'].includes(s.key))
    .map((spec) => {
      const value = { ...structuredClone(spec.body), id: 'id-' + spec.key };
      if (spec.key === 'cluster')
        Object.assign(value, {
          endpoint: '127.0.0.1',
          masterAuth: { clusterCaCertificate: 'fixture-ca' },
          autopilot: { enabled: autopilot },
          network: plan.operationId,
          subnetwork: plan.operationId + '-nodes',
          networkConfig: {
            ...value.networkConfig,
            network: specs.find((s) => s.key === 'network').path,
            subnetwork: specs.find((s) => s.key === 'nodes').path,
            defaultEnablePrivateNodes: false,
          },
        });
      values.set(spec.key, value);
      return {
        key: spec.key,
        identity: {
          id: value.id,
          name: spec.name,
          ...(spec.key === 'cluster' ? { endpoint: value.endpoint, ca: value.masterAuth.clusterCaCertificate } : {}),
        },
      };
    });
  resources.push({ key: 'actor', identity: { id: 'pod-uid', name: 'qualification-actor' } });
  const record = { plan, resources },
    pod = {
      metadata: { uid: 'pod-uid' },
      spec: { nodeName: 'actor-node' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
  const node = {
    metadata: { name: 'actor-node', uid: 'node-uid', labels: { 'topology.kubernetes.io/zone': plan.region + '-a' } },
    spec: { providerID: `gce://${plan.projectId}/${plan.region}-a/actor-node` },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      addresses: [
        { type: 'InternalIP', address: '10.11.0.2' },
        { type: 'ExternalIP', address: '34.118.0.99' },
      ],
    },
  };
  const instance = {
    id: '1234567890123456789',
    name: 'actor-node',
    networkInterfaces: [
      {
        network: specs.find((s) => s.key === 'network').path,
        subnetwork: specs.find((s) => s.key === 'nodes').path,
        networkIP: '10.11.0.2',
        accessConfigs: [{ natIP: '34.118.0.99' }],
      },
    ],
  };
  const actualIdentity = temporaryGcp(plan, {
    token: async () => {
      throw Error('No external credentials in fixture');
    },
  }).identity;
  const reads = [],
    cloud = {
      get: async (spec) => {
        reads.push(spec.key);
        return structuredClone(values.get(spec.key));
      },
      identity: actualIdentity,
      request: async (service, method, resource) => {
        reads.push(resource);
        return visible ? structuredClone(instance) : null;
      },
    };
  return {
    record,
    cloud,
    pod,
    node,
    values,
    reads,
    instance,
    setVisible: (value) => {
      visible = value;
    },
  };
}
const inspect = (f) => inspectTemporaryActorNodeIdentity(f.record, f.cloud, f.pod, f.node);

test('opaque live Autopilot nodes use authenticated Kubernetes identity without fabricating a VM ID', async () => {
  const f = fixture(),
    proof = await inspect(f);
  assert.equal(proof.kind, 'gke-autopilot-node');
  assert.equal(proof.egressIp, '34.118.0.99');
  assert.equal(proof.internalIp, '10.11.0.2');
  assert.equal('instanceId' in proof, false);
  assert.deepEqual(await inspectTemporaryActorNodeIdentity(f.record, f.cloud, f.pod, f.node, proof), proof);
  assert.ok(
    f.reads.filter((v) => v === 'cluster').length === 2 &&
      f.reads.filter((v) => v === 'network').length === 2 &&
      f.reads.filter((v) => v === 'nodes').length === 2,
  );
});
test('Standard/unknown capability cannot use a missing Compute VM as an Autopilot fallback', async () => {
  await assert.rejects(inspect(fixture({ autopilot: false })), /explicit live Autopilot/);
  const f = fixture();
  delete f.values.get('cluster').autopilot;
  await assert.rejects(inspect(f), /explicit live Autopilot/);
});
test('a visible VM retains its immutable Compute ID and never changes proof kind after a 404', async () => {
  const f = fixture({ visible: true, autopilot: false }),
    proof = await inspect(f);
  assert.equal(proof.kind, 'compute-instance');
  assert.equal(proof.instanceId, f.instance.id);
  assert.equal(proof.internalIp, f.instance.networkInterfaces[0].networkIP);
  f.setVisible(false);
  await assert.rejects(
    inspectTemporaryActorNodeIdentity(f.record, f.cloud, f.pod, f.node, proof),
    /Compute VM disappeared/,
  );
});
test('GKE cluster immutable ID, endpoint and CA must remain pinned', async () => {
  for (const mutate of [
    (v) => {
      v.id = 'replacement';
    },
    (v) => {
      v.endpoint = 'other.invalid';
    },
    (v) => {
      v.masterAuth.clusterCaCertificate = 'replacement-ca';
    },
  ]) {
    const f = fixture();
    mutate(f.values.get('cluster'));
    await assert.rejects(inspect(f));
  }
});
test('opaque Autopilot requires full owned project/network/subnet references, with immutable provider identities', async () => {
  for (const mutate of [
    (v) => {
      v.networkConfig.network = 'projects/other-project/global/networks/' + v.network;
    },
    (v) => {
      v.networkConfig.subnetwork = 'projects/other-project/regions/europe-central2/subnetworks/' + v.subnetwork;
    },
    (v) => {
      v.networkConfig.network = v.network;
    },
    (v) => {
      delete v.networkConfig.subnetwork;
    },
  ]) {
    const f = fixture();
    mutate(f.values.get('cluster'));
    await assert.rejects(inspect(f));
  }
  for (const key of ['network', 'nodes']) {
    const f = fixture();
    f.values.get(key).id = 'replacement';
    await assert.rejects(inspect(f));
  }
});
test('a public actor needs a unique public ExternalIP and an InternalIP in its own node subnet', async () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.99', '224.0.0.1', '::1']) {
    const f = fixture();
    f.node.status.addresses[1].address = address;
    await assert.rejects(inspect(f), /public IPv4/);
  }
  const f = fixture();
  f.node.status.addresses.push({ type: 'ExternalIP', address: '34.118.0.98' });
  await assert.rejects(inspect(f), /one public ExternalIP/);
  const outside = fixture();
  outside.node.status.addresses[0].address = '10.12.0.2';
  await assert.rejects(inspect(outside), /outside its owned subnet/);
  const privateCluster = fixture();
  privateCluster.values.get('cluster').networkConfig.defaultEnablePrivateNodes = true;
  await assert.rejects(inspect(privateCluster), /Private Autopilot/);
});
test('each actor command rejects changed Pod/Node UID, provider identity, addresses or live GKE ownership', async () => {
  for (const mutate of [
    (f) => {
      f.pod.metadata.uid = 'replacement';
    },
    (f) => {
      f.node.metadata.uid = 'replacement';
    },
    (f) => {
      f.node.spec.providerID = f.node.spec.providerID.replace('actor-node', 'other-node');
    },
    (f) => {
      f.node.status.addresses[0].address = '10.11.0.3';
    },
    (f) => {
      f.node.status.addresses[1].address = '34.118.0.98';
    },
    (f) => {
      f.values.get('cluster').networkConfig.network = 'projects/other-project/global/networks/other';
    },
  ]) {
    const f = fixture(),
      proof = await inspect(f);
    mutate(f);
    await assert.rejects(inspectTemporaryActorNodeIdentity(f.record, f.cloud, f.pod, f.node, proof));
  }
});
test('named Compute VM proof rejects wrong VM/name/network and private egress', async () => {
  for (const mutate of [
    (f) => {
      f.instance.name = 'other';
    },
    (f) => {
      f.instance.networkInterfaces[0].network = 'projects/other/global/networks/other';
    },
    (f) => {
      f.instance.networkInterfaces[0].accessConfigs[0].natIP = '10.0.0.1';
    },
  ]) {
    const f = fixture({ visible: true });
    mutate(f);
    await assert.rejects(inspect(f));
  }
});

test('visible actor VMs require the exact owned node subnet and a valid InternalIP within its CIDR', async () => {
  for (const mutate of [
    (f) => {
      f.instance.networkInterfaces[0].subnetwork =
        'projects/other-project/regions/europe-central2/subnetworks/' + f.record.plan.operationId + '-nodes';
    },
    (f) => {
      f.instance.networkInterfaces[0].subnetwork =
        'projects/' + f.record.plan.projectId + '/regions/europe-central2/subnetworks/another-subnet';
    },
    (f) => {
      delete f.instance.networkInterfaces[0].subnetwork;
    },
    (f) => {
      f.instance.networkInterfaces[0].networkIP = '10.12.0.2';
    },
    (f) => {
      f.instance.networkInterfaces[0].networkIP = '::1';
    },
    (f) => {
      delete f.instance.networkInterfaces[0].networkIP;
    },
  ]) {
    const f = fixture({ visible: true });
    mutate(f);
    await assert.rejects(inspect(f));
  }
});

test('a visible VM InternalIP remains pinned on later actor commands even within the same owned subnet', async () => {
  const f = fixture({ visible: true }),
    proof = await inspect(f);
  f.instance.networkInterfaces[0].networkIP = '10.11.0.3';
  await assert.rejects(
    inspectTemporaryActorNodeIdentity(f.record, f.cloud, f.pod, f.node, proof),
    /ownership or address changed/,
  );
});
