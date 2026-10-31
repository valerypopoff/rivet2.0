import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { assertProtectedProxyTemplate } from './request-continuity.mjs';
import { createProxyContinuityTransition, buildProxyBridge } from './proxy-continuity-transition.mjs';
import { hasReadyGkeNegGate, assertGkeProxyBackendHealth, isGkeProxyBackendReady } from './gke-proxy-health.mjs';

const exec = promisify(execFile);
const marker = 'rivet.dev/continuity-operation';
const resources = {
  ConfigMap: 'configmaps',
  Service: 'services',
  Deployment: 'deployments.apps',
  Gateway: 'gateways.gateway.networking.k8s.io',
  HTTPRoute: 'httproutes.gateway.networking.k8s.io',
  GCPBackendPolicy: 'gcpbackendpolicies.networking.gke.io',
  HealthCheckPolicy: 'healthcheckpolicies.networking.gke.io',
  PodDisruptionBudget: 'poddisruptionbudgets.policy',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling',
};
const paths = {
  Service: '/api/v1',
  Deployment: '/apis/apps/v1',
  Gateway: '/apis/gateway.networking.k8s.io/v1',
  HTTPRoute: '/apis/gateway.networking.k8s.io/v1',
  GCPBackendPolicy: '/apis/networking.gke.io/v1',
  HealthCheckPolicy: '/apis/networking.gke.io/v1',
  PodDisruptionBudget: '/apis/policy/v1',
};
const negReady = (p) => hasReadyGkeNegGate(p, { allowStandalone: true });

async function defaultAccessToken() {
  const bin = process.env.RIVET_GCLOUD_BIN || 'gcloud';
  // SDK Windows entrypoints are batch files. Only this fixed, read-only command
  // enters cmd.exe; no cloud identifiers or request data become shell text.
  const batch = process.platform === 'win32' && !/\.exe$/i.test(bin);
  if (batch) assert.match(bin, /^[\w :\\/.()-]+$/, 'Unsafe gcloud launcher path');
  const result = await exec(
    batch ? 'cmd.exe' : bin,
    batch ? ['/d', '/s', '/c', `""${bin}" auth print-access-token"`] : ['auth', 'print-access-token'],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  const token = result.stdout.trim();
  assert.ok(token && !/\s/.test(token), 'Cloud access token missing');
  return token;
}

/** Read the actual regional backend, never infer provider state from a policy.
 * getHealth is a read-only Compute operation despite its HTTP POST verb. */
export function createComputeBackendObserver(
  network,
  { fetchImpl = fetch, accessToken = defaultAccessToken, now = Date.now, minimumRequestSeconds = 300 } = {},
) {
  assert.ok(Number.isSafeInteger(minimumRequestSeconds) && minimumRequestSeconds >= 0);
  const project = network.gcpProject,
    region = network.gcpRegion;
  for (const value of [project, region]) assert.match(value, /^[a-z][a-z0-9-]{0,62}$/);
  let token,
    expires = 0;
  const request = async (path, body) => {
    if (!token || now() >= expires) {
      token = await accessToken();
      expires = now() + 300000;
    }
    const response = await fetchImpl(`https://compute.googleapis.com/compute/v1/projects/${project}/${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200, 'Compute backend observation failed');
    return response.json();
  };
  return async (service, { allowPending = false } = {}) => {
    const observedAt = now();
    assert.ok(service.metadata.uid, 'Service identity missing');
    const status = JSON.parse(service.metadata.annotations?.['cloud.google.com/neg-status'] ?? '{}');
    assert.ok(
      status.zones?.length >= 2 &&
        new Set(status.zones).size === status.zones.length &&
        Object.keys(status.network_endpoint_groups ?? {}).length === 1,
      'Service NEG identity missing',
    );
    const neg = Object.values(status.network_endpoint_groups)[0];
    assert.match(neg, /^[a-z0-9-]+$/);
    const groups = status.zones.map((zone) => {
      assert.match(zone, new RegExp(`^${region}-[a-z]$`));
      return `projects/${project}/zones/${zone}/networkEndpointGroups/${neg}`;
    });
    const all = [];
    let page;
    do {
      const result = await request(
        `regions/${region}/backendServices${page ? `?pageToken=${encodeURIComponent(page)}` : ''}`,
      );
      all.push(...(result.items ?? []));
      page = result.nextPageToken;
    } while (page);
    const matches = all.filter(
      (b) =>
        b.backends?.length === groups.length && groups.every((g) => b.backends.some((v) => v.group.endsWith(`/${g}`))),
    );
    assert.ok(matches.length <= 1, 'Service must resolve to exactly one actual regional backend');
    const pending = () => ({
      healthy: false,
      serviceUid: service.metadata.uid,
      observedAt,
      healthyEndpoints: [],
      backendServiceDrainSeconds: 0,
    });
    if (allowPending && (!matches.length || !matches[0].healthChecks?.length)) return pending();
    assert.equal(matches.length, 1, 'Service must resolve to exactly one actual regional backend');
    const backend = matches[0];
    assert.match(backend.name, /^[a-z0-9-]+$/);
    assert.match(String(backend.id), /^[1-9][0-9]*$/);
    assert.ok(backend.healthChecks?.length, 'Regional backend health checks are not attached');
    assert.equal(backend.loadBalancingScheme, 'EXTERNAL_MANAGED');
    assert.ok(
      backend.timeoutSec >= minimumRequestSeconds,
      'Provider request timeout is shorter than the protected request',
    );
    const health = await Promise.all(
      groups.map(async (group) => {
        const result = await request(`regions/${region}/backendServices/${backend.name}/getHealth`, {
          group: `https://www.googleapis.com/compute/v1/${group}`,
        });
        return (result.healthStatus ?? [])
          .filter((h) => h.healthState === 'HEALTHY')
          .map((h) => ({
            ipAddress: h.ipAddress,
            port: h.port,
            zone: group.split('/')[3],
            neg,
          }));
      }),
    );
    return {
      backendServiceDrainSeconds: backend.connectionDraining?.drainingTimeoutSec ?? 0,
      healthy: health.filter((endpoints) => endpoints.length).length >= 2,
      backendService: backend.name,
      backendServiceId: String(backend.id),
      serviceUid: service.metadata.uid,
      observedAt,
      healthyEndpoints: health.flat(),
    };
  };
}

export function createKubernetesProxyContinuity({
  kube,
  config,
  timeoutMs,
  observeBackend = createComputeBackendObserver(config.network),
  fetchImpl = fetch,
  now = () => performance.now(),
  wait = () => new Promise((r) => setTimeout(r, 5000)),
}) {
  const { namespace, network, proxyName, profile } = config;
  const read = async (object, { optional = false } = {}) => {
    assert.ok(resources[object.kind], 'Unsupported ingress resource');
    const raw = (
      await kube([
        '--namespace',
        object.namespace ?? object.metadata?.namespace ?? namespace,
        'get',
        resources[object.kind],
        object.name ?? object.metadata.name,
        ...(optional ? ['--ignore-not-found'] : []),
        '-o',
        'json',
      ])
    ).stdout;
    return raw.trim() ? JSON.parse(raw) : undefined;
  };
  const nsUid = async () => JSON.parse((await kube(['get', 'namespace', namespace, '-o', 'json'])).stdout).metadata.uid;
  const pods = async (instance) =>
    JSON.parse((await kube(['get', 'pods', '-l', `app.kubernetes.io/instance=${instance}`, '-o', 'json'])).stdout)
      .items;
  const until = async (label, check) => {
    const deadline = now() + timeoutMs;
    do {
      if (await check()) return;
      assert.ok(now() < deadline, `Timed out waiting for ${label}; serving capacity retained`);
      await wait();
    } while (true);
  };
  const publicProbe = async (state, target, probe, token) => {
    const route = state.route ?? (await read({ kind: 'HTTPRoute', name: network.routeName }));
    assert.equal(route.spec.hostnames.length, 1);
    const url = new URL(`https://${route.spec.hostnames[0]}/readyz`);
    assert.ok(!url.username && !url.password && url.pathname === '/readyz');
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: probe ? { 'X-Rivet-Continuity-Probe': token } : {},
    });
    await response.body?.cancel();
    assert.equal(response.status, 200, 'Public ingress readiness request failed');
    return response.headers.get('X-Rivet-Continuity-Serving') === target ? target : undefined;
  };
  const healthyPool = async (name, protectedPool, minimum = 2) => {
    const deployment = await read({ kind: 'Deployment', name });
    // Normal release and Deployment names differ; use its exact selector instead.
    const selected = (await pods(deployment.spec.template.metadata.labels['app.kubernetes.io/instance'])).filter((p) =>
      Object.entries(deployment.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v),
    );
    if (selected.length < minimum || selected.some((p) => !negReady(p))) return false;
    if (new Set(selected.map((p) => p.spec.nodeName)).size < 2) return false;
    const sets = JSON.parse((await kube(['get', 'replicasets.apps', '-o', 'json'])).stdout).items;
    const owned = new Set(
      sets
        .filter((r) =>
          r.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === 'Deployment' && o.uid === deployment.metadata.uid,
          ),
        )
        .map((r) => r.metadata.uid),
    );
    assert.ok(
      selected.every((p) =>
        p.metadata.ownerReferences?.some((o) => o.controller && o.kind === 'ReplicaSet' && owned.has(o.uid)),
      ),
      'Proxy pod is not owned by the captured Deployment',
    );
    const nodes = JSON.parse((await kube(['get', 'nodes', '-o', 'json'])).stdout).items;
    const zones = selected.map(
      (p) => nodes.find((n) => n.metadata.name === p.spec.nodeName)?.metadata.labels?.['topology.kubernetes.io/zone'],
    );
    if (zones.some((z) => !z) || new Set(zones).size < 2) return false;
    if (protectedPool) for (const p of selected) assertProtectedProxyTemplate(p, profile);
    const service = await read({ kind: 'Service', name });
    const backend = await observeBackend(service, { allowPending: true });
    if (!isGkeProxyBackendReady(selected, service, backend)) return false;
    return (
      deployment.status?.observedGeneration >= deployment.metadata.generation &&
      deployment.status.availableReplicas >= minimum &&
      deployment.status.updatedReplicas === deployment.spec.replicas &&
      !deployment.metadata.deletionTimestamp
    );
  };
  const io = {
    namespaceUid: nsUid,
    read,
    async baseline() {
      const route = await read({ kind: 'HTTPRoute', name: network.routeName });
      const routes = JSON.parse(
        (await kube(['get', 'httproutes.gateway.networking.k8s.io', '-o', 'json'])).stdout,
      ).items;
      assert.ok(
        routes
          .filter((r) =>
            r.spec.rules?.some((rule) =>
              rule.backendRefs?.some((b) => b.name === proxyName && (!b.namespace || b.namespace === namespace)),
            ),
          )
          .every((r) => r.metadata.uid === route.metadata.uid),
        'All public proxy routes must be covered by the handoff',
      );
      const gateway = await read({
        kind: 'Gateway',
        name: network.gatewayName,
        namespace: route.spec.parentRefs?.[0]?.namespace ?? namespace,
      });
      const policy = await read({ kind: 'GCPBackendPolicy', name: network.backendPolicyName });
      const service = await read({ kind: 'Service', name: policy.spec.targetRef.name });
      const deployment = await read({ kind: 'Deployment', name: proxyName });
      const hpa = await read({ kind: 'HorizontalPodAutoscaler', name: proxyName });
      assert.equal(gateway.spec.gatewayClassName, 'gke-l7-regional-external-managed');
      assert.equal(service.metadata.name, proxyName);
      const proxyPods = (await pods(config.release)).filter((p) =>
        Object.entries(deployment.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v),
      );
      assert.ok(proxyPods.length >= 2 && proxyPods.every(negReady), 'Original proxy pool lacks positive NEG health');
      assert.ok(
        await healthyPool(proxyName, false),
        'Original proxy Deployment is not settled across two provider zones',
      );
      for (const p of proxyPods) {
        const include = (
          await kube(['exec', p.metadata.name, '-c', 'proxy', '--', 'cat', '/tmp/nginx/rivet-proxy-timeout.inc'])
        ).stdout;
        const timeout = /proxy_read_timeout\s+(\d+)s;/.exec(include);
        assert.ok(
          timeout && Number(timeout[1]) >= 360,
          'Set installation runtime proxyReadTimeoutSeconds to at least 360 before adopting 300-second continuity',
        );
      }
      const backend = await observeBackend(service);
      assert.equal(backend.healthy, true, 'Original provider backend is unhealthy');
      assertGkeProxyBackendHealth(proxyPods, service, backend);
      if (config.configName) {
        const existing = await read({ kind: 'ConfigMap', name: config.configName }, { optional: true });
        if (existing) {
          assert.deepEqual(JSON.parse(existing.data.profile), profile, 'Installed continuity profile changed');
          assert.deepEqual(JSON.parse(existing.data.network), network, 'Installed ingress identities changed');
          for (const p of [...proxyPods, deployment.spec.template]) assertProtectedProxyTemplate(p, profile);
          assert.ok(
            backend.backendServiceDrainSeconds >= profile.backendServiceDrainSeconds &&
              policy.spec.default?.connectionDraining?.drainingTimeoutSec >= profile.backendServiceDrainSeconds,
            'Adopted provider drain has regressed',
          );
        }
      }
      return { namespaceUid: await nsUid(), route, gateway, policy, service, deployment, hpa, proxyPods, ...backend };
    },
    async create(resource) {
      await kube(['create', '-f', '-'], { input: JSON.stringify(resource) });
    },
    async beforeCreate(resource, state) {
      if (resource.kind !== 'Deployment') return;
      await until('bridge NEG discovery before Pod admission', async () => {
        const service = await read({ kind: 'Service', name: state.name });
        const status = JSON.parse(service.metadata.annotations?.['cloud.google.com/neg-status'] ?? '{}');
        return status.zones?.length >= 2 && Object.keys(status.network_endpoint_groups ?? {}).length === 1;
      });
    },
    async ready(state) {
      await until('protected bridge proxy capacity', () => healthyPool(state.name, true, state.bridgeReplicas));
    },
    async sourceReady(state) {
      await until('normal HPA reaches the protected handoff floor', () =>
        healthyPool(proxyName, false, state.bridgeReplicas),
      );
    },
    async normalReady(_config, state) {
      await until('protected current normal proxy capacity', () => healthyPool(proxyName, true, state.bridgeReplicas));
    },
    async observe({ state, target, probe, token }) {
      const service = await read({ kind: 'Service', name: target === 'bridge' ? state.name : proxyName });
      const backend = await observeBackend(service);
      const selected = (await pods(target === 'bridge' ? state.name : config.release)).filter((p) =>
        Object.entries(service.spec.selector).every(([key, value]) => p.metadata.labels?.[key] === value),
      );
      assertGkeProxyBackendHealth(selected, service, backend);
      // The old backend must have received its longer drain before switching.
      const original =
        target === 'bridge' ? await observeBackend(await read({ kind: 'Service', name: proxyName })) : backend;
      return {
        healthy: backend.healthy,
        backendServiceDrainSeconds: Math.min(backend.backendServiceDrainSeconds, original.backendServiceDrainSeconds),
        routedTo: await publicProbe(state, target, probe, token),
      };
    },
    async patch(current, spec, annotations) {
      const patch = [
        { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
        { op: 'replace', path: '/spec', value: spec },
        { op: 'add', path: '/metadata/annotations', value: annotations },
      ];
      await kube([
        '--namespace',
        current.metadata.namespace,
        'patch',
        resources[current.kind],
        current.metadata.name,
        '--type=json',
        '-p',
        JSON.stringify(patch),
      ]);
    },
    async remove(current) {
      const resource = resources[current.kind].split('.')[0];
      const uri = `${paths[current.kind]}/namespaces/${namespace}/${resource}/${current.metadata.name}`;
      await kube(['delete', '--raw', uri, '-f', '-'], {
        input: JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
          propagationPolicy: 'Foreground',
        }),
      });
    },
    async absent(entry) {
      await until('owned bridge deletion', async () => {
        const live = await read(entry.desired, { optional: true });
        if (live) {
          assert.equal(live.metadata.uid, entry.uid, 'A replacement bridge object must not be deleted');
          return false;
        }
        if (entry.desired.kind === 'Deployment') {
          const remaining = await pods(entry.desired.metadata.name);
          assert.ok(
            remaining.every((p) => p.metadata.annotations?.[marker] === entry.desired.metadata.annotations[marker]),
            'Foreign bridge pod found',
          );
          return remaining.length === 0;
        }
        return true;
      });
    },
  };
  const transition = createProxyContinuityTransition({ config, io, timeoutMs, now, wait });
  return {
    ...transition,
    async inspect() {
      const baseline = await io.baseline();
      buildProxyBridge(baseline, config, '00000000-0000-4000-8000-000000000000');
      let protectedProxies = true;
      try {
        for (const p of [...baseline.proxyPods, baseline.deployment.spec.template])
          assertProtectedProxyTemplate(p, config.profile);
      } catch {
        protectedProxies = false;
      }
      return {
        protocol: 1,
        profile: config.profile,
        namespaceUid: baseline.namespaceUid,
        routeUid: baseline.route.metadata.uid,
        policyUid: baseline.policy.metadata.uid,
        gatewayUid: baseline.gateway.metadata.uid,
        proxyUid: baseline.deployment.metadata.uid,
        hpaUid: baseline.hpa.metadata.uid,
        actualBackendServiceDrainSeconds: baseline.backendServiceDrainSeconds,
        policyBackendServiceDrainSeconds: baseline.policy.spec.default?.connectionDraining?.drainingTimeoutSec ?? 0,
        protectedProxies,
        workloadMutations: false,
      };
    },
  };
}
