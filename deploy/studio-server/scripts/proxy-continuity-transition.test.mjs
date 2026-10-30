import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProxyBridge,
  createProxyContinuityTransition,
  proxyContinuitySettled,
} from './lib/proxy-continuity-transition.mjs';
import { createComputeBackendObserver, createKubernetesProxyContinuity } from './lib/proxy-continuity-kubernetes.mjs';
import { assertContinuityAcceptance } from './lib/request-continuity.mjs';

const profile = {
  protocol: 1,
  maxProtectedRequestSeconds: 300,
  backendServiceDrainSeconds: 600,
  propagationSeconds: 60,
  proxyPreStopDelaySeconds: 660,
  proxyTerminationGracePeriodSeconds: 900,
};
const config = {
  profile,
  network: {
    routeName: 'route',
    backendPolicyName: 'policy',
    gatewayName: 'gateway',
    gcpProject: 'fixture-project',
    gcpRegion: 'europe-central2',
  },
  release: 'rivet',
  namespace: 'fixture',
  proxyName: 'rivet-proxy',
  hpaSpec: {
    scaleTargetRef: { kind: 'Deployment', name: 'rivet-proxy' },
    minReplicas: 2,
    maxReplicas: 4,
    behavior: { scaleDown: { selectPolicy: 'Max' } },
  },
};
const object = (kind, name, spec) => ({
  apiVersion: 'v1',
  kind,
  metadata: { name, namespace: 'fixture', uid: `uid-${name}`, resourceVersion: '1' },
  spec,
});
function fixture() {
  const route = object('HTTPRoute', 'route', {
    parentRefs: [{ name: 'gateway' }],
    hostnames: ['fixture.example.test'],
    rules: [
      {
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ name: 'rivet-proxy', port: 80 }],
      },
    ],
  });
  const policy = object('GCPBackendPolicy', 'policy', {
    default: { timeoutSec: 3600, connectionDraining: { drainingTimeoutSec: 60 } },
    targetRef: { group: '', kind: 'Service', name: 'rivet-proxy' },
  });
  const template = {
    metadata: { labels: { 'app.kubernetes.io/instance': 'rivet', 'app.kubernetes.io/component': 'proxy' } },
    spec: {
      terminationGracePeriodSeconds: 270,
      containers: [
        {
          name: 'proxy',
          image: `proxy@sha256:${'a'.repeat(64)}`,
          lifecycle: { preStop: { exec: { command: ['/bin/sh', '-c', 'sleep 120'] } } },
        },
      ],
    },
  };
  const deployment = object('Deployment', 'rivet-proxy', {
    replicas: 2,
    selector: { matchLabels: template.metadata.labels },
    template,
  });
  const service = object('Service', 'rivet-proxy', {
    selector: template.metadata.labels,
    ports: [{ port: 80, targetPort: 'http' }],
  });
  const gateway = object('Gateway', 'gateway', { gatewayClassName: 'gke-l7-regional-external-managed' });
  const hpa = object('HorizontalPodAutoscaler', 'rivet-proxy', config.hpaSpec);
  const baseline = {
    namespaceUid: 'ns-uid',
    route,
    policy,
    deployment,
    service,
    gateway,
    hpa,
    proxyPods: [template, template],
    backendServiceDrainSeconds: 60,
  };
  const key = (r) => `${r.kind}/${r.name ?? r.metadata.name}`;
  const live = new Map([route, policy, deployment, service, gateway, hpa].map((r) => [key(r), structuredClone(r)]));
  let clock = 0;
  const events = [];
  const operation = {
    record: { token: '00000000-0000-4000-8000-000000000001' },
    assertLease() {},
    async checkpoint(patch) {
      Object.assign(this.record, structuredClone(patch));
    },
  };
  const io = {
    async namespaceUid() {
      return 'ns-uid';
    },
    async baseline() {
      return structuredClone(baseline);
    },
    async read(r, { optional = false } = {}) {
      const found = live.get(key(r));
      if (!found && !optional) throw Error('NotFound');
      return found && structuredClone(found);
    },
    async create(r) {
      assert.ok(!live.has(key(r)));
      const v = structuredClone(r);
      v.metadata.uid = `new-${key(r)}`;
      v.metadata.resourceVersion = '1';
      live.set(key(r), v);
      events.push(['create', r.kind]);
    },
    async beforeCreate(r) {
      events.push(['beforeCreate', r.kind]);
    },
    async ready() {},
    async sourceReady() {},
    async normalReady() {
      events.push(['normalReady', clock]);
    },
    async patch(r, spec, annotations) {
      const v = live.get(key(r));
      assert.equal(v.metadata.resourceVersion, r.metadata.resourceVersion);
      v.spec = structuredClone(spec);
      v.metadata.annotations = structuredClone(annotations);
      v.metadata.resourceVersion = String(Number(v.metadata.resourceVersion) + 1);
      events.push(['patch', r.kind, clock]);
    },
    async observe({ target }) {
      return { healthy: true, routedTo: target, backendServiceDrainSeconds: 600 };
    },
    async remove(r) {
      events.push(['remove', r.kind, clock]);
      live.delete(key(r));
    },
    async absent(entry) {
      assert.ok(!live.has(key(entry.desired)));
    },
  };
  const transition = () =>
    createProxyContinuityTransition({
      config,
      io,
      timeoutMs: 1200000,
      now: () => clock,
      wait: async () => {
        clock += 60000;
      },
    });
  const restore = async () => {
    const t = transition();
    await t.beforeRestoreAutoscalers(operation);
    const current = await io.read(hpa);
    await io.patch(current, hpa.spec, {});
    await t.afterRestoreAutoscalers(operation);
  };
  return {
    baseline,
    live,
    io,
    operation,
    events,
    transition,
    restore,
    advance: (n) => {
      clock += n;
    },
  };
}

test('first transition keeps predecessors through both full drain windows and cleans only its bridge', async () => {
  const f = fixture(),
    t = f.transition();
  await t.prepare(f.operation);
  assert.equal(f.operation.record.proxyContinuity.phase, 'bridge-serving');
  assert.equal(proxyContinuitySettled(f.operation.record), false);
  assert.ok(f.events.some((e) => e[0] === 'beforeCreate' && e[1] === 'Deployment'));
  assert.ok(!f.events.some((e) => e[0] === 'remove'));
  assert.equal(f.events.filter((e) => e[0] === 'patch' && e[1] === 'HTTPRoute')[0][2], 60000);
  await assert.rejects(t.finish(f.operation), /HPA must be restored/);
  await f.restore();
  await t.finish(f.operation);
  assert.ok(proxyContinuitySettled(f.operation.record));
  assert.equal(f.live.size, 6);
  assert.deepEqual(f.live.get('HTTPRoute/route').spec, f.baseline.route.spec);
  assert.deepEqual(f.live.get('GCPBackendPolicy/policy').metadata.annotations, {});
  assert.equal(f.live.get('GCPBackendPolicy/policy').spec.default.connectionDraining.drainingTimeoutSec, 600);
  assert.ok(f.events.find((e) => e[0] === 'remove')[2] >= 1260000);
});

test('lost route acknowledgement is observed on recovery without a duplicate patch', async () => {
  const f = fixture(),
    patch = f.io.patch;
  let lost = false;
  f.io.patch = async (...args) => {
    await patch(...args);
    if (args[0].kind === 'HTTPRoute' && !lost) {
      lost = true;
      throw Error('lost response');
    }
  };
  await assert.rejects(f.transition().prepare(f.operation), /lost response/);
  assert.ok(!proxyContinuitySettled(f.operation.record));
  await f.transition().prepare(f.operation);
  assert.equal(f.events.filter((e) => e[0] === 'patch' && e[1] === 'HTTPRoute').length, 1);
  const patch2 = f.io.patch;
  f.io.patch = async (...args) => {
    await patch2(...args);
    if (args[0].kind === 'HTTPRoute' && !args[2]['rivet.dev/continuity-operation']) throw Error('lost restore');
  };
  await assert.rejects(f.restore(), /lost restore/);
  f.io.patch = patch;
  await f.restore();
  await f.transition().finish(f.operation);
  assert.ok(proxyContinuitySettled(f.operation.record));
});
test('every bridge creation fences an unapplied intent and observes a committed lost acknowledgement', async () => {
  for (const kind of [
    'Service',
    'GCPBackendPolicy',
    'HealthCheckPolicy',
    'HTTPRoute',
    'Deployment',
    'PodDisruptionBudget',
  ])
    for (const committed of [false, true]) {
      const f = fixture(),
        create = f.io.create;
      let dispatched = 0;
      f.io.create = async (resource) => {
        if (resource.kind !== kind) return create(resource);
        dispatched++;
        if (committed) await create(resource);
        throw Error('lost create acknowledgement');
      };
      await assert.rejects(f.transition().prepare(f.operation), /lost create/);
      if (committed) {
        await f.transition().prepare(f.operation);
        assert.equal(f.operation.record.proxyContinuity.phase, 'bridge-serving');
      } else await assert.rejects(f.transition().prepare(f.operation), /NotFound/);
      assert.equal(dispatched, 1, `${kind} must never replay an unknown create`);
      assert.ok(!f.events.some((e) => e[0] === 'remove'), 'Uncertain capacity is retained');
    }
});

test('unapplied unknown intent, foreign route edits and replacement UIDs retain serving capacity', async () => {
  for (const fault of ['unapplied', 'foreign', 'uid']) {
    const f = fixture();
    if (fault === 'unapplied') {
      f.io.patch = async () => {
        throw Error('transport failed');
      };
      await assert.rejects(f.transition().prepare(f.operation));
    } else {
      await f.transition().prepare(f.operation);
      const route = f.live.get('HTTPRoute/route');
      if (fault === 'foreign') route.spec.hostnames = ['foreign.example.test'];
      else route.metadata.uid = 'replacement';
    }
    await assert.rejects(f.transition().prepare(f.operation));
    await assert.rejects(f.transition().finish(f.operation));
    assert.ok(!f.events.some((e) => e[0] === 'remove'));
    assert.ok(!proxyContinuitySettled(f.operation.record));
  }
});

test('lost delete response is observed, while a replacement bridge object is never deleted', async () => {
  const f = fixture();
  await f.transition().prepare(f.operation);
  await f.restore();
  const remove = f.io.remove;
  let lost = false;
  f.io.remove = async (r) => {
    await remove(r);
    if (!lost) {
      lost = true;
      throw Error('lost delete');
    }
  };
  await assert.rejects(f.transition().finish(f.operation), /lost delete/);
  await f.transition().finish(f.operation);
  assert.ok(proxyContinuitySettled(f.operation.record));
  const g = fixture();
  await g.transition().prepare(g.operation);
  const entry = g.operation.record.proxyContinuity.entries.at(-1);
  g.live.get(`${entry.desired.kind}/${entry.desired.metadata.name}`).metadata.uid = 'replacement';
  await assert.rejects(g.transition().finish(g.operation), /replacement/);
  assert.ok(!g.events.some((e) => e[0] === 'remove'));
});

test('a committed return-route write with a lost response resumes without expecting the old bridge route', async () => {
  const f = fixture(),
    patch = f.io.patch;
  await f.transition().prepare(f.operation);
  let lost = false;
  f.io.patch = async (...args) => {
    await patch(...args);
    if (args[0].kind === 'HTTPRoute' && args[1].rules[0].backendRefs[0].weight === 1 && !lost) {
      lost = true;
      throw Error('lost return-route response');
    }
  };
  f.io.observe = async ({ target }) => {
    const route = f.live.get('HTTPRoute/route'),
      actual = route.spec.rules[0].filters?.at(-1)?.responseHeaderModifier.set[0].value;
    return { healthy: true, backendServiceDrainSeconds: 600, routedTo: actual === target ? target : undefined };
  };
  await assert.rejects(f.restore(), /lost return-route response/);
  await f.transition().verify(f.operation);
  await f.restore();
  await f.transition().finish(f.operation);
  assert.ok(proxyContinuitySettled(f.operation.record));
  assert.equal(
    f.events.filter((e) => e[0] === 'patch' && e[1] === 'HTTPRoute').length,
    3,
    'Handoff, return and restoration each dispatch once',
  );
});

test('bridge placement preserves unrelated peer selector constraints', () => {
  const f = fixture();
  f.baseline.deployment.spec.template.spec.topologySpreadConstraints = [
    {
      labelSelector: {
        matchLabels: { ...f.baseline.deployment.spec.selector.matchLabels, 'installation-pool': 'reviewed' },
      },
    },
  ];
  const bridge = buildProxyBridge(f.baseline, config, 'token');
  const deployment = bridge.entries.find((e) => e.desired.kind === 'Deployment').desired;
  assert.equal(
    deployment.spec.template.spec.topologySpreadConstraints[0].labelSelector.matchLabels['installation-pool'],
    'reviewed',
  );
  assert.equal(deployment.spec.replicas, 4);
});

test('unsupported shared routes and plaintext credentials fail before any creation', () => {
  const f = fixture();
  f.baseline.route.spec.rules[0].backendRefs.push({ name: 'foreign', port: 80 });
  assert.throws(() => buildProxyBridge(f.baseline, config, 'token'), /Unsupported public route/);
  f.baseline.route.spec.rules[0].backendRefs.pop();
  f.baseline.route.spec.rules[0].filters = [
    { type: 'RequestMirror', requestMirror: { backendRef: { name: 'foreign', port: 80 } } },
  ];
  assert.throws(() => buildProxyBridge(f.baseline, config, 'token'), /Mirrored routes/);
  delete f.baseline.route.spec.rules[0].filters;
  f.baseline.route.spec.rules[0].backendRefs[0].port = 9999;
  assert.throws(() => buildProxyBridge(f.baseline, config, 'token'), /unknown proxy port/);
  f.baseline.route.spec.rules[0].backendRefs[0].port = 80;
  f.baseline.deployment.spec.template.spec.containers[0].env = [{ name: 'RIVET_KEY_SECRET', value: 'private' }];
  assert.throws(() => buildProxyBridge(f.baseline, config, 'token'), /Plaintext/);
});

test('actual backend observation binds the exact regional NEG groups and checks provider timeout, drain and health', async () => {
  const groups = ['a', 'b'].map(
    (z) =>
      `https://www.googleapis.com/compute/v1/projects/fixture-project/zones/europe-central2-${z}/networkEndpointGroups/fixture-neg`,
  );
  const backend = {
    name: 'actual-backend',
    backends: groups.map((group) => ({ group })),
    loadBalancingScheme: 'EXTERNAL_MANAGED',
    timeoutSec: 3600,
    connectionDraining: { drainingTimeoutSec: 600 },
  };
  const calls = [];
  const observe = createComputeBackendObserver(config.network, {
    accessToken: async () => 'private',
    fetchImpl: async (url, options) => {
      calls.push([url, options.method]);
      return {
        status: 200,
        json: async () =>
          url.endsWith('/getHealth') ? { healthStatus: [{ healthState: 'HEALTHY' }] } : { items: [backend] },
      };
    },
  });
  const service = {
    metadata: {
      annotations: {
        'cloud.google.com/neg-status': JSON.stringify({
          zones: ['europe-central2-a', 'europe-central2-b'],
          network_endpoint_groups: { 80: 'fixture-neg' },
        }),
      },
    },
  };
  assert.deepEqual(await observe(service), {
    backendServiceDrainSeconds: 600,
    healthy: true,
    backendService: 'actual-backend',
  });
  assert.equal(calls.length, 3);
  const duplicate = structuredClone(service);
  duplicate.metadata.annotations['cloud.google.com/neg-status'] = JSON.stringify({
    zones: ['europe-central2-a', 'europe-central2-a'],
    network_endpoint_groups: { 80: 'fixture-neg' },
  });
  await assert.rejects(observe(duplicate), /Service NEG identity missing/);
  assert.equal(calls.length, 3, 'Duplicate zones are refused before provider calls');
  backend.timeoutSec = 120;
  await assert.rejects(observe(service), /timeout/);
  backend.timeoutSec = 3600;
  backend.backends.push({ group: 'foreign' });
  await assert.rejects(observe(service), /exactly one/);
});

test('Kubernetes adapter runs the full owned handoff with NEG admission, live policy observations and UID-preconditioned cleanup', async () => {
  const f = fixture(),
    commands = [];
  let clock = 0;
  const types = {
    services: 'Service',
    'deployments.apps': 'Deployment',
    'gateways.gateway.networking.k8s.io': 'Gateway',
    'httproutes.gateway.networking.k8s.io': 'HTTPRoute',
    'gcpbackendpolicies.networking.gke.io': 'GCPBackendPolicy',
    'healthcheckpolicies.networking.gke.io': 'HealthCheckPolicy',
    'poddisruptionbudgets.policy': 'PodDisruptionBudget',
    'horizontalpodautoscalers.autoscaling': 'HorizontalPodAutoscaler',
  };
  const decorate = (r) => {
    r = structuredClone(r);
    if (r.kind === 'Service')
      r.metadata.annotations = {
        ...r.metadata.annotations,
        'cloud.google.com/neg-status': JSON.stringify({
          zones: ['europe-central2-a', 'europe-central2-b'],
          network_endpoint_groups: { 80: `neg-${r.metadata.name}` },
        }),
      };
    if (r.kind === 'Deployment') {
      r.metadata.generation = 1;
      r.status = { observedGeneration: 1, availableReplicas: r.spec.replicas, updatedReplicas: r.spec.replicas };
    }
    return r;
  };
  const kube = async (raw, options = {}) => {
    const args = [...raw];
    commands.push(args);
    if (args[0] === '--namespace') args.splice(0, 2);
    const [action, type, name] = args;
    let result;
    if (action === 'get' && type === 'namespace') result = { metadata: { uid: 'ns-uid' } };
    else if (action === 'get' && type === 'nodes')
      result = {
        items: ['a', 'b', 'a', 'b'].map((z, i) => ({
          metadata: {
            name: `node${i}`,
            uid: `nodeuid${i}`,
            labels: { 'topology.kubernetes.io/zone': `europe-central2-${z}` },
          },
        })),
      };
    else if (action === 'get' && type === 'pods') {
      const instance = args[args.indexOf('-l') + 1].split('=')[1];
      result = {
        items: [...f.live.values()]
          .filter(
            (r) =>
              r.kind === 'Deployment' && r.spec.template.metadata.labels['app.kubernetes.io/instance'] === instance,
          )
          .flatMap((d) =>
            Array.from({ length: d.spec.replicas }, (_, i) => ({
              apiVersion: 'v1',
              kind: 'Pod',
              metadata: {
                name: `${d.metadata.name}-${i}`,
                uid: `${d.metadata.uid}-pod${i}`,
                labels: d.spec.template.metadata.labels,
                annotations: d.spec.template.metadata.annotations,
                ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: `${d.metadata.uid}-rs` }],
              },
              spec: {
                ...structuredClone(d.spec.template.spec),
                nodeName: `node${i}`,
                readinessGates: [{ conditionType: 'cloud.google.com/load-balancer-neg-ready' }],
              },
              status: {
                conditions: [
                  { type: 'Ready', status: 'True' },
                  { type: 'cloud.google.com/load-balancer-neg-ready', status: 'True', reason: 'LoadBalancerNegReady' },
                ],
              },
            })),
          ),
      };
    } else if (action === 'get' && type === 'httproutes.gateway.networking.k8s.io' && name === '-o') {
      result = { items: [...f.live.values()].filter((r) => r.kind === 'HTTPRoute') };
    } else if (action === 'get' && type === 'replicasets.apps') {
      result = {
        items: [...f.live.values()]
          .filter((r) => r.kind === 'Deployment')
          .map((d) => ({
            metadata: {
              uid: `${d.metadata.uid}-rs`,
              ownerReferences: [{ kind: 'Deployment', controller: true, uid: d.metadata.uid }],
            },
          })),
      };
    } else if (action === 'get') {
      const found = f.live.get(`${types[type]}/${name}`);
      if (!found) {
        assert.ok(args.includes('--ignore-not-found'));
        return { stdout: '' };
      }
      result = decorate(found);
    } else if (action === 'exec') {
      assert.deepEqual(args.slice(-2), ['cat', '/tmp/nginx/rivet-proxy-timeout.inc']);
      return { stdout: 'proxy_read_timeout 3600s;' };
    } else if (action === 'create') {
      const desired = JSON.parse(options.input),
        key = `${desired.kind}/${desired.metadata.name}`;
      assert.ok(!f.live.has(key));
      desired.metadata.uid = `new-${key}`;
      desired.metadata.resourceVersion = '1';
      f.live.set(key, desired);
      result = desired;
    } else if (action === 'patch') {
      const current = f.live.get(`${types[type]}/${name}`),
        patch = JSON.parse(args[args.indexOf('-p') + 1]);
      assert.equal(current.metadata.uid, patch[0].value);
      assert.equal(current.metadata.resourceVersion, patch[1].value);
      current.spec = patch[2].value;
      current.metadata.annotations = patch[3].value;
      current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
      if (current.kind === 'HorizontalPodAutoscaler') {
        // Model the existing HPA honoring its temporary minimum, not a manual
        // Deployment scale operation from the transition adapter.
        const deployment = f.live.get('Deployment/rivet-proxy');
        deployment.spec.replicas = Math.max(deployment.spec.replicas, current.spec.minReplicas);
      }
      result = current;
    } else if (action === 'delete') {
      assert.equal(type, '--raw');
      const segments = name.split('/'),
        plural = segments.at(-2),
        objectName = segments.at(-1);
      const kind = Object.entries(types).find(([t]) => t.split('.')[0] === plural)[1],
        key = `${kind}/${objectName}`,
        current = f.live.get(key),
        deletion = JSON.parse(options.input);
      assert.deepEqual(deletion.preconditions, {
        uid: current.metadata.uid,
        resourceVersion: current.metadata.resourceVersion,
      });
      assert.equal(deletion.propagationPolicy, 'Foreground');
      f.live.delete(key);
      result = {};
    } else throw Error(`Unexpected fixture command ${action}`);
    return { stdout: JSON.stringify(result) };
  };
  const adapter = createKubernetesProxyContinuity({
    kube,
    config,
    timeoutMs: 1200000,
    now: () => clock,
    wait: async () => {
      clock += 60000;
    },
    observeBackend: async (service) => ({
      healthy: true,
      backendServiceDrainSeconds: f.live.get(
        `GCPBackendPolicy/${service.metadata.name === 'rivet-proxy' ? 'policy' : service.metadata.name}`,
      ).spec.default.connectionDraining.drainingTimeoutSec,
    }),
    fetchImpl: async (_url, options) => {
      const probe = options.headers['X-Rivet-Continuity-Probe'];
      const filters = f.live.get('HTTPRoute/route').spec.rules[0].filters;
      const target = probe ? 'bridge' : filters?.at(-1).responseHeaderModifier.set[0].value;
      return new Response('{}', { status: 200, headers: target ? { 'X-Rivet-Continuity-Serving': target } : {} });
    },
  });
  const before = commands.length;
  assert.equal((await adapter.inspect()).actualBackendServiceDrainSeconds, 60);
  assert.ok(commands.slice(before).every((a) => ['get', 'exec'].includes(a[0] === '--namespace' ? a[2] : a[0])));
  await adapter.prepare(f.operation);
  assert.equal(f.live.get('HorizontalPodAutoscaler/rivet-proxy').spec.behavior.scaleDown.selectPolicy, 'Disabled');
  assert.equal(f.live.get('HorizontalPodAutoscaler/rivet-proxy').spec.minReplicas, 4);
  assert.deepEqual(adapter.templateValues(f.operation), {
    autoscaling: { proxy: { minReplicas: 4, scaleDownPaused: true } },
  });
  await adapter.verify(f.operation);
  const template = f.live.get('Deployment/rivet-proxy').spec.template;
  template.spec.terminationGracePeriodSeconds = 900;
  template.spec.containers[0].lifecycle.preStop.exec.command = ['/bin/sh', '-c', 'sleep 660'];
  await adapter.beforeRestoreAutoscalers(f.operation);
  assert.deepEqual(f.live.get('HTTPRoute/route').spec, f.baseline.route.spec, 'Traffic returns before HPA restoration');
  assert.deepEqual(adapter.templateValues(f.operation), {});
  f.live.get('HorizontalPodAutoscaler/rivet-proxy').spec = structuredClone(config.hpaSpec);
  await adapter.afterRestoreAutoscalers(f.operation);
  await adapter.finish(f.operation);
  assert.equal(f.live.size, 6);
  assert.ok(proxyContinuitySettled(f.operation.record));
  const receipt = await adapter.inspect();
  assertContinuityAcceptance(receipt, profile);
  assert.throws(
    () => assertContinuityAcceptance({ ...receipt, actualBackendServiceDrainSeconds: 60 }, profile),
    /regressed/,
  );
  assert.throws(() => assertContinuityAcceptance({ ...receipt, protectedProxies: false }, profile), /lifecycle/);
  assert.ok(commands.some((a) => a[0] === 'delete' && a[1] === '--raw'));
});

test('already-protected pools still enforce ingress invariants under the operation lease', async () => {
  for (const unsupported of [false, true]) {
    const f = fixture(),
      template = f.baseline.deployment.spec.template;
    template.spec.terminationGracePeriodSeconds = 900;
    template.spec.containers[0].lifecycle.preStop.exec.command = ['/bin/sh', '-c', 'sleep 660'];
    f.baseline.backendServiceDrainSeconds = 600;
    f.baseline.policy.spec.default.connectionDraining.drainingTimeoutSec = 600;
    f.live.set('Deployment/rivet-proxy', structuredClone(f.baseline.deployment));
    f.live.set('GCPBackendPolicy/policy', structuredClone(f.baseline.policy));
    if (unsupported) f.baseline.route.spec.rules[0].backendRefs.push({ name: 'another-service', port: 80 });
    if (unsupported) {
      await assert.rejects(f.transition().prepare(f.operation), /Unsupported public route/);
      assert.equal(f.operation.record.proxyContinuity, undefined);
    } else {
      await f.transition().prepare(f.operation);
      assert.ok(proxyContinuitySettled(f.operation.record));
      assert.deepEqual(f.operation.record.proxyContinuity.entries, []);
    }
    assert.deepEqual(f.events, [], 'Validation never creates a bridge for an already-protected pool');
  }
});

test('deadlines that cannot cover a protected phase fail before any mutation', () => {
  for (const timeoutMs of [600000, 900000])
    assert.throws(() => createProxyContinuityTransition({ config, io: {}, timeoutMs }), /deadline must exceed/);
  const longPropagation = {
    ...config,
    profile: {
      ...profile,
      propagationSeconds: 1200,
      proxyPreStopDelaySeconds: 1800,
      proxyTerminationGracePeriodSeconds: 1945,
    },
  };
  assert.throws(
    () => createProxyContinuityTransition({ config: longPropagation, io: {}, timeoutMs: 1500000 }),
    /deadline must exceed/,
  );
});
