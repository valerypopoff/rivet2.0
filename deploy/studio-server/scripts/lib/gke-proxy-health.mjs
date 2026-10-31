import assert from 'node:assert/strict';
import { isIP } from 'node:net';

const condition = 'cloud.google.com/load-balancer-neg-ready';

/** Gateway-managed standalone NEGs can remain WithoutHealthCheck even when
 * regional Compute getHealth reports HEALTHY. That condition is never itself
 * health evidence: callers allowing it must join a fresh backend observation. */
export function hasReadyGkeNegGate(pod, { allowStandalone = false } = {}) {
  return (
    !pod.metadata?.deletionTimestamp &&
    pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') &&
    pod.spec?.readinessGates?.some((g) => g.conditionType === condition) &&
    pod.status.conditions.some(
      (c) =>
        c.type === condition &&
        c.status === 'True' &&
        (c.reason === 'LoadBalancerNegReady' || (allowStandalone && c.reason === 'LoadBalancerNegWithoutHealthCheck')),
    )
  );
}

/** Bind actual healthy IP/port endpoints to every current Pod and its exact
 * Service. Old/surplus healthy endpoints cannot hide an unhealthy replacement. */
export function assertGkeProxyBackendHealth(pods, service, backend, { now = Date.now(), minimumZones = 2 } = {}) {
  assert.ok(
    pods.length && pods.every((p) => hasReadyGkeNegGate(p, { allowStandalone: true })),
    'Proxy readiness/NEG gate is incomplete',
  );
  assert.ok(
    service.metadata.uid && backend.serviceUid === service.metadata.uid,
    'Compute health belongs to another Service',
  );
  assert.ok(
    Object.keys(service.spec.selector ?? {}).length &&
      pods.every(
        (p) =>
          p.metadata.namespace === service.metadata.namespace &&
          Object.entries(service.spec.selector).every(([key, value]) => p.metadata.labels?.[key] === value),
      ),
    'Service does not select the current proxy pool',
  );
  assert.ok(
    Number.isFinite(backend.observedAt) && now >= backend.observedAt && now - backend.observedAt <= 60000,
    'Compute health observation is stale',
  );
  assert.equal(backend.healthy, true, 'Regional backend is not healthy');
  assert.ok(
    typeof backend.backendService === 'string' && backend.backendService,
    'Regional backend identity is missing',
  );
  assert.match(backend.backendServiceId ?? '', /^[1-9][0-9]*$/);
  assert.ok(Array.isArray(backend.healthyEndpoints), 'Regional endpoint health is missing');
  const status = JSON.parse(service.metadata.annotations?.['cloud.google.com/neg-status'] ?? '{}');
  const ports = Object.keys(status.network_endpoint_groups ?? {});
  assert.equal(ports.length, 1, 'Service NEG port is ambiguous');
  const port = service.spec.ports.find((p) => p.port === Number(ports[0]));
  assert.ok(port, 'Service NEG port does not exist');
  const matched = pods.map((pod) => {
    assert.ok(pod.metadata.uid && isIP(pod.status.podIP), 'Proxy endpoint identity is missing');
    const targetPort = port.targetPort ?? port.port;
    const actualPort =
      typeof targetPort === 'number'
        ? targetPort
        : pod.spec.containers.flatMap((c) => c.ports ?? []).find((p) => p.name === targetPort)?.containerPort;
    assert.ok(
      Number.isSafeInteger(actualPort) && actualPort > 0 && actualPort <= 65535,
      'Proxy target port is unavailable',
    );
    const matches = backend.healthyEndpoints.filter((h) => h.ipAddress === pod.status.podIP && h.port === actualPort);
    assert.equal(matches.length, 1, 'Current proxy has no unique healthy regional endpoint');
    const endpoint = matches[0];
    assert.ok(
      status.zones?.includes(endpoint.zone) && endpoint.neg === status.network_endpoint_groups[ports[0]],
      'Endpoint belongs to another NEG',
    );
    return { podUid: pod.metadata.uid, ipAddress: pod.status.podIP, port: actualPort, zone: endpoint.zone };
  });
  assert.equal(new Set(matched.map((p) => p.podUid)).size, matched.length, 'Proxy UID is duplicated');
  assert.equal(new Set(matched.map((p) => p.ipAddress)).size, matched.length, 'Proxy endpoint is duplicated');
  assert.ok(new Set(matched.map((p) => p.zone)).size >= minimumZones, 'Healthy current proxies lack zonal redundancy');
  return matched;
}

/** Readiness polls may wait for newly Ready Pods to enter getHealth. Transport
 * failures still throw; a partial endpoint set must never admit a handoff. */
export function isGkeProxyBackendReady(pods, service, backend, options) {
  try {
    assertGkeProxyBackendHealth(pods, service, backend, options);
    return true;
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') return false;
    throw error;
  }
}
