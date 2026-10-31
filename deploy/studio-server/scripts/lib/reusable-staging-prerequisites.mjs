import assert from 'node:assert/strict';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { stagingHostname } from './reusable-staging-state.mjs';

/** TLS/SNI only: no credentials, HTTP requests, redirects or application writes. */
export async function verifyStagingTls(origin, { ca, lookup, timeoutMs = 15000 } = {}) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, origin);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  await new Promise((resolve, reject) => {
    let failure,
      verified = false;
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      ...(isIP(url.hostname) ? {} : { servername: url.hostname }),
      rejectUnauthorized: true,
      ca,
      lookup,
    });
    const timer = setTimeout(() => socket.destroy(new Error('Staging TLS prerequisite timed out')), timeoutMs);
    socket.once('secureConnect', () => {
      verified = socket.authorized;
      socket.destroy();
    });
    socket.once('error', (error) => {
      failure = error;
    });
    socket.once('close', () => {
      clearTimeout(timer);
      if (failure || !verified) reject(failure ?? new Error('Staging TLS prerequisite was not verified'));
      else resolve();
    });
  });
}

/** Read-only shared infrastructure admission, before any per-run namespace/CSI work. */
export async function inspectStagingPrerequisites(state, { verifyTls = verifyStagingTls, now = Date.now } = {}) {
  await state.cluster();
  const { settings, operation, api } = state;
  const gateway = await api.json(
    'GET',
    `/apis/gateway.networking.k8s.io/v1/namespaces/${settings.gatewayNamespace}/gateways/${settings.gatewayName}`,
  );
  assert.equal(gateway?.metadata.uid, settings.gatewayUid);
  assert.ok(!gateway.metadata.deletionTimestamp);
  const generation = gateway.metadata.generation;
  const condition = (conditions, type) =>
    conditions?.some((c) => c.type === type && c.status === 'True' && c.observedGeneration === generation);
  assert.ok(
    Number.isSafeInteger(generation) && condition(gateway.status?.conditions, 'Programmed'),
    'Shared staging Gateway is not freshly Programmed',
  );
  const hostname = stagingHostname(settings, operation);
  const listener = gateway.spec?.listeners?.find(
    (l) =>
      l.protocol === 'HTTPS' && l.port === 443 && (l.hostname === `*.${settings.domain}` || l.hostname === hostname),
  );
  assert.ok(listener, 'Shared staging HTTPS listener does not cover the operation hostname');
  const listenerStatus = gateway.status?.listeners?.find((l) => l.name === listener.name);
  assert.ok(
    condition(listenerStatus?.conditions, 'Accepted') && condition(listenerStatus?.conditions, 'ResolvedRefs'),
    'Shared staging listener/certificate is not freshly accepted and resolved',
  );
  assert.equal(listener.allowedRoutes?.namespaces?.from, 'Selector', 'Shared staging routes must be namespace-scoped');
  const selector = listener.allowedRoutes.namespaces.selector;
  assert.deepEqual(
    selector,
    { matchLabels: { 'rivet.dev/qualification-route': 'true' } },
    'Shared staging listener requires the maintained qualification namespace selector',
  );
  if (listener.allowedRoutes.kinds)
    assert.ok(
      listener.allowedRoutes.kinds.some((k) => k.group === 'gateway.networking.k8s.io' && k.kind === 'HTTPRoute'),
      'Shared staging listener does not admit HTTPRoute',
    );
  const storage = await api.json('GET', `/apis/storage.k8s.io/v1/storageclasses/${settings.storageClassName}`);
  assert.equal(storage?.provisioner, 'pd.csi.storage.gke.io', 'Staging requires the reviewed GKE CSI provisioner');
  assert.equal(storage.reclaimPolicy, 'Delete', 'Staging CSI storage must support controller cleanup');
  assert.ok(
    storage.metadata?.uid && !storage.metadata.deletionTimestamp,
    'Staging storage class identity is unavailable',
  );
  const metrics = await api.json('GET', '/apis/metrics.k8s.io/v1beta1/nodes');
  const maxAge = operation.policy.metricsMaxAgeSeconds * 1000;
  assert.ok(Number.isFinite(maxAge) && maxAge > 0);
  assert.ok(
    Array.isArray(metrics?.items) &&
      metrics.items.length &&
      !metrics.metadata?.continue &&
      metrics.items.every((m) => {
        const age = now() - Date.parse(m.timestamp);
        return Number.isFinite(age) && age >= 0 && age <= maxAge && m.usage?.cpu && m.usage?.memory;
      }),
    'Shared staging metrics are missing, stale or incomplete',
  );
  await verifyTls(`https://${hostname}`);
  await state.cluster(); // Reject infrastructure replacement during the TLS check.
  const current = await api.json(
    'GET',
    `/apis/gateway.networking.k8s.io/v1/namespaces/${settings.gatewayNamespace}/gateways/${settings.gatewayName}`,
  );
  assert.equal(current?.metadata.uid, gateway.metadata.uid, 'Shared staging Gateway changed during preflight');
  assert.equal(current.metadata.generation, generation, 'Shared staging listener changed during preflight');
  return { gatewayUid: gateway.metadata.uid, storageClassUid: storage.metadata.uid, publicTlsVerified: true };
}
