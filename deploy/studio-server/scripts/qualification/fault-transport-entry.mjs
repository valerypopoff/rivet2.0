import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createFaultTransport } from './fault-transport.mjs';

const modulePath = '/app/packages/studio-server-api/autoscaler/execution-autoscaler-kubernetes.mjs';
const { createKubernetesTransport } = await import(pathToFileURL(modulePath));
const config = JSON.parse(fs.readFileSync('/fixture/config.json', 'utf8'));
const { operation, namespace } = config;
assert.match(operation, /^rivet-q-[0-9]+-[0-9]+$/);
assert.match(config.projectNumber, /^[1-9][0-9]+$/);
assert.equal(namespace, 'rivet-staging-' + operation);
assert.equal(config.name, 'rivet-runtime-fault');
assert.match(config.controlUid, /^[a-f0-9-]{36}$/);
assert.ok(Number.isFinite(Date.parse(config.expiresAt)));
const ca = fs.readFileSync('/cluster-ca/ca.crt');
const upstream = 'https://kubernetes.default.svc';
const api = createKubernetesTransport({ origin: upstream, ca: () => ca });
const controlPath = `/api/v1/namespaces/${namespace}/configmaps/${config.name}`;
const readControl = async () => {
  assert.ok(Date.now() < Date.parse(config.expiresAt), 'Fault fixture admission expired');
  const object = await api.json('GET', controlPath);
  assert.equal(object.metadata?.uid, config.controlUid);
  assert.equal(object.metadata.labels?.['rivet.dev/ha-rehearsal'], operation);
  const state = JSON.parse(object.data.state);
  assert.equal(state.operation, operation);
  assert.equal(state.projectNumber, config.projectNumber);
  return { ...state, rv: object.metadata.resourceVersion };
};
const replaceControl = async (before, after) => {
  const { rv, ...state } = after;
  assert.equal(rv, before.rv);
  const object = await api.json('PUT', controlPath, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: config.name,
      namespace,
      uid: config.controlUid,
      resourceVersion: before.rv,
      labels: { 'rivet.dev/ha-rehearsal': operation },
    },
    data: { state: JSON.stringify(state) },
  });
  assert.equal(object.metadata.uid, config.controlUid);
  return { ...state, rv: object.metadata.resourceVersion };
};
const fixture = createFaultTransport({
  tls: { key: fs.readFileSync('/fixture-tls/tls.key'), cert: fs.readFileSync('/fixture-tls/tls.crt') },
  upstream,
  upstreamCa: ca,
  readControl,
  replaceControl,
  namespace,
  release: config.release,
  journalName: config.journalName,
  maxReplicas: config.maxReplicas,
});
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    fixture.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
fixture.server.listen(8443, '0.0.0.0', () =>
  console.log(JSON.stringify({ component: 'isolated-fault-transport', operation, listening: true })),
);
