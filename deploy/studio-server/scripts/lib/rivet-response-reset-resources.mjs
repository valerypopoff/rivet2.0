import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { connectionResetResources } from './connection-reset-resources.mjs';
import { diagnosticLabel, diagnosticPodReady } from './connection-reset-diagnostic.mjs';

export function rivetResetResources({ namespace, apiImage, sources, tls, retainBackend = false }) {
  assert.equal(typeof retainBackend, 'boolean');
  assert.match(apiImage, /^ghcr\.io\/valerypopoff\/rivet2\.0-studio-server\/api@sha256:[a-f0-9]{64}$/);
  const { 'real-diagnostic.mjs': realDiagnostic, 'error.mjs': errorSource, ...wireSources } = sources;
  assert.ok(realDiagnostic && errorSource);
  const bundle = connectionResetResources({ namespace, sources: wireSources, tls });
  bundle.items = bundle.items.filter((r) => !(r.kind === 'Service' && ['a', 'b'].includes(r.metadata.name)));
  if (retainBackend) {
    const retained = structuredClone(bundle.items.find((r) => r.kind === 'Service' && r.metadata.name === 'execution'));
    retained.metadata.name = 'execution-connections';
    retained.spec.publishNotReadyAddresses = true;
    delete retained.spec.selector.pool;
    retained.spec.selector['rivet.dev/diagnostic-backend'] = '1';
    for (const pod of bundle.items.filter((r) => r.kind === 'Pod' && ['a', 'b'].includes(r.metadata.name)))
      pod.metadata.labels['rivet.dev/diagnostic-backend'] = '1';
    bundle.items.push(retained);
  }
  const sourceConfig = bundle.items.find((r) => r.kind === 'ConfigMap');
  const proxyConfig = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { ...structuredClone(sourceConfig.metadata), name: 'proxy-config' },
    immutable: true,
    data: { 'nginx.conf': sourceConfig.data['nginx.conf'] },
  };
  delete sourceConfig.data['nginx.conf'];
  bundle.items.push(proxyConfig);
  for (const r of bundle.items) {
    if (r === sourceConfig) {
      r.data['real-diagnostic.mjs'] = realDiagnostic;
      r.data['error.mjs'] = errorSource;
    }
    const spec = r.kind === 'Pod' ? r.spec : r.kind === 'Job' ? r.spec.template.spec : null;
    if (!spec) continue;
    // The base fixture shares volume objects. Each workload needs its own
    // projection before assigning the proxy's separate create-only config.
    spec.volumes = structuredClone(spec.volumes);
    const source = spec.volumes.find((v) => v.name === 'source').configMap;
    if (r.kind === 'Pod' && r.metadata.name === 'proxy') {
      source.name = 'proxy-config';
      source.items = [{ key: 'nginx.conf', path: 'nginx.conf' }];
      continue;
    }
    source.items = source.items.filter((item) => item.key !== 'nginx.conf');
    source.items.find((item) => item.key === 'runtime.mjs').path = 'fixtures/rivet-response-reset-runtime.mjs';
    source.items.push({ key: 'real-diagnostic.mjs', path: 'lib/rivet-response-reset.mjs' });
    source.items.push({ key: 'error.mjs', path: 'lib/kubernetes-response-error.mjs' });
    if (r.metadata.name !== 'proxy')
      spec.containers[0].command[1] = '/diagnostic/fixtures/rivet-response-reset-runtime.mjs';
    if (['a', 'b'].includes(r.metadata.name)) {
      spec.containers[0].image = apiImage;
      spec.volumes.find((v) => v.name === 'tmp').emptyDir.sizeLimit = '64Mi';
    }
  }
  return bundle;
}

/** Use observed Pod IPs directly. Keeping A behind a second ClusterIP can keep
 * its Cilium backend referenced and conceal the original removal condition. */
export function completeRivetResetResources(bundle, inventory) {
  const namespace = bundle.items.find((r) => r.kind === 'Namespace').metadata.name;
  const pods = ['a', 'b'].map((name) => {
    const matches = inventory.items.filter((r) => r.kind === 'Pod' && r.metadata?.name === name);
    assert.equal(matches.length, 1);
    const pod = matches[0];
    assert.equal(pod.metadata.namespace, namespace);
    assert.equal(pod.metadata.labels?.[diagnosticLabel], namespace);
    assert.ok(pod.metadata.uid && !pod.metadata.deletionTimestamp);
    assert.equal(pod.status?.phase, 'Running');
    assert.equal(diagnosticPodReady(pod), true);
    assert.ok(isIP(pod.status.podIP));
    return pod;
  });
  assert.notEqual(pods[0].metadata.uid, pods[1].metadata.uid);
  assert.notEqual(pods[0].status.podIP, pods[1].status.podIP);
  assert.ok(pods.every((p) => p.spec?.nodeName));
  assert.notEqual(pods[0].spec.nodeName, pods[1].spec.nodeName, 'Backends must occupy different nodes');
  const host = (ip) => (isIP(ip) === 6 ? `[${ip}]` : ip);
  const config = bundle.items.find((r) => r.kind === 'ConfigMap' && r.metadata.name === 'proxy-config');
  assert.ok(config?.immutable, 'Use a newly prepared create-only proxy configuration');
  assert.equal((config.data['nginx.conf'].match(/server a:8080;/g) ?? []).length, 1);
  config.data['nginx.conf'] = config.data['nginx.conf'].replace(
    'server a:8080;',
    `server ${host(pods[0].status.podIP)}:8080;`,
  );
  const client = bundle.items.find((r) => r.kind === 'Job').spec.template.spec.containers[0];
  client.env.push(
    { name: 'BACKEND_A', value: `http://${host(pods[0].status.podIP)}:8080` },
    { name: 'BACKEND_B', value: `http://${host(pods[1].status.podIP)}:8080` },
  );
  return { bundle, owners: pods.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, ip: p.status.podIP })) };
}

export function rivetResetPhases(bundle) {
  const proxy = bundle.items.filter((r) => r.kind === 'ConfigMap' && r.metadata.name === 'proxy-config');
  proxy.push(...bundle.items.filter((r) => r.kind === 'Service' && r.metadata.name === 'proxy'));
  proxy.push(...bundle.items.filter((r) => r.kind === 'Pod' && r.metadata.name === 'proxy'));
  assert.equal(proxy.length, 3);
  return {
    infrastructure: bundle.items.filter((r) => r.kind !== 'Job' && !proxy.includes(r)),
    proxy,
    client: bundle.items.find((r) => r.kind === 'Job'),
  };
}

/** Shared by local execution and later staging setup. Only fresh creates are
 * needed. A rejected/uncertain create stops here with its original error. */
export async function createRivetResetProxy({ bundle, inventory, create }) {
  const completed = completeRivetResetResources(bundle, inventory);
  for (const resource of rivetResetPhases(completed.bundle).proxy) await create(resource);
  return completed;
}
