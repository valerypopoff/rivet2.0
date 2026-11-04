import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createKubernetesTransport } from '../lib/execution-autoscaler-kubernetes.mjs';
import { ReusableStagingState, reusableStagingSettings, stagingOwner } from '../lib/reusable-staging-state.mjs';
import { qualificationHash } from '../lib/runtime-qualification-execution.mjs';
import { autoscalerPolicy } from '../lib/execution-autoscaler.mjs';
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');

export const digest = 'a'.repeat(64);
export const settings = () =>
  reusableStagingSettings({
    protocol: 1,
    mode: 'reusable-cluster',
    projectId: 'isolated-staging',
    region: 'europe-central2',
    projectNumber: '601520844163',
    clusterUid: 'staging-cluster',
    gatewayUid: 'shared-gateway',
    context: 'gke_isolated-staging_eu_cluster',
    clusterServer: 'https://staging.invalid',
    controlNamespace: 'rivet-qualification-control',
    runnerNamespace: 'rivet-qualification-runners',
    gatewayNamespace: 'rivet-edge',
    gatewayName: 'shared-edge',
    storageClassName: 'standard-rwo',
    domain: 'qualification.example.test',
    trustedClients: ['10.128.0.0/20'],
    trustedForwardingProxies: ['172.30.32.0/23', '192.0.2.200/32'],
    postgresImage: `registry.test/postgres@sha256:${digest}`,
    objectStorageImage: `registry.test/minio@sha256:${digest}`,
  });
export const actor = { name: 'runner-pod', uid: 'runner-uid', namespace: settings().runnerNamespace };
export const owner = { name: 'janitor-pod', uid: 'janitor-uid', namespace: settings().controlNamespace };
export const operation = (expires = Date.now() + 3600000) => {
  const input = {
    protocol: 1,
    operationId: 'rivet-q-123-1',
    projectId: settings().projectId,
    projectNumber: settings().projectNumber,
    staging: {
      clusterUid: settings().clusterUid,
      gatewayUid: settings().gatewayUid,
      clusterServer: settings().clusterServer,
    },
    driverBundleSha256: digest,
    policy: autoscalerPolicy({}),
    maxUsd: 50,
    expiresAt: new Date(expires).toISOString(),
  };
  return { ...input, inputHash: qualificationHash(input) };
};
export async function fixture(
  t,
  op = operation(),
  { intercept, deleted, decodeBody = (bytes) => JSON.parse(bytes) } = {},
) {
  const objects = new Map(),
    requests = [];
  let rv = 0,
    loseCreate = false,
    pendingDelete = false;
  let loseRetirementAck = false;
  let readFailure;
  const readCounts = new Map();
  const store = (url, object) => {
    const value = structuredClone(object);
    value.metadata.uid ??= randomUUID();
    value.metadata.resourceVersion = String(++rv);
    value.metadata.creationTimestamp ??= new Date(Date.now() - 1000).toISOString();
    objects.set(url, value);
    return value;
  };
  store('/api/v1/namespaces/kube-system', { metadata: { name: 'kube-system', uid: settings().clusterUid } });
  store('/api/v1/nodes/staging-node', {
    metadata: { name: 'staging-node', uid: 'node-uid' },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  });
  store(
    `/apis/gateway.networking.k8s.io/v1/namespaces/${settings().gatewayNamespace}/gateways/${settings().gatewayName}`,
    { metadata: { uid: settings().gatewayUid } },
  );
  const pod = (item) =>
    store(`/api/v1/namespaces/${item.namespace}/pods/${item.name}`, {
      metadata: { ...item, labels: { 'rivet.dev/qualification-runner': 'true' } },
      spec: { nodeName: 'staging-node' },
    });
  pod(actor);
  pod(owner).status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] };
  const health = `/api/v1/namespaces/${settings().controlNamespace}/configmaps/rivet-qualification-janitor-health`;
  store(health, {
    metadata: { name: 'rivet-qualification-janitor-health', namespace: settings().controlNamespace },
    data: {
      health: JSON.stringify({
        clusterUid: settings().clusterUid,
        driverDigest: digest,
        podUid: owner.uid,
        podName: owner.name,
        observedAt: Date.now(),
      }),
    },
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid'),
      pathname = url.pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const input = body.length ? decodeBody(body) : undefined;
    requests.push({ method: req.method, pathname, input });
    res.setHeader('content-type', 'application/json');
    const result = (value) => res.end(JSON.stringify(value));
    if (await intercept?.({ req, res, url, input, result, objects, store })) return;
    if (req.method === 'GET') {
      readCounts.set(pathname, (readCounts.get(pathname) ?? 0) + 1);
      if (readFailure?.path === pathname && readCounts.get(pathname) > readFailure.after) {
        res.statusCode = 503;
        return result({ kind: 'Status', reason: 'ServiceUnavailable' });
      }
      const value = objects.get(pathname);
      if (value) return result(value);
      if (
        pathname.endsWith('/' + 'rivet-q-123-1') ||
        pathname === '/api/v1/namespaces/rivet-staging-rivet-q-123-1' ||
        /\/(pods|configmaps|deployments|statefulsets|httproutes|services|persistentvolumes|healthcheckpolicies)\/[^/]+$/.test(
          pathname,
        )
      ) {
        res.statusCode = 404;
        return result({ kind: 'Status' });
      }
      return result({
        items: [...objects.entries()]
          .filter(
            ([key, value]) =>
              key.startsWith(pathname + '/') &&
              !key.slice(pathname.length + 1).includes('/') &&
              (!url.searchParams.has('labelSelector') || value.metadata.labels?.[stagingOwner]),
          )
          .map(([, value]) => value),
      });
    }
    if (req.method === 'POST') {
      const target = `${pathname}/${input.metadata.name}`;
      if (objects.has(target)) {
        res.statusCode = 409;
        return result({});
      }
      const created = store(target, input);
      if (loseCreate && input.kind === 'Namespace') {
        loseCreate = false;
        req.socket.destroy();
        return;
      }
      return result(created);
    }
    const current = objects.get(pathname);
    if (req.method === 'PATCH') {
      assert.deepEqual(input.slice(0, 2), [
        { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
      ]);
      assert.equal(input[2].path, '/spec/replicas');
      current.spec.replicas = input[2].value;
      return result(store(pathname, current));
    }
    if (req.method === 'PUT') {
      if (current?.metadata.resourceVersion !== input.metadata.resourceVersion) {
        res.statusCode = 409;
        return result({});
      }
      return result(store(pathname, input));
    }
    if (req.method === 'DELETE') {
      assert.equal(input.preconditions.uid, current.metadata.uid);
      assert.equal(input.preconditions.resourceVersion, current.metadata.resourceVersion);
      if (pendingDelete) {
        req.socket.destroy();
        return;
      }
      objects.delete(pathname);
      await deleted?.({ pathname, current, objects });
      return result({ kind: 'Status' });
    }
    res.statusCode = 501;
    result({});
  });
  const execCalls = [],
    ws = new WebSocketServer({ noServer: true });
  let retirement;
  server.on('upgrade', (req, socket, head) =>
    ws.handleUpgrade(req, socket, head, (client) => {
      const url = new URL(req.url, 'http://fixture.invalid'),
        commands = url.searchParams.getAll('command');
      execCalls.push({ container: url.searchParams.get('container'), commands });
      if (commands[1] === '/opt/rivet/retire-backend.mjs' && commands.length > 2) retirement = commands[2];
      if (commands[1] === '/opt/rivet/retire-backend.mjs' && commands.length > 2 && loseRetirementAck) {
        loseRetirementAck = false;
        client.terminate();
        return;
      }
      const value = {
        state: retirement ? 'drained' : 'serving',
        incarnation: 'exact-incarnation',
        ...(retirement ? { operationId: retirement } : {}),
      };
      client.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]));
      client.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
      if (client.protocol === 'v5.channel.k8s.io')
        for (const channel of [1, 2, 3]) client.send(Buffer.from([255, channel]));
      client.close(1000);
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    server.closeAllConnections();
    server.close();
  });
  const api = createKubernetesTransport({
    origin: `http://127.0.0.1:${server.address().port}`,
    allowLoopbackHttp: true,
    token: () => 'local-test-only',
    WebSocketClass: WebSocket,
  });
  return {
    state: new ReusableStagingState(api, settings(), op),
    origin: `http://127.0.0.1:${server.address().port}`,
    api,
    objects,
    requests,
    execCalls,
    failReads(value) {
      readFailure = value;
    },
    loseRetirementAck() {
      loseRetirementAck = true;
    },
    loseCreate() {
      loseCreate = true;
    },
    pendingDelete() {
      pendingDelete = true;
    },
    health,
    store,
  };
}
export const cloud = {
  project: async () => ({ projectId: settings().projectId, projectNumber: settings().projectNumber }),
  children: async () => [],
  get: async () => null,
};
export const wait = async (name, check) => {
  const result = await check();
  assert.ok(result, name);
  return result;
};
