import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHaWorkflowTraffic, startHaWebAppTraffic } from './ha-workflow-traffic.mjs';

const component = (pod) => pod.metadata?.labels?.['app.kubernetes.io/component'];
const ready = (pod) => !pod.metadata?.deletionTimestamp &&
  pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True');

/** A Pod Ready bit alone is not load-balancer health evidence on GKE. This
 * preflight rejects the known no-health-check and timed-out NEG-ready cases.
 * It is an observation, not a custom readiness controller or a PDB substitute. */
export function assertGkeFrontendAvailability(pods, nodes, release) {
  const frontend = pods.filter(p => ['proxy', 'web'].includes(component(p)) &&
    p.metadata?.labels?.['app.kubernetes.io/instance'] === release);
  const proxies = frontend.filter(p => component(p) === 'proxy');
  const web = frontend.filter(p => component(p) === 'web');
  assert.ok(proxies.length >= 6 && web.length >= 2, 'GKE proof requires six proxies and two web replicas');
  assert.equal(new Set(frontend.map(p => p.metadata.uid)).size, frontend.length, 'frontend UID evidence is duplicated');
  const zones = new Map();
  for (const role of [proxies, web]) {
    const hosts = new Set();
    for (const pod of role) {
      assert.ok(pod.metadata.uid && ready(pod), 'frontend is missing identity or not ready');
      const spread = pod.spec?.topologySpreadConstraints?.find(c => c.topologyKey === 'topology.kubernetes.io/zone');
      assert.ok(spread?.nodeTaintsPolicy === 'Honor' && spread.whenUnsatisfiable === 'DoNotSchedule' &&
        spread.minDomains === 3 && spread.maxSkew === 1,
        'GKE frontend must retain hard three-zone spread with nodeTaintsPolicy=Honor');
      const node = nodes.find(n => n.metadata.name === pod.spec?.nodeName);
      const host = node?.metadata.labels?.['kubernetes.io/hostname'];
      const zone = node?.metadata.labels?.['topology.kubernetes.io/zone'];
      assert.ok(node?.metadata.uid && host && zone, 'frontend node identity/zone is unavailable');
      assert.ok(!hosts.has(host), 'frontend replicas are co-located on a hostname');
      hosts.add(host);
      if (component(pod) !== 'proxy') continue;
      assert.ok(pod.spec.readinessGates?.some(g => g.conditionType === 'cloud.google.com/load-balancer-neg-ready'),
        'GKE proxy is missing its NEG readiness gate');
      assert.ok(pod.status.conditions.some(c => c.type === 'cloud.google.com/load-balancer-neg-ready' &&
        c.status === 'True' && c.reason === 'LoadBalancerNegReady'), 'proxy NEG has no positive load-balancer health observation');
      zones.set(zone, (zones.get(zone) ?? 0) + 1);
    }
  }
  assert.ok(zones.size === 3 && [...zones.values()].every(n => n >= 2),
    'GKE proof requires at least two healthy proxy endpoints in each of exactly three zones');
  return frontend.map(p => {
    const node = nodes.find(n => n.metadata.name === p.spec.nodeName);
    return { name: p.metadata.name, uid: p.metadata.uid, component: component(p), node: p.spec.nodeName,
      nodeUid: node.metadata.uid, zone: node.metadata.labels['topology.kubernetes.io/zone'],
      ...(component(p) === 'proxy' ? { negHealth: 'LoadBalancerNegReady' } : {}) };
  });
}

export async function waitForGkeFrontendAvailability(gate, removed = []) {
  const namespace = gate.config.namespace;
  assert.match(namespace, /^rivet-staging-[a-z0-9-]+$/);
  assert.match(gate.config.release, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(Number.isFinite(gate.config.deploymentTimeoutSeconds) && gate.config.deploymentTimeoutSeconds > 0,
    'GKE eviction proof requires a bounded positive deadline');
  const deadline = Date.now() + gate.config.deploymentTimeoutSeconds * 1000;
  let last;
  do {
    await gate.assertProofContext();
    const read = async (args) => JSON.parse((await gate.kubectl(args, { capture: true })).stdout).items;
    const pods = await read(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=${gate.config.release}`, '-o', 'json']);
    const nodes = await read(['get', 'nodes', '-o', 'json']);
    await gate.assertProofContext();
    try {
      assert.ok(!pods.some(p => removed.includes(p.metadata.uid)), 'evicted frontend UID still exists');
      return assertGkeFrontendAvailability(pods, nodes, gate.config.release);
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw Error('GKE frontends did not reach load-balancer health before the proof deadline', { cause: last });
}

/** Namespace- and UID-fenced voluntary evictions of the frontend pods on two
 * distinct nodes. Never cordon/drain a node (which could affect other tenants),
 * delete workloads directly, or retry an eviction with an uncertain outcome. */
export async function verifyGkeFrontendEvictions(gate, baseUrl) {
  assert.equal(gate.providerValues.availability?.gkeGateway, true, 'GKE eviction proof requires the guarded GKE profile');
  await gate.assertProofContext();
  const namespace = gate.config.namespace;
  const before = await waitForGkeFrontendAvailability(gate);
  await fs.mkdir(gate.config.artifactsDir, { recursive: true });
  await fs.writeFile(path.join(gate.config.artifactsDir, 'provider-frontend-evictions-started.json'),
    JSON.stringify({ at: new Date().toISOString(), namespace, release: gate.config.release }), { flag: 'wx' });
  const report = { phase: 'preflight', evictions: [], before };
  const targets = report.before.filter(p => p.component === 'proxy').slice(0, 2);
  assert.notEqual(targets[0].node, targets[1].node);
  const workflow = startHaWorkflowTraffic(gate, baseUrl, () => report.phase);
  const web = startHaWebAppTraffic(gate, baseUrl, () => report.phase);
  const assertTraffic = () => {
    assert.equal(workflow.report.failures.length, 0, 'workflow traffic failed during frontend eviction');
    assert.equal(web.report.failures.length, 0, 'web-app traffic failed during frontend eviction');
  };
  try {
    for (const target of targets) {
      report.phase = `frontend-node:${target.node}`;
      await waitForGkeFrontendAvailability(gate, report.evictions.map(p => p.uid));
      assertTraffic();
      // Include only the recorded release's frontend peers on this node, not
      // accepted API/execution work or any neighbouring namespace's pods.
      for (const pod of report.before.filter(p => p.node === target.node)) {
        await gate.assertProofContext();
        const current = JSON.parse((await gate.kubectl(['-n', namespace, 'get', 'pod', pod.name, '-o', 'json'], { capture: true })).stdout);
        assert.equal(current.metadata.uid, pod.uid, 'eviction target was replaced');
        assert.equal(current.metadata.name, pod.name);
        assert.equal(current.metadata.namespace, namespace);
        assert.ok(ready(current), 'eviction target is no longer ready or is already terminating');
        assert.equal(current.metadata.labels?.['app.kubernetes.io/instance'], gate.config.release);
        assert.equal(component(current), pod.component);
        const eviction = { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod.name, namespace },
          deleteOptions: { preconditions: { uid: pod.uid } } };
        // Persist intent before sending once, including on a lost acknowledgement.
        report.evictions.push({ ...pod, acknowledged: false });
        await gate.artifact('provider-frontend-evictions.json', JSON.stringify(report, null, 2));
        await gate.assertProofContext();
        assertTraffic();
        await gate.kubectl(['create', '--raw', `/api/v1/namespaces/${namespace}/pods/${pod.name}/eviction`, '-f', '-'],
          { input: JSON.stringify(eviction) });
        report.evictions.at(-1).acknowledged = true;
      }
      report.after = await waitForGkeFrontendAvailability(gate, report.evictions.map(p => p.uid));
    }
    // Non-empty simultaneous public observations are required even in a very
    // fast fixture. Production's long pre-stop normally supplies many samples.
    while (workflow.report.samples < 100 && !workflow.report.failures.length && !web.report.failures.length) {
      await gate.assertProofContext();
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    await Promise.all([workflow.stop(), web.stop()]);
    report.workflow = workflow.report;
    report.webApp = web.report;
    report.phase = 'observed';
    await gate.artifact('provider-frontend-evictions.json', JSON.stringify(report, null, 2));
  }
  assertTraffic();
  assert.ok(report.webApp.samples > 0, 'no public web-app observation');
  report.phase = 'passed';
  await gate.artifact('provider-frontend-evictions.json', JSON.stringify(report, null, 2));
  return report;
}
