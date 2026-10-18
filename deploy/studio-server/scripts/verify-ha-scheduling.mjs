// Real kube-scheduler placement regression, not a GKE autoscaler simulation.
// Synthetic Nodes have no kubelets: only PodScheduled is asserted, not execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const root = process.cwd();
const context = process.env.RIVET_HA_SCHEDULING_CONTEXT;
assert.match(context ?? '', /^(kind-rivet-[a-z0-9-]+|rivet-ha-proof)$/,
  'Set RIVET_HA_SCHEDULING_CONTEXT to a disposable local Rivet test cluster');
const kubectl = process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl';
const run = (args, input) => execFileSync(kubectl, ['--context', context, ...args], {
  encoding: 'utf8', input: input && JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
});
const read = args => JSON.parse(run(args));
const configuration = read(['config', 'view', '--minify', '-o', 'json']);
assert.equal(configuration.contexts[0].name, context);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(configuration.clusters[0].cluster.server).hostname),
  'Scheduling regression refuses non-loopback Kubernetes servers');
const originalNodes = read(['get', 'nodes', '-o', 'json']).items;
assert.ok(originalNodes.length > 0 && originalNodes.every(n =>
  n.spec.providerID?.startsWith('kind://') || n.metadata.labels?.['minikube.k8s.io/name']),
  'Scheduling regression requires a disposable Kind/Minikube cluster, never a cloud cluster');
const existingPods = read(['get', 'pods', '-A', '-o', 'json']).items;
const fixedStandalone = p => !p.metadata.ownerReferences?.length &&
  originalNodes.some(n => n.metadata.name === p.spec.nodeName);
assert.ok(existingPods.every(p => ['kube-system', 'local-path-storage'].includes(p.metadata.namespace) ||
  ['Succeeded', 'Failed'].includes(p.status.phase) || fixedStandalone(p)),
  'Run scheduling regression before application tests: synthetic Nodes must not attract other workloads');
const preservedPods = existingPods.filter(p => fixedStandalone(p)).map(p => ({
  name: p.metadata.name, namespace: p.metadata.namespace, uid: p.metadata.uid, node: p.spec.nodeName,
}));

const owner = randomUUID();
const namespace = `rivet-ha-scheduling-${owner.slice(0, 8)}`;
const artifacts = path.resolve(process.env.RIVET_HA_SCHEDULING_ARTIFACTS || 'artifacts/ha-scheduling');
const labels = { 'rivet.test/owner': owner };
const report = { context, owner, namespace, cases: [], createdNodes: [], preservedPods, namespaceUid: null, passed: false };
await fs.mkdir(artifacts, { recursive: true });
const rendered = execFileSync(resolveHelmBinOrThrow(root), ['template', 'scheduling', 'deploy/studio-server/helm',
  '-f', 'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
  '-f', 'deploy/studio-server/helm/overlays/gke-ha.yaml',
  '--set', 'objectStorage.bucket=fixture', '--set', 'postgres.maxConnections=250'], { encoding: 'utf8', stdio: 'pipe' });
const proxy = parseAllDocuments(rendered).map(d => d.toJS()).find(r => r.kind === 'Deployment' &&
  r.metadata.labels['app.kubernetes.io/component'] === 'proxy');
const placement = proxy.spec.template.spec;
assert.equal(placement.topologySpreadConstraints[0].nodeTaintsPolicy, 'Honor');
const podLabels = { ...proxy.spec.template.metadata.labels, ...labels };
const taint = { key: 'rivet.test/draining', value: owner, effect: 'NoSchedule' };
const createResource = value => JSON.parse(run(['create', '-f', '-', '-o', 'json'], value));
const assertOwned = (resource, identity) => {
  assert.equal(resource.metadata.uid, identity.uid);
  assert.equal(resource.metadata.labels['rivet.test/owner'], owner);
};
const deleteOwned = (kind, identity) => {
  assertOwned(read(['get', kind, identity.name, ...(kind === 'pod' ? ['-n', namespace] : []), '-o', 'json']), identity);
  const endpoint = kind === 'pod' ? `namespaces/${namespace}/pods/${identity.name}`
    : `${kind === 'node' ? 'nodes' : 'namespaces'}/${identity.name}`;
  run(['delete', '--raw', `/api/v1/${endpoint}`, '-f', '-'], {
    apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: identity.uid }, gracePeriodSeconds: 0,
  });
};
const markReady = node => {
  assertOwned(read(['get', 'node', node.name, '-o', 'json']), node);
  run(['patch', 'node', node.name, '--subresource=status', '--type=json', '-p', JSON.stringify([
    { op: 'test', path: '/metadata/uid', value: node.uid },
    { op: 'add', path: '/status', value: { capacity: { cpu: '4', memory: '8Gi', pods: '110' },
      allocatable: { cpu: '4', memory: '8Gi', pods: '110' },
      conditions: [{ type: 'Ready', status: 'True', reason: 'SchedulingFixture',
        lastHeartbeatTime: new Date().toISOString(), lastTransitionTime: new Date().toISOString() }] } },
  ])]);
};
const setTaints = (node, taints) => {
  assertOwned(read(['get', 'node', node.name, '-o', 'json']), node);
  run(['patch', 'node', node.name, '--type=json', '-p', JSON.stringify([
    { op: 'test', path: '/metadata/uid', value: node.uid }, { op: 'add', path: '/spec/taints', value: taints },
  ])]);
};
const pod = (name, spec = {}) => ({ apiVersion: 'v1', kind: 'Pod', metadata: {
  name, namespace, labels: { ...podLabels, 'pod-template-hash': name.startsWith('seed') ? 'old' : 'new' },
}, spec: { terminationGracePeriodSeconds: 0,
  containers: [{ name: 'fixture', image: 'registry.k8s.io/pause:3.10' }],
  topologySpreadConstraints: structuredClone(placement.topologySpreadConstraints),
  affinity: structuredClone(placement.affinity), ...spec } });
const observe = async (name, expectedNode, message) => {
  const deadline = Date.now() + 20_000;
  let current;
  do {
    current = read(['-n', namespace, 'get', 'pod', name, '-o', 'json']);
    const condition = current.status?.conditions?.find(c => c.type === 'PodScheduled');
    if (expectedNode ? current.spec.nodeName === expectedNode :
      !current.spec.nodeName && condition?.status === 'False' && /topology spread/i.test(condition.message)) {
      report.cases.push({ name, node: current.spec.nodeName ?? null, reason: condition?.reason ?? 'Scheduled', message });
      return { name, uid: current.metadata.uid };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw Error(`${name}: expected ${message}; last scheduling condition: ${JSON.stringify(current?.status?.conditions)}`);
};

try {
  const ns = createResource({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels } });
  report.namespaceUid = ns.metadata.uid;
  for (const [index, zone] of ['a', 'a', 'b', 'b', 'c', 'c', 'a', 'd'].entries()) {
    const name = `${namespace}-${index}`;
    const node = createResource({ apiVersion: 'v1', kind: 'Node', metadata: { name, labels: {
      ...labels, 'kubernetes.io/hostname': name, 'topology.kubernetes.io/zone': zone,
    } }, spec: { taints: zone === 'd' ? [taint] : [] } });
    const identity = { name, uid: node.metadata.uid, zone };
    report.createdNodes.push(identity);
    markReady(identity);
  }
  const refresh = () => report.createdNodes.forEach(markReady);
  for (const [index, node] of report.createdNodes.slice(0, 6).entries())
    createResource(pod(`seed-${index}`, { nodeName: node.name }));

  // Ignore counts an empty, untolerated fourth zone, so the old six proxies
  // cannot admit a seventh. Honor counts only the three usable zones.
  refresh();
  const ignored = pod('ignore-surge');
  ignored.spec.topologySpreadConstraints[0].nodeTaintsPolicy = 'Ignore';
  createResource(ignored);
  deleteOwned('pod', await observe('ignore-surge', null, 'untolerated empty zone blocks Ignore'));
  refresh();
  createResource(pod('honor-surge'));
  deleteOwned('pod', await observe('honor-surge', report.createdNodes[6].name, 'Honor schedules the mixed-revision surge in zone a'));

  // Do not weaken minDomains when a required zone actually disappears.
  for (const node of report.createdNodes.filter(n => n.zone === 'c')) setTaints(node, [taint]);
  refresh();
  createResource(pod('lost-zone'));
  deleteOwned('pod', await observe('lost-zone', null, 'fewer than three eligible zones remains Pending'));
  for (const node of report.createdNodes.filter(n => n.zone === 'c')) setTaints(node, []);
  refresh();
  createResource(pod('tolerated-zone', { tolerations: [{ ...taint, operator: 'Equal' }] }));
  deleteOwned('pod', await observe('tolerated-zone', report.createdNodes[7].name, 'a tolerated taint makes the fourth zone eligible'));

  // Same three-zone shape as the GKE rollout: old pods on draining hosts
  // inflate zone a to 3/2/2. Only its fresh hostname has surge capacity.
  const draining = report.createdNodes[7];
  assertOwned(read(['get', 'node', draining.name, '-o', 'json']), draining);
  run(['patch', 'node', draining.name, '--type=json', '-p', JSON.stringify([
    { op: 'test', path: '/metadata/uid', value: draining.uid },
    { op: 'replace', path: '/metadata/labels/topology.kubernetes.io~1zone', value: 'a' },
  ])]);
  draining.zone = 'a';
  createResource(pod('seed-draining', { nodeName: draining.name }));
  setTaints(report.createdNodes[0], [taint]);
  refresh();
  const inflated = pod('ignore-draining');
  inflated.spec.topologySpreadConstraints[0].nodeTaintsPolicy = 'Ignore';
  createResource(inflated);
  deleteOwned('pod', await observe('ignore-draining', null, 'draining old hosts inflate three-zone counts under Ignore'));
  refresh();
  createResource(pod('honor-draining'));
  deleteOwned('pod', await observe('honor-draining', report.createdNodes[6].name, 'Honor admits surge using eligible three-zone counts'));
  report.passed = true;
} finally {
  // Record identities before cleanup; never infer deletion authority by prefix.
  await fs.writeFile(path.join(artifacts, 'scheduling.json'), JSON.stringify(report, null, 2));
  if (report.namespaceUid) {
    // There are intentionally no kubelets on synthetic Nodes to acknowledge
    // graceful termination. These fixture pods never ran; delete exact UIDs.
    const pods = read(['-n', namespace, 'get', 'pods', '-o', 'json']).items;
    for (const current of pods) {
      assert.equal(current.metadata.labels['rivet.test/owner'], owner);
      deleteOwned('pod', { name: current.metadata.name, uid: current.metadata.uid });
    }
    deleteOwned('namespace', { name: namespace, uid: report.namespaceUid });
    run(['wait', '--for=delete', `namespace/${namespace}`, '--timeout=20s']);
  }
  for (const node of report.createdNodes) deleteOwned('node', node);
  for (const node of report.createdNodes)
    assert.equal(run(['get', 'node', node.name, '--ignore-not-found', '-o', 'json']).trim(), '');
  const remaining = read(['get', 'pods', '-A', '-o', 'json']).items;
  for (const p of preservedPods) assert.ok(remaining.some(current => current.metadata.uid === p.uid &&
    current.metadata.namespace === p.namespace && current.metadata.name === p.name && current.spec.nodeName === p.node),
    'A pre-existing fixed standalone pod changed during the scheduling test');
  await fs.writeFile(path.join(artifacts, 'cleanup.json'), JSON.stringify({ owner, namespace, absent: true, nodesAbsent: true }));
}
console.log(`Real scheduler: ${report.cases.length} placement cases passed; exact fixture resources removed.`);
