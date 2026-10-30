import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { temporaryFoundationSpecs, assertTemporaryClusterNodeIdentity } from './temporary-staging-gcp.mjs';

const ipv4 = (address) => address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const inCidr = (address, cidr) => {
  const [base, bits] = cidr.split('/');
  const first = ipv4(base),
    size = 2 ** (32 - Number(bits)),
    value = ipv4(address);
  return value >= first && value < first + size;
};
const nonPublic = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const publicIpv4 = (address) => isIP(address) === 4 && !nonPublic.some((cidr) => inCidr(address, cidr));
const ready = (value) =>
  value?.metadata?.uid &&
  !value.metadata.deletionTimestamp &&
  value.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True');

function assertResource(value, expected, name, allowShort = true) {
  assert.equal(typeof value, 'string', 'Missing live GKE network identity');
  const relative = expected.replace(/^projects\/[^/]+\//, '');
  if (value === expected || (allowShort && (value === name || value === relative))) return;
  const url = new URL(value);
  assert.ok(['https://compute.googleapis.com', 'https://www.googleapis.com'].includes(url.origin));
  assert.equal(url.pathname, '/compute/v1/' + expected, 'Live GKE network identity differs');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
}

/** An Autopilot Node is authenticated by the pinned cluster API, not an invented
 * Compute VM. A visible VM keeps the stronger independent Compute-ID proof.
 * Once selected, either proof kind must revalidate without changing its basis. */
export async function inspectTemporaryActorNodeIdentity(record, cloud, pod, node, expected) {
  const plan = record.plan,
    actor = record.resources.find((resource) => resource.key === 'actor');
  assert.ok(ready(pod) && actor?.identity && !actor.absent, 'Exact actor Pod is not ready');
  assert.equal(pod.metadata.uid, actor.identity.id, 'Actor Pod incarnation changed');
  assert.ok(ready(node), 'Actor Node is not ready');
  assert.equal(node.metadata.name, pod.spec.nodeName, 'Actor Pod moved to another Node');
  const match = /^gce:\/\/([^/]+)\/([^/]+)\/([a-z0-9-]+)$/.exec(node.spec?.providerID ?? '');
  assert.ok(match, 'Actor provider identity is missing');
  const [, project, zone, name] = match;
  assert.equal(project, plan.projectId, 'Actor Node belongs to another project');
  assert.match(zone, new RegExp(`^${plan.region}-[a-z]$`), 'Actor Node belongs to another region');
  assert.equal(node.metadata.labels?.['topology.kubernetes.io/zone'], zone, 'Actor Node zone identity differs');
  const specs = temporaryFoundationSpecs(plan);
  const owned = async (key) => {
    const resource = record.resources.find((item) => item.key === key),
      spec = specs.find((item) => item.key === key);
    assert.ok(resource?.identity && !resource.absent, 'Missing owned actor infrastructure');
    const value = await cloud.get(spec),
      identity = cloud.identity(spec, value);
    assert.equal(identity?.id, resource.identity.id, 'Actor infrastructure incarnation changed');
    return { value, identity, spec };
  };
  const cluster = await owned('cluster');
  if (cluster.value.autopilot?.enabled === true) assertTemporaryClusterNodeIdentity(plan, cluster.value);
  const pinned = record.resources.find((item) => item.key === 'cluster').identity;
  assert.equal(cluster.identity.endpoint, pinned.endpoint, 'Actor cluster endpoint changed');
  assert.equal(cluster.identity.ca, pinned.ca, 'Actor cluster CA changed');
  const network = await owned('network'),
    subnet = await owned('nodes');
  assertResource(subnet.value.network, network.spec.path, network.spec.name);
  assert.equal(subnet.value.ipCidrRange, plan.cidrs.nodes, 'Actor node subnet range changed');
  for (const [values, spec] of [
    [[cluster.value.network, cluster.value.networkConfig?.network], network.spec],
    [[cluster.value.subnetwork, cluster.value.networkConfig?.subnetwork], subnet.spec],
  ]) {
    const present = values.filter((value) => value !== undefined);
    assert.ok(present.length, 'Live GKE network attachment is missing');
    for (const value of present) assertResource(value, spec.path, spec.name);
  }
  const common = {
    podUid: pod.metadata.uid,
    nodeUid: node.metadata.uid,
    nodeName: node.metadata.name,
    providerId: node.spec.providerID,
    clusterId: cluster.identity.id,
    networkId: network.identity.id,
    subnetworkId: subnet.identity.id,
  };
  if (expected)
    assert.ok(['compute-instance', 'gke-autopilot-node'].includes(expected.kind), 'Unknown actor identity proof');
  // An existing Compute proof must still resolve its exact VM. A later 404 is
  // not permission to replace it with an Autopilot proof.
  const instance =
    expected?.kind === 'gke-autopilot-node'
      ? null
      : await cloud.request('compute', 'GET', `projects/${project}/zones/${zone}/instances/${name}`);
  let proof;
  if (instance) {
    assert.ok(instance.id && instance.name === name, 'Actor Compute instance identity differs');
    const interfaces =
      instance.networkInterfaces?.filter((item) => {
        try {
          assertResource(item.network, network.spec.path, network.spec.name);
          return true;
        } catch {
          return false;
        }
      }) ?? [];
    assert.equal(interfaces.length, 1, 'Actor VM does not use its owned network');
    assertResource(interfaces[0].subnetwork, subnet.spec.path, subnet.spec.name, false);
    assert.ok(
      isIP(interfaces[0].networkIP) === 4 && inCidr(interfaces[0].networkIP, plan.cidrs.nodes),
      'Actor VM InternalIP is outside its owned subnet',
    );
    const addresses = interfaces[0].accessConfigs?.map((item) => item.natIP).filter(Boolean) ?? [];
    assert.equal(addresses.length, 1, 'Actor requires one verified public-node egress IPv4');
    assert.ok(publicIpv4(addresses[0]), 'Actor egress address is not public IPv4');
    proof = {
      kind: 'compute-instance',
      ...common,
      instanceId: String(instance.id),
      instanceName: instance.name,
      internalIp: interfaces[0].networkIP,
      egressIp: addresses[0],
    };
  } else {
    assert.notEqual(expected?.kind, 'compute-instance', 'Actor Compute VM disappeared');
    assert.equal(
      cluster.value.autopilot?.enabled,
      true,
      'An opaque actor VM requires explicit live Autopilot capability',
    );
    assertResource(cluster.value.networkConfig?.network, network.spec.path, network.spec.name, false);
    assertResource(cluster.value.networkConfig?.subnetwork, subnet.spec.path, subnet.spec.name, false);
    assert.notEqual(
      cluster.value.privateClusterConfig?.enablePrivateNodes,
      true,
      'Private Autopilot nodes cannot establish public-node egress',
    );
    assert.notEqual(
      cluster.value.networkConfig?.defaultEnablePrivateNodes,
      true,
      'Private Autopilot nodes cannot establish public-node egress',
    );
    const external = node.status.addresses?.filter((address) => address.type === 'ExternalIP') ?? [];
    assert.equal(external.length, 1, 'Actor Node requires one public ExternalIP');
    assert.ok(publicIpv4(external[0].address), 'Actor ExternalIP is not public IPv4');
    const internal =
      node.status.addresses?.filter((address) => address.type === 'InternalIP' && isIP(address.address) === 4) ?? [];
    assert.equal(internal.length, 1, 'Actor Node requires one owned InternalIP');
    assert.ok(inCidr(internal[0].address, plan.cidrs.nodes), 'Actor InternalIP is outside its owned subnet');
    proof = { kind: 'gke-autopilot-node', ...common, internalIp: internal[0].address, egressIp: external[0].address };
  }
  if (expected) assert.deepEqual(proof, expected, 'Actor node ownership or address changed');
  return proof;
}
