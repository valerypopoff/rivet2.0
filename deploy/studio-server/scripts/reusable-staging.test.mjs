import assert from 'node:assert/strict';
// test-style: fixture-read: Inspect only freshly generated private driver packages and rendered manifests, not implementation source.
import test from 'node:test';
import { persistenceFixture } from './test-fixtures/persistence.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { reusableStagingSettings, stagingHostname } from './lib/reusable-staging-state.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';
import {
  settleStaging,
  cleanupStaging,
  verifyStagingCleanup,
  observeStagingInventory,
} from './lib/reusable-staging-cleanup.mjs';
import { stagingCloudReader, PendingGatewayBackendError } from './lib/reusable-staging-cloud.mjs';
import { proxyFixtureProcessCommand } from './lib/staging-proxy-fixture-process.mjs';
import { inspectStagingPrerequisites } from './lib/reusable-staging-prerequisites.mjs';
import { stagingJanitorPass } from './reusable-staging-janitor.mjs';
import { qualificationSizing } from './lib/runtime-qualification-installation.mjs';
import { packageReusableStaging } from './package-reusable-staging.mjs';
import { verifyQualificationDriver } from './lib/runtime-qualification-driver.mjs';
import { executeProviderPhase } from './qualification/provider-entry.mjs';
import { providerProgressStep } from './lib/provider-progress.mjs';
import { ManagedReleaseGate, createReleaseGateWebAppOAuthSession } from './kubernetes-managed-release-gate.mjs';
import { ReusableProviderGate, until } from './qualification/provider-gate.mjs';
import { withManagedGateSignal } from './lib/managed-gate-command.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { qualificationExecutionBaseline } from './lib/ha-release-evidence.mjs';

test('focused paired qualification starts three workers when the approved ceiling covers both pools', () => {
  const paired = { qualification: { tier: 'focused' }, executionPools: true, policy: { maxReplicas: 7 } };
  assert.equal(qualificationExecutionBaseline(paired), 3);
  assert.equal(qualificationExecutionBaseline({ ...paired, policy: { maxReplicas: 6 } }), 3);
  for (const operation of [
    undefined,
    { ...paired, executionPools: false },
    { ...paired, qualification: undefined },
    { ...paired, policy: { maxReplicas: 4 } },
  ])
    assert.equal(qualificationExecutionBaseline(operation), 2);
});

for (const scenario of [
  'idle-two',
  'already-three',
  'grown-four',
  'conflict',
  'lost-ack',
  'foreign-image',
  'not-ready',
  'changed-uid',
])
  test(`retained execution baseline grows once before observation and preserves ownership: ${scenario}`, async () => {
    const image = { repository: 'registry.test/api', digest: 'sha256:' + 'a'.repeat(64) };
    const count = scenario === 'grown-four' ? 4 : scenario === 'already-three' ? 3 : 2;
    const controller = {
      metadata: {
        name: 'test-ha-execution',
        uid: 'active-controller',
        resourceVersion: '10',
        labels: { 'app.kubernetes.io/component': 'execution', 'app.kubernetes.io/instance': 'test' },
      },
      spec: {
        replicas: count,
        updateStrategy: { type: 'OnDelete' },
        template: {
          spec: {
            containers: [
              { name: 'api', image: scenario === 'foreign-image' ? 'foreign' : `${image.repository}@${image.digest}` },
            ],
          },
        },
      },
    };
    const writes = [],
      artifacts = [];
    const gate = Object.assign(Object.create(ReusableProviderGate.prototype), {
      operation: { qualification: { tier: 'focused' }, executionPools: true, policy: { maxReplicas: 7 } },
      currentManifest: { images: { api: image } },
      config: { release: 'test', deploymentTimeoutSeconds: 1 },
      assertProofContext: async () => {},
      artifact: async (name) => artifacts.push(name),
      pods: async () =>
        Array.from({ length: controller.spec.replicas }, (_, index) => ({
          metadata: {
            uid: 'pod-' + index,
            ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: controller.metadata.uid }],
          },
          status: {
            conditions: [{ type: 'Ready', status: scenario === 'not-ready' && index === 2 ? 'False' : 'True' }],
          },
        })),
      kube: async (args) => {
        if (args[0] === 'get') {
          if (scenario === 'changed-uid' && args[1] === 'statefulset') controller.metadata.uid = 'new-controller';
          return { stdout: JSON.stringify(args[1] === 'statefulsets' ? { items: [controller] } : controller) };
        }
        assert.deepEqual(args.slice(0, 4), ['patch', 'statefulset', controller.metadata.name, '--type=json']);
        const patch = JSON.parse(args.at(-1));
        writes.push(patch);
        assert.deepEqual(patch.slice(0, 3), [
          { op: 'test', path: '/metadata/uid', value: 'active-controller' },
          { op: 'test', path: '/metadata/resourceVersion', value: '10' },
          { op: 'test', path: '/spec/replicas', value: 2 },
        ]);
        assert.deepEqual(patch[3], { op: 'replace', path: '/spec/replicas', value: 3 });
        if (scenario === 'conflict') throw Error('Conflict');
        controller.spec.replicas = 3;
        if (scenario === 'lost-ack') throw Error('Unknown acknowledgement');
        return { stdout: JSON.stringify(controller) };
      },
    });
    if (['conflict', 'lost-ack', 'foreign-image', 'not-ready', 'changed-uid'].includes(scenario)) {
      await assert.rejects(gate.prepareExecutionBaseline());
      assert.ok(!artifacts.includes('execution-baseline-ready.json'));
    } else {
      await gate.prepareExecutionBaseline();
      assert.equal(controller.spec.replicas, Math.max(3, count));
      assert.ok(artifacts.includes('execution-baseline-ready.json'));
    }
    assert.equal(
      writes.length,
      ['idle-two', 'conflict', 'lost-ack', 'not-ready', 'changed-uid'].includes(scenario) ? 1 : 0,
    );
  });

test('provider polling stops on cancellation instead of treating it as another pending observation', async () => {
  const cancellation = new AbortController(),
    reason = new Error('fixture observation cancelled');
  let calls = 0;
  await assert.rejects(
    withManagedGateSignal(cancellation.signal, () =>
      until('fixture readiness', async () => {
        calls++;
        cancellation.abort(reason);
        return false;
      }),
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
});

test('focused admission checks shared prerequisites without requiring an unused browser runtime', async () => {
  const events = [];
  const operation = { qualification: { tier: 'focused' } };
  await executeProviderPhase({
    phase: 'armExpiry',
    operation,
    cloud: { project: async () => events.push('project') },
    gate: {
      verifyLocalBrowserFixture: async () => {
        throw Error('Focused rollout must not launch browser tests');
      },
      verifySharedPrerequisites: async () => events.push('shared'),
    },
    state: {
      arm: async () => {
        events.push('expiry');
        return {};
      },
    },
  });
  assert.deepEqual(events, ['project', 'shared', 'expiry']);
  await assert.rejects(
    executeProviderPhase({
      phase: 'autoscaling',
      operation,
      state: {
        admission: async () => {
          throw Error('Must reject before admission or writes');
        },
      },
    }),
    /actual upgrade/,
  );
});

test('actual workload admission precedes dependency or route creation and checks both sides of an update', async () => {
  for (const sizing of [false, true]) {
    const calls = [],
      previous = { images: { api: 'old' } },
      candidate = { images: { api: 'new' } };
    const op = { previous, candidate, ...(sizing ? { sizingRequests: {} } : {}) };
    const state = {
      admission: async () => {},
      change: async () => {},
      namespace: async () => calls.push('namespace'),
    };
    const gate = {
      verifySharedPrerequisites: async () => {},
      values: (images) => images,
      verifyAdmission: async (values) => {
        calls.push(values.api);
        if (values.api === 'new') throw Error('GKE rejected candidate resources');
      },
      installDependencies: async () => calls.push('dependencies'),
      createPublicRoute: async () => calls.push('route'),
    };
    await assert.rejects(executeProviderPhase({ phase: 'prepare', operation: op, state, gate }), /GKE rejected/);
    assert.deepEqual(calls, sizing ? ['namespace', 'new'] : ['namespace', 'old', 'new']);
  }
});

test('retained preparation preserves the installed staging manifest instead of its later publication digest', async () => {
  const tested = { images: { api: 'same' }, state: 'candidate' };
  const published = { ...tested, state: 'promoted' };
  const candidate = { images: { api: 'new' } },
    calls = [];
  const record = { retainedApplication: { bootstrap: false, predecessorManifest: tested } };
  const gate = {
    config: {},
    verifySharedPrerequisites: async () => {},
    values: (images, _singleton, manifest = candidate) => ({ images, manifest }),
    verifyAdmission: async ({ manifest }) => calls.push(manifest),
    retainedSecrets: async () => {},
    verifyRetainedInstallation: async () => {
      assert.equal(gate.currentManifest, tested);
      assert.equal(gate.config.previousManifest, tested);
      throw Error('retained predecessor verified');
    },
  };
  const state = {
    application: {},
    admission: async () => {},
    read: async () => ({ record }),
    change: async () => {},
    namespace: async () => {},
  };
  await assert.rejects(
    executeProviderPhase({ phase: 'prepare', operation: { previous: published, candidate }, state, gate }),
    /retained predecessor verified/,
  );
  assert.deepEqual(calls, [tested, candidate]);
});

test('workload admission uses server dry runs and records provider adjustments without enforcing exact resources', async () => {
  const resources = { requests: { cpu: '50m', memory: '128Mi' } };
  const desired = ['Deployment', 'StatefulSet', 'Job'].map((kind, i) => ({
    apiVersion: kind === 'Job' ? 'batch/v1' : 'apps/v1',
    kind,
    metadata: { name: `work-${i}` },
    spec: { template: { spec: { containers: [{ name: 'app', resources }] } } },
  }));
  const sent = [];
  const gate = {
    config: { namespace: 'fixture' },
    resources: async () => [...desired, { kind: 'PersistentVolumeClaim', metadata: { name: 'unused' } }],
    kube: async (args, options) => {
      assert.ok(args.includes('--dry-run=server'));
      const packet = JSON.parse(options.input);
      sent.push(packet);
      const admitted = structuredClone(packet);
      admitted.spec.template.spec.containers[0].resources.requests.cpu = '500m';
      return { stdout: JSON.stringify(admitted) };
    },
    artifact: async (_name, contents) => {
      assert.equal(JSON.parse(contents).admitted[0].containers[0].resources.requests.cpu, '500m');
    },
  };
  await ReusableProviderGate.prototype.verifyAdmission.call(gate, {});
  assert.deepEqual(sent, desired);
  assert.deepEqual(resources.requests, { cpu: '50m', memory: '128Mi' });
  const validKube = gate.kube;
  for (const fault of ['missing', 'duplicate', 'name', 'kind', 'namespace']) {
    gate.kube = async (...args) => {
      const response = await validKube(...args),
        result = JSON.parse(response.stdout);
      if (fault === 'missing') return { stdout: 'null' };
      if (fault === 'duplicate') return { stdout: JSON.stringify(desired[0]) };
      if (fault === 'name') result.metadata.name = 'foreign';
      if (fault === 'kind') result.kind = 'Unexpected';
      if (fault === 'namespace') result.metadata.namespace = 'foreign';
      return { stdout: JSON.stringify(result) };
    };
    await assert.rejects(ReusableProviderGate.prototype.verifyAdmission.call(gate, {}), /admission.*workload/i);
  }
  gate.kube = async () => {
    throw Error('Autopilot minimum rejected');
  };
  await assert.rejects(ReusableProviderGate.prototype.verifyAdmission.call(gate, {}), /Autopilot minimum/);
});
test('a retained staging endpoint is fixed across releases and cannot escape its non-production domain', () => {
  const fixed = reusableStagingSettings({ ...settings(), hostname: 'rivet-staging.qualification.example.test' });
  for (const operationId of ['rivet-q-123-1', 'rivet-q-124-1'])
    assert.equal(stagingHostname(fixed, { operationId }), fixed.hostname);
  assert.equal(
    stagingHostname(settings(), { operationId: 'rivet-q-123-1' }),
    'rivet-q-123-1.qualification.example.test',
  );
  for (const hostname of [
    'foreign.example.test',
    'https://rivet-staging.qualification.example.test',
    'bad\n.qualification.example.test',
  ])
    assert.throws(() => reusableStagingSettings({ ...settings(), hostname }));
});

test('retained staging validates database capacity and refreshes only its bound registry credential', async () => {
  const gate = Object.create(ReusableProviderGate.prototype),
    objects = new Map(),
    writes = [];
  gate.config = { namespace: 'retained-staging' };
  gate.settings = { runnerNamespace: 'runners', registrySecret: { name: 'approved-registry', uid: 'source-uid' } };
  const identities = {};
  const add = (name, data, namespace = gate.config.namespace, type = 'Opaque', uid = name + '-uid') => {
    const secret = {
      metadata: { name, namespace, uid, resourceVersion: '1' },
      type,
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
      ),
    };
    objects.set(`/api/v1/namespaces/${namespace}/secrets/${name}`, secret);
    if (namespace === gate.config.namespace) identities[name] = uid;
    return secret;
  };
  add('rivet-release-gate-postgres', { password: 'fixture-password' });
  add('rivet-release-gate-object-storage', { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' });
  add('rivet-release-gate-settings', { encryptionKey: 'fixture-encryption' });
  add('rivet-release-gate-auth', { RIVET_KEY: 'fixture-key' });
  const type = 'kubernetes.io/dockerconfigjson';
  const source = add('approved-registry', { '.dockerconfigjson': 'fresh-credential' }, 'runners', type, 'source-uid');
  const target = add(
    'rivet-release-gate-registry',
    { '.dockerconfigjson': 'old-credential' },
    gate.config.namespace,
    type,
  );
  const owner = { record: { secrets: identities } };
  gate.assertProofContext = async () => {};
  gate.state = {
    application: { owned: async () => owner },
    api: {
      json: async (method, url, body) => {
        if (method === 'GET') return structuredClone(objects.get(url));
        assert.equal(method, 'PUT');
        assert.ok(url.endsWith('/rivet-release-gate-registry'));
        assert.equal(body.metadata.uid, target.metadata.uid);
        assert.equal(body.metadata.resourceVersion, target.metadata.resourceVersion);
        writes.push(url);
        objects.set(url, body);
        return body;
      },
    },
  };
  const result = await gate.retainedSecrets();
  assert.deepEqual(result.identities, identities);
  assert.equal(result.identities['rivet-release-gate-registry'], target.metadata.uid);
  assert.equal(gate.secrets.postgresPassword, 'fixture-password');
  assert.deepEqual(objects.get(writes[0]).data, source.data);
  await gate.retainedSecrets();
  assert.equal(writes.length, 1, 'An unchanged credential must not trigger another write');
  source.metadata.uid = 'replacement-source';
  await assert.rejects(gate.retainedSecrets());
  source.metadata.uid = 'source-uid';
  objects.get(writes[0]).metadata.uid = 'foreign-target';
  await assert.rejects(gate.retainedSecrets());
  assert.equal(writes.length, 1);
  objects.get(writes[0]).metadata.uid = target.metadata.uid;
  gate.operation = {
    installed: {
      executionPoolCapacity: { maxSurgeReplicas: 7, maxConnections: 305 },
      qualificationValues: {
        ha: { executionPools: { enabled: true, maxSurgeReplicas: 7 } },
        postgres: { maxConnections: 305 },
      },
    },
  };
  const database = {
    metadata: { generation: 2 },
    spec: { replicas: 1, template: { spec: { containers: [{ args: ['postgres', '-c', 'max_connections=200'] }] } } },
    status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, readyReplicas: 1 },
  };
  objects.set(`/apis/apps/v1/namespaces/${gate.config.namespace}/deployments/release-gate-postgres`, database);
  await assert.rejects(gate.retainedSecrets(), /Prepare the retained staging PostgreSQL/);
  database.spec.template.spec.containers[0].args[2] = 'max_connections=305';
  database.status.updatedReplicas = 0;
  await assert.rejects(gate.retainedSecrets(), /preparation to settle/);
  database.status.updatedReplicas = 1;
  database.spec.replicas = 2;
  await assert.rejects(gate.retainedSecrets(), /preparation to settle/);
  database.spec.replicas = 1;
  database.metadata.deletionTimestamp = new Date().toISOString();
  await assert.rejects(gate.retainedSecrets(), /preparation to settle/);
  delete database.metadata.deletionTimestamp;
  await gate.retainedSecrets();
  delete gate.operation.installed.executionPoolCapacity;
  database.spec.template.spec.containers[0].args[2] = 'max_connections=200';
  await assert.rejects(gate.retainedSecrets(), /Prepare the retained staging PostgreSQL/);
  database.spec.template.spec.containers[0].args[2] = 'max_connections=305';
  await gate.retainedSecrets();
  gate.operation.installed.qualificationValues.ha.executionPools.maxSurgeReplicas = 0;
  database.spec.template.spec.containers[0].args[2] = 'max_connections=200';
  await gate.retainedSecrets();
  assert.equal(writes.length, 1, 'Capacity preparation only observes; it never resizes the retained database');
});

import { digest, settings, actor, owner, operation, fixture, cloud, wait } from './test-fixtures/reusable-staging.mjs';

test('shared staging prerequisites reject setup failures before namespace or dependency writes', async (t) => {
  const f = await fixture(t);
  const gatewayPath = `/apis/gateway.networking.k8s.io/v1/namespaces/${settings().gatewayNamespace}/gateways/${settings().gatewayName}`;
  const storagePath = `/apis/storage.k8s.io/v1/storageclasses/${settings().storageClassName}`;
  const metricsPath = '/apis/metrics.k8s.io/v1beta1/nodes';
  const positive = (type) => ({ type, status: 'True', observedGeneration: 3 });
  const gateway = {
    metadata: { uid: settings().gatewayUid, generation: 3 },
    spec: {
      listeners: [
        {
          name: 'https',
          port: 443,
          protocol: 'HTTPS',
          hostname: `*.${settings().domain}`,
          allowedRoutes: {
            namespaces: { from: 'Selector', selector: { matchLabels: { 'rivet.dev/qualification-route': 'true' } } },
          },
        },
      ],
    },
    status: {
      addresses: [{ type: 'IPAddress', value: '192.0.2.200' }],
      conditions: [positive('Programmed')],
      listeners: [{ name: 'https', conditions: [positive('Accepted'), positive('ResolvedRefs')] }],
    },
  };
  const storage = { metadata: { uid: 'storage-uid' }, provisioner: 'pd.csi.storage.gke.io', reclaimPolicy: 'Delete' };
  const metrics = {
    metadata: {},
    items: [{ timestamp: new Date().toISOString(), usage: { cpu: '10m', memory: '100Ki' } }],
  };
  const reset = () => {
    f.store(gatewayPath, gateway);
    f.store(storagePath, storage);
    f.store(metricsPath, metrics);
  };
  let tlsCalls = 0;
  let browserChecks = 0;
  const verifyTls = async (origin) => {
    assert.equal(origin, `https://${f.state.operation.operationId}.${settings().domain}`);
    tlsCalls++;
  };
  const gate = {
    verifyLocalBrowserFixture: async () => {
      browserChecks++;
    },
    verifySharedPrerequisites: () => inspectStagingPrerequisites(f.state, { verifyTls }),
  };
  const arm = () =>
    executeProviderPhase({ phase: 'armExpiry', operation: f.state.operation, state: f.state, cloud, actor, gate });
  await assert.rejects(
    executeProviderPhase({
      phase: 'armExpiry',
      operation: f.state.operation,
      state: f.state,
      cloud,
      actor,
      gate: {
        ...gate,
        verifyLocalBrowserFixture: async () => {
          throw Error('browser executable missing');
        },
      },
    }),
    /browser executable missing/,
  );
  assert.equal(f.requests.length, 0, 'A broken local browser must fail before any cluster request');
  const cases = [
    [
      () => {
        f.objects.get(gatewayPath).status.addresses[0].value = '192.0.2.201';
      },
      /frontend IP/,
    ],
    [
      () => {
        f.objects.get(gatewayPath).status.conditions[0].observedGeneration = 2;
      },
      /Programmed/,
    ],
    [
      () => {
        f.objects.get(gatewayPath).spec.listeners[0].hostname = '*.wrong.test';
      },
      /hostname/,
    ],
    [
      () => {
        f.objects.get(gatewayPath).status.listeners[0].conditions[1].status = 'False';
      },
      /certificate/,
    ],
    [
      () => {
        f.objects.get(gatewayPath).spec.listeners[0].allowedRoutes.namespaces.from = 'All';
      },
      /namespace-scoped/,
    ],
    [
      () => {
        f.objects.get(storagePath).reclaimPolicy = 'Retain';
      },
      /controller cleanup/,
    ],
    [
      () => {
        f.objects.get(metricsPath).items[0].timestamp = '2020-01-01T00:00:00.000Z';
      },
      /metrics/,
    ],
    [
      () => {
        f.objects.get(metricsPath).metadata.continue = 'next';
      },
      /metrics/,
    ],
  ];
  for (const [change, error] of cases) {
    reset();
    change();
    await assert.rejects(arm(), error);
  }
  reset();
  await assert.rejects(
    inspectStagingPrerequisites(f.state, {
      verifyTls: async () => {
        throw Error('certificate expired');
      },
    }),
    /certificate expired/,
  );
  await assert.rejects(
    inspectStagingPrerequisites(f.state, {
      verifyTls: async () => {
        f.objects.get(gatewayPath).metadata.generation++;
      },
    }),
    /listener changed during preflight/,
  );
  reset();
  assert.equal(tlsCalls, 0);
  assert.ok(
    f.requests.every((r) => r.method === 'GET'),
    'Failed setup must not create even an operation registry',
  );
  await arm();
  assert.equal(tlsCalls, 1);
  assert.equal(browserChecks, cases.length + 1, 'Each fresh arm checks the local browser before setup admission');
  assert.equal((await f.state.read()).record.namespaceUid, null);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1, 'Only the non-billable registry is armed');
  f.objects.get(storagePath).reclaimPolicy = 'Retain';
  await assert.rejects(
    executeProviderPhase({ phase: 'prepare', operation: f.state.operation, state: f.state, cloud, actor, gate }),
    /controller cleanup/,
  );
  assert.equal(
    (await f.state.read()).record.namespaceUid,
    null,
    'Preparation must recheck infrastructure before creating resources',
  );
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});

test('Gateway discovery rejects partial inventories and backend replacement between list and read', async (t) => {
  const prefix = `projects/${settings().projectId}`,
    neg = `${prefix}/zones/zone-a/networkEndpointGroups/test-neg`,
    backend = `${prefix}/regions/region-a/backendServices/test-backend`,
    health = `${prefix}/regions/region-a/healthChecks/test-health`,
    link = (resource) => `https://www.googleapis.com/compute/v1/${resource}`;
  const listed = {
    id: '102',
    selfLink: link(backend),
    backends: [{ group: link(neg) }],
    healthChecks: [link(health)],
  };
  let scenario = 'valid';
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'application/json');
    const data = { items: { regional: { backendServices: [listed] } } };
    if (req.url.endsWith('/aggregated/backendServices')) {
      if (scenario === 'unreachable') data.unreachables = ['regions/region-b'];
      if (scenario === 'malformed-unreachables') data.unreachables = {};
      if (scenario === 'malformed-scope') data.items.other = [];
      if (scenario === 'global-warning') data.warning = { code: 'PARTIAL_SUCCESS' };
      if (scenario === 'scope-warning') data.items.other = { warning: { code: 'UNREACHABLE' } };
      if (scenario === 'empty') data.items = { regional: { warning: { code: 'NO_RESULTS_ON_PAGE' } } };
      if (scenario === 'empty') data.warning = { code: 'NO_RESULTS_ON_PAGE' };
      if (scenario === 'paged') data.nextPageToken = 'next';
      return res.end(JSON.stringify(data));
    }
    if (req.url.endsWith(backend)) {
      const current = structuredClone(listed);
      if (scenario === 'replacement') current.id = '999';
      if (scenario === 'rebound') current.backends = [{ group: link(neg + '-other') }];
      if (scenario === 'health-rebound') current.healthChecks = [link(health + '-other')];
      return res.end(JSON.stringify(current));
    }
    if (req.url.endsWith(health)) return res.end(JSON.stringify({ id: '103', selfLink: link(health) }));
    res.statusCode = 501;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const reader = stagingCloudReader(settings(), {
    token: async () => 'fixture-only',
    fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options),
  });
  const inventory = [{ id: 'neg-101', kind: 'neg', resource: neg }];
  assert.deepEqual(
    (await reader.children(inventory)).map((c) => c.value.id),
    ['102', '103'],
  );
  for (scenario of [
    'unreachable',
    'malformed-unreachables',
    'malformed-scope',
    'global-warning',
    'scope-warning',
    'paged',
    'replacement',
    'rebound',
    'health-rebound',
  ])
    await assert.rejects(reader.children(inventory, { requiredNegIds: [] }), /Incomplete|changed|replaced/);
  scenario = 'empty';
  await assert.rejects(reader.children(inventory), PendingGatewayBackendError);
  assert.deepEqual(await reader.children(inventory, { requiredNegIds: [] }), []);
  assert.ok(requests.every((r) => r.method === 'GET'));
});

test(
  'real Linux fixture stop preserves reused PIDs and rejects a wrong nonce',
  {
    skip: process.platform !== 'linux' && !process.env.RIVET_STAGING_PROCESS_TEST_IMAGE,
  },
  () => {
    const item = { marker: '/tmp/rivet-hpa-load-abcd.json', stop: '/tmp/rivet-hpa-stop-abcd', pid: 2, startTicks: '1' };
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = (stop, marker = '"$marker"', ticks = '"$ticks"') =>
      `sh -ec ${quote(proxyFixtureProcessCommand(item, { stop })[2])} owned-fixture ${marker} "$stop" "$pid" ${ticks}`;
    const script = `set -eu
marker=${quote(item.marker)}; stop=${quote(item.stop)}
sh -ec 'i=0; while [ ! -e "$2" ] && [ "$i" -lt 200 ]; do sleep 0.02; i=$((i+1)); done; test -e "$2"' fixture "$marker" "$stop" &
pid=$!
trap 'kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :' EXIT
ticks=$(awk '{print $22}' /proc/"$pid"/stat)
${command(true, '"$marker"', '"$((ticks+1))"')}
test ! -e "$stop"; kill -0 "$pid"
if ${command(true, quote('/tmp/rivet-hpa-load-eeee.json'))}; then exit 51; fi
test ! -e "$stop"; kill -0 "$pid"
test "$(${command(false)})" = "$ticks"
${command(true)}
${command(true)}
wait "$pid"
test -e "$stop"
test -z "$(${command(false)})"
rm "$stop"
${command(true)}
test ! -e "$stop"
printf 'exact process stopped; reused PID and wrong nonce untouched\\n'
`;
    const image = process.env.RIVET_STAGING_PROCESS_TEST_IMAGE;
    const result = spawnSync(
      image ? 'docker' : 'sh',
      image ? ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'sh', '-i', image, '-s'] : ['-s'],
      { input: script, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /exact process stopped; reused PID and wrong nonce untouched/);
  },
);

test('unhealthy janitor admission never creates an operation registry', async (t) => {
  for (const change of [
    'old-driver',
    'stale',
    'future',
    'missing',
    'unready',
    'dead',
    'deleting',
    'replaced',
    'malformed',
  ])
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const healthPath = `/api/v1/namespaces/${settings().controlNamespace}/configmaps/rivet-qualification-janitor-health`;
      const health = JSON.parse(f.objects.get(healthPath).data.health);
      if (change === 'old-driver') health.driverDigest = 'b'.repeat(64);
      if (change === 'stale') health.observedAt = Date.now() - 60000;
      if (change === 'future') health.observedAt = Date.now() + 60000;
      f.objects.get(healthPath).data.health = change === 'malformed' ? 'invalid-json' : JSON.stringify(health);
      if (change === 'missing') f.objects.delete(healthPath);
      const janitor = f.objects.get(`/api/v1/namespaces/${owner.namespace}/pods/${owner.name}`);
      if (change === 'unready') janitor.status.conditions[0].status = 'False';
      if (change === 'dead') janitor.status.phase = 'Failed';
      if (change === 'deleting') janitor.metadata.deletionTimestamp = new Date().toISOString();
      if (change === 'replaced') janitor.metadata.uid = 'replacement-janitor';
      await assert.rejects(f.state.arm(actor));
      assert.equal(
        f.requests.some((r) => r.method !== 'GET'),
        false,
        'Admission prerequisites must precede registry CREATE',
      );
    });
});

test('cleanup targets the current controller UID while retaining replaced identities in history', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  const apiPath = `/apis/apps/v1/namespaces/${ns.metadata.name}/deployments/rivet-qualification-autoscaler`;
  const controller = (uid) => ({
    metadata: { name: 'rivet-qualification-autoscaler', namespace: ns.metadata.name, uid },
    spec: { replicas: 1 },
  });
  const old = f.store(apiPath, controller('00000000-0000-0000-0000-000000000001'));
  await observeStagingInventory(f.state, cloud);
  const current = f.store(apiPath, controller('ffffffff-ffff-ffff-ffff-ffffffffffff'));
  await settleStaging(f.state, cloud, actor, wait);
  const { record } = await f.state.read();
  assert.equal(record.phase, 'settled');
  assert.ok(record.inventory.some((i) => i.uid === old.metadata.uid));
  assert.ok(record.inventory.some((i) => i.uid === current.metadata.uid));
  assert.equal(f.requests.find((r) => r.method === 'PATCH').input[0].value, current.metadata.uid);
});

test('GKE automatic ingress annotation does not block internal Service cleanup', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  const servicePath = `/api/v1/namespaces/${ns.metadata.name}/services/postgres`;
  const service = f.store(servicePath, {
    metadata: {
      name: 'postgres',
      namespace: ns.metadata.name,
      annotations: { 'cloud.google.com/neg': '{"ingress":true}' },
    },
    spec: { type: 'ClusterIP' },
  });
  await settleStaging(f.state, cloud, actor, wait);
  const { record } = await f.state.read();
  assert.equal(record.phase, 'settled');
  assert.ok(record.inventory.some((item) => item.uid === service.metadata.uid));
  assert.ok(!record.inventory.some((item) => item.kind === 'neg'));
});

test('unfinished explicit or routed NEGs still block cleanup', async (t) => {
  for (const scenario of ['explicit', 'ingress', 'status', 'unknown']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      await f.state.arm(actor);
      const ns = await f.state.namespace({ create: true });
      f.store(`/api/v1/namespaces/${ns.metadata.name}/services/proxy`, {
        metadata: {
          name: 'proxy',
          namespace: ns.metadata.name,
          annotations: {
            'cloud.google.com/neg':
              scenario === 'explicit'
                ? '{"exposed_ports":{"80":{}}}'
                : scenario === 'unknown'
                  ? '{"ingress":true,"unknown":true}'
                  : '{"ingress":true}',
            ...(scenario === 'status' ? { 'cloud.google.com/neg-status': '{}' } : {}),
          },
        },
        spec: { type: 'ClusterIP' },
      });
      if (scenario === 'ingress')
        f.store(`/apis/networking.k8s.io/v1/namespaces/${ns.metadata.name}/ingresses/route`, {
          metadata: { name: 'route', namespace: ns.metadata.name },
        });
      await assert.rejects(settleStaging(f.state, cloud, actor, wait), /NEG creation is uncertain/);
      assert.notEqual((await f.state.read()).record.phase, 'settled');
      assert.ok(!f.requests.some((r) => r.method === 'DELETE'));
    });
  }
});

test('settlement is not published if the final inventory read fails', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  f.failReads({ path: `/apis/networking.gke.io/v1/namespaces/${ns.metadata.name}/healthcheckpolicies`, after: 1 });
  await assert.rejects(settleStaging(f.state, cloud, actor, wait), /503/);
  assert.notEqual((await f.state.read()).record.phase, 'settled');
  await assert.rejects(cleanupStaging(f.state, actor));
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('empty inventories cannot conceal a live or unexpectedly disappeared namespace', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  await f.state.change((r) => {
    r.closed = true;
    r.phase = 'settled';
  });
  assert.equal(await verifyStagingCleanup(f.state, cloud), null);
  await f.state.claimCleanup(actor);
  await assert.rejects(cleanupStaging(f.state, actor), /Complete inventory/);
  f.objects.delete(`/api/v1/namespaces/${ns.metadata.name}`);
  await assert.rejects(settleStaging(f.state, cloud, actor, wait), /unexpected|inventory/i);
  await assert.rejects(verifyStagingCleanup(f.state, cloud), /unexpected|inventory/i);
});

test('cleanup waits for pending Jobs and their actual Pods, not only a zero active counter', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  const jobPath = `/apis/batch/v1/namespaces/${ns.metadata.name}/jobs/migration`;
  const job = f.store(jobPath, { metadata: { name: 'migration', namespace: ns.metadata.name }, status: { active: 0 } });
  await assert.rejects(settleStaging(f.state, cloud, actor, wait), /migration\/test jobs physically stopped/);
  job.status.conditions = [{ type: 'Complete', status: 'True' }];
  f.store(jobPath, job);
  const podPath = `/api/v1/namespaces/${ns.metadata.name}/pods/migration-pod`;
  const pod = f.store(podPath, {
    metadata: {
      name: 'migration-pod',
      namespace: ns.metadata.name,
      ownerReferences: [{ kind: 'Job', controller: true, uid: job.metadata.uid }],
    },
    status: { phase: 'Running' },
  });
  await assert.rejects(settleStaging(f.state, cloud, actor, wait), /migration\/test jobs physically stopped/);
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 0);
  pod.status.phase = 'Succeeded';
  f.store(podPath, pod);
  await settleStaging(f.state, cloud, actor, wait);
  assert.equal((await f.state.read()).record.phase, 'settled');
});

test('route teardown permits already inventoried Gateway children to disappear without dropping their identities', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  const routePath = `/apis/gateway.networking.k8s.io/v1/namespaces/${ns.metadata.name}/httproutes/qualification`;
  f.store(routePath, { metadata: { name: 'qualification', namespace: ns.metadata.name } });
  const prefix = `projects/${settings().projectId}`,
    neg = `${prefix}/zones/zone-a/networkEndpointGroups/test-neg`,
    backend = `${prefix}/regions/region-a/backendServices/test-backend`,
    health = `${prefix}/regions/region-a/healthChecks/test-health`;
  const value = (resource, id) => ({
    id,
    selfLink: `https://www.googleapis.com/compute/v1/${resource}`,
    creationTimestamp: new Date().toISOString(),
  });
  const backendValue = {
    ...value(backend, '102'),
    backends: [{ group: `https://www.googleapis.com/compute/v1/${neg}` }],
    healthChecks: [`https://www.googleapis.com/compute/v1/${health}`],
  };
  f.store(`/api/v1/namespaces/${ns.metadata.name}/services/proxy`, {
    metadata: {
      name: 'proxy',
      namespace: ns.metadata.name,
      annotations: {
        'cloud.google.com/neg': '{}',
        'cloud.google.com/neg-status': JSON.stringify({
          zones: ['zone-a'],
          network_endpoint_groups: { 80: 'test-neg' },
        }),
      },
    },
  });
  const server = http.createServer((req, res) => {
    const resource = new URL(req.url, 'http://fixture.invalid').pathname.replace('/compute/v1/', '');
    res.setHeader('content-type', 'application/json');
    if (resource.endsWith('/aggregated/backendServices'))
      return res.end(
        JSON.stringify({ items: { regional: { backendServices: f.objects.has(routePath) ? [backendValue] : [] } } }),
      );
    if (resource === neg) return res.end(JSON.stringify(value(neg, '101')));
    if (f.objects.has(routePath) && resource === backend) return res.end(JSON.stringify(backendValue));
    if (f.objects.has(routePath) && resource === health) return res.end(JSON.stringify(value(health, '103')));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const reader = stagingCloudReader(settings(), {
    token: async () => 'fixture-only',
    fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options),
  });
  const inventory = await settleStaging(f.state, reader, actor, wait);
  assert.ok(inventory.some((i) => i.resource === backend));
  assert.ok(inventory.some((i) => i.resource === health));
  assert.equal((await f.state.read()).record.phase, 'settled');
  await assert.rejects(
    reader.children(
      [...inventory, { id: 'new-neg', kind: 'neg', resource: `${prefix}/zones/zone-a/networkEndpointGroups/new-neg` }],
      { requiredNegIds: ['new-neg'] },
    ),
    PendingGatewayBackendError,
  );
});

test('reusable fixture validates infrastructure scope and exports only runtime sizing', () => {
  assert.ok(settings());
  for (const patch of [
    { projectId: 'wartime-storyteller' },
    { trustedClients: ['0.0.0.0/0'] },
    { region: undefined },
    { trustedForwardingProxies: undefined },
    { trustedForwardingProxies: [] },
    { trustedForwardingProxies: ['192.0.2.200/32'] },
    { trustedForwardingProxies: ['192.0.2.200/32', '192.0.2.200/32'] },
    { trustedForwardingProxies: ['0.0.0.0/0'] },
    { trustedForwardingProxies: ['::/0'] },
    { trustedForwardingProxies: ['proxy.example.test'] },
    { domain: 'storyteller-rivet.litnet.com' },
    { runnerNamespace: 'default' },
  ])
    assert.throws(() => reusableStagingSettings({ ...settings(), ...patch }));
  const sizing = qualificationSizing({
    resources: { execution: { requests: { cpu: '500m', memory: '1Gi', password: 'secret' } } },
    postgres: { maxConnections: 250, passwordSecretName: 'secret' },
    env: { KEY: 'secret' },
    lifecycle: { preStopDelaySeconds: 60 },
  });
  assert.equal(sizing.resources.execution.requests.cpu, '500m');
  assert.equal(sizing.lifecycle.preStopDelaySeconds, 60);
  assert.ok(!JSON.stringify(sizing).includes('secret'));
});
test('concrete provider Helm render retains installed production timing, real manifest identity and seven application owners', async (t) => {
  const rootDir = fileURLToPath(new URL('../../../', import.meta.url)),
    evidence = { workflow: 'Build Images', runId: '123', runAttempt: 1 };
  const make = (letter, predecessorRelease) =>
    createStudioServerReleaseManifest({
      rootDir,
      source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: letter.repeat(40) },
      images: Object.fromEntries(
        ['proxy', 'web', 'api', 'executor'].map((role) => [
          role,
          { repository: `registry.test/${role}`, digest: `sha256:${letter.repeat(64)}` },
        ]),
      ),
      candidateEvidence: evidence,
      predecessorRelease,
    });
  const previous = promoteStudioServerReleaseManifest(make('a'), { promotionEvidence: evidence }),
    candidate = make('b', previous);
  const policy = autoscalerPolicy({ minReplicas: 2, maxReplicas: 4 });
  const envelope = {
    resources: {
      backend: { requests: { cpu: '500m', memory: '1Gi' } },
      execution: { requests: { cpu: '500m', memory: '1Gi' } },
      web: { requests: { cpu: '500m', memory: '512Mi' } },
      proxy: { requests: { cpu: '500m', memory: '512Mi' } },
    },
    lifecycle: { shutdownGraceSeconds: 180, terminationGracePeriodSeconds: 270, preStopDelaySeconds: 60 },
    rollout: { minReadySeconds: 120, maxUnavailable: 0, maxSurge: 1 },
    postgres: { maxConnections: 250, reservedConnections: 30, poolMaxPerApiPod: 10 },
    legacyRestore: { enabled: true, size: '8Gi' },
    publishedExecutionAdmission: { mode: 'enforce', maxActiveRunsPerPod: 4, retryAfterSeconds: 1 },
  };
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-render-'));
  t.after(() => fs.rm(folder, { recursive: true }));
  const gate = new ReusableProviderGate(
    {
      ...operation(),
      previous,
      candidate,
      policy,
      policyDigest: autoscalerPolicyDigest(policy),
      installed: { qualificationValues: envelope },
    },
    settings(),
    {},
    folder,
  );
  const values = gate.values();
  assert.equal(values.rollout.minReadySeconds, 120);
  assert.equal(values.lifecycle.preStopDelaySeconds, 60);
  assert.equal(values.release.production.manifestDigest, getStudioServerReleaseManifestDigest(candidate));
  gate.operation.executionPools = true;
  envelope.ha = { executionPools: { enabled: true, active: 'a', retiringReplicas: 0, maxSurgeReplicas: 4 } };
  assert.equal(gate.values().ha.executionPools.maxSurgeReplicas, 4);
  delete envelope.ha;
  gate.operation.executionPools = false;
  // Tool-only qualification can reuse every image. Rendering must still
  // distinguish the actual predecessor from the candidate's evidence identity.
  const publishedSameImages = promoteStudioServerReleaseManifest(candidate, { promotionEvidence: evidence });
  gate.currentManifest = publishedSameImages;
  gate.config.previousManifest = publishedSameImages;
  gate.operation.previous = publishedSameImages;
  assert.equal(
    gate.values(candidate.images).release.production.manifestDigest,
    getStudioServerReleaseManifestDigest(candidate),
  );
  assert.equal(
    gate.values(candidate.images, true, publishedSameImages).release.production.manifestDigest,
    getStudioServerReleaseManifestDigest(publishedSameImages),
  );
  gate.currentManifest = previous;
  gate.config.previousManifest = previous;
  gate.operation.previous = previous;
  assert.equal(values.env.RIVET_REQUIRE_UI_GATE_KEY, 'true');
  assert.equal(values.env.RIVET_TRUST_INCOMING_FORWARDED_HEADERS, 'true');
  assert.equal(values.env.RIVET_TRUSTED_FORWARDING_PROXIES, settings().trustedForwardingProxies.join(','));
  assert.equal(values.env.RIVET_DEVELOPMENT_AUTH_CLIENTS, settings().trustedClients.join(','));
  assert.equal(values.legacyRestore.storageClassName, settings().storageClassName);
  const rendered = await gate.resources(values, 'provider');
  const owners = rendered.filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind));
  assert.equal(
    owners.reduce((n, r) => n + (r.spec.replicas ?? 1), 0),
    7,
  );
  assert.ok(!owners.some((r) => r.spec.template.spec.volumes?.some((v) => v.hostPath)));
  gate.operation.sizingRequests = { web: { cpu: '50m', memory: '128Mi' }, proxy: { cpu: '100m', memory: '128Mi' } };
  const sizedValues = gate.values();
  const sized = await gate.resources(sizedValues, 'sizing');
  for (const role of ['web', 'proxy']) {
    const workload = sized.find(
      (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === role,
    );
    assert.deepEqual(
      workload.spec.template.spec.containers.find((c) => c.name === role).resources.requests,
      gate.operation.sizingRequests[role],
    );
    assert.equal(envelope.resources[role].requests.cpu, '500m');
  }
  assert.deepEqual(sizedValues.resources.backend, values.resources.backend);
  assert.deepEqual(sizedValues.lifecycle, values.lifecycle);
  assert.deepEqual(sizedValues.autoscaling, values.autoscaling);
  delete gate.operation.sizingRequests;
  const proxies = Array.from({ length: 2 }, (_, i) => ({
    metadata: {
      name: `proxy-${i}`,
      uid: `proxy-${i}`,
      namespace: gate.config.namespace,
      labels: { 'app.kubernetes.io/instance': gate.config.release, 'app.kubernetes.io/component': 'proxy' },
    },
    spec: {
      nodeName: `node-${i}`,
      readinessGates: [{ conditionType: 'cloud.google.com/load-balancer-neg-ready' }],
      topologySpreadConstraints: [
        {
          topologyKey: 'topology.kubernetes.io/zone',
          nodeTaintsPolicy: 'Honor',
          whenUnsatisfiable: 'DoNotSchedule',
          minDomains: 2,
          maxSkew: 1,
        },
      ],
      containers: [{ ports: [{ name: 'http', containerPort: 8080 }] }],
    },
    status: {
      podIP: `10.0.0.${i + 1}`,
      conditions: [
        { type: 'Ready', status: 'True' },
        {
          type: 'cloud.google.com/load-balancer-neg-ready',
          status: 'True',
          reason: 'LoadBalancerNegWithoutHealthCheck',
        },
      ],
    },
  }));
  const web = structuredClone(proxies[0]);
  web.metadata.uid = 'web-0';
  web.metadata.labels['app.kubernetes.io/component'] = 'web';
  const nodes = proxies.map((p, i) => ({
    metadata: {
      name: p.spec.nodeName,
      uid: `node-uid-${i}`,
      labels: { 'kubernetes.io/hostname': p.spec.nodeName, 'topology.kubernetes.io/zone': `zone-${i}` },
    },
  }));
  const service = {
    metadata: {
      uid: 'proxy-service',
      namespace: gate.config.namespace,
      annotations: {
        'cloud.google.com/neg-status': JSON.stringify({
          zones: ['zone-0', 'zone-1'],
          network_endpoint_groups: { 80: 'proxy-neg' },
        }),
      },
    },
    spec: { selector: { 'app.kubernetes.io/component': 'proxy' }, ports: [{ port: 80, targetPort: 'http' }] },
  };
  gate.assertProofContext = async () => {};
  gate.kubectl = async (args) => ({
    stdout: JSON.stringify(
      args.includes('deployment')
        ? {
            metadata: { name: `${gate.config.release}-proxy`, generation: 1 },
            spec: { replicas: 2, minReadySeconds: 120 },
            status: { observedGeneration: 1, updatedReplicas: 2, availableReplicas: 2 },
          }
        : args.includes('service')
          ? service
          : { items: args.includes('pods') ? [...proxies, web] : nodes },
    ),
  });
  gate.observeProxyBackend = async (current) => {
    assert.equal(current.metadata.uid, service.metadata.uid);
    return {
      healthy: true,
      serviceUid: service.metadata.uid,
      backendService: 'regional',
      backendServiceId: '123',
      observedAt: Date.now(),
      healthyEndpoints: proxies.map((p, i) => ({
        ipAddress: p.status.podIP,
        port: 8080,
        zone: `zone-${i}`,
        neg: 'proxy-neg',
      })),
    };
  };
  gate.config.deploymentTimeoutSeconds = 1;
  assert.ok(
    (await gate.frontendAvailability())
      .filter((p) => p.component === 'proxy')
      .every((p) => p.negHealth === 'ComputeHealthy'),
    'The provider HPA frontend caller must use actual Compute health too',
  );
  const edgeWrites = [];
  gate.assertProofContext = async () => {};
  gate.kube = async (args, options) => {
    if (args[0] === 'create') {
      edgeWrites.push(JSON.parse(options.input));
      return { stdout: '' };
    }
    assert.deepEqual(args.slice(0, 2), ['get', 'service']);
    return {
      stdout: JSON.stringify({
        metadata: {
          annotations: {
            'cloud.google.com/neg-status': JSON.stringify({
              zones: ['zone-a', 'zone-b'],
              network_endpoint_groups: { 80: 'new-neg' },
            }),
          },
        },
      }),
    };
  };
  await gate.createPublicRoute();
  assert.deepEqual(
    edgeWrites.map((r) => r.kind),
    ['Service', 'HTTPRoute', 'HealthCheckPolicy'],
  );
  assert.equal(edgeWrites[0].metadata.annotations['meta.helm.sh/release-namespace'], gate.config.namespace);
  gate.operation.installed.qualificationValues.postgres.maxConnections = 200;
  gate.operation.policy.maxReplicas = 7;
  gate.operation.policyDigest = autoscalerPolicyDigest(gate.operation.policy);
  gate.operation.developerOverlapProfile = {
    protocol: 1,
    maxConnections: 200,
    reservedConnections: 30,
    poolMaxPerApiPod: 9,
    backendResources: {
      requests: { cpu: '750m', memory: '1536Mi', 'ephemeral-storage': '256Mi' },
      limits: { memory: '3Gi', 'ephemeral-storage': '2Gi' },
    },
  };
  gate.kube = gate.kubectl = async () => {
    throw Error('Render-only capacity preflight attempted a cluster command');
  };
  await gate.verifyOverlapCapacity();
  assert.equal(gate.overlap, false, 'Render-only validation must not adopt a live topology');
  gate.operation.developerOverlapProfile.poolMaxPerApiPod = 10;
  await assert.rejects(gate.verifyOverlapCapacity(), /201 connections/);
});
test('real HTTP lost CREATE acknowledgement reconciles exact nonce once; replaced namespace and uncertain absence fail closed', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  f.loseCreate();
  await assert.rejects(f.state.namespace({ create: true }));
  const ns = await f.state.namespace();
  assert.ok(ns.metadata.uid);
  assert.equal(f.requests.filter((r) => r.method === 'POST' && r.pathname === '/api/v1/namespaces').length, 1);
  ns.metadata.uid = 'foreign-replacement';
  f.objects.set('/api/v1/namespaces/' + ns.metadata.name, ns);
  await assert.rejects(f.state.namespace(), /equal/);
  f.objects.delete('/api/v1/namespaces/' + ns.metadata.name);
  const second = await fixture(t);
  await second.state.arm(actor);
  await second.state.change((r) => {
    r.namespaceCreateIssued = true;
  });
  await assert.rejects(second.state.namespace(), /uncertain/);
});

test('provider preflight checks the actual resolved public client over HTTP before dummy OAuth', async (t) => {
  let clientAddress = '198.51.100.18';
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ clientAddress, trusted: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const gate = Object.create(ReusableProviderGate.prototype);
  gate.config = { baseUrl: `http://127.0.0.1:${server.address().port}` };
  gate.settings = { trustedClients: ['198.51.100.0/24'] };
  gate.secrets = { rivetKey: 'fixture-only-key' };
  gate.uiCookie = 'rivet_ui_token=fixture';
  assert.deepEqual(await gate.verifyClientProvenance(), { verifiedPublicTestClient: true });
  for (const address of ['172.30.32.7', '192.0.2.200', '127.0.0.1', null, 'not-an-address']) {
    clientAddress = address;
    await assert.rejects(gate.verifyClientProvenance(), /allowed public test client/);
  }
  assert.ok(
    requests.every((r) => r.method === 'GET' && r.path === '/api/app-settings/trusted-clients/current-request'),
  );
});
test('real fixture OAuth configuration cannot expire before its approved full-test window', async (t) => {
  const observed = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/api/app-settings/web-app-auth');
    observed.push(JSON.parse(Buffer.concat(chunks)));
    // Stop at this real HTTP boundary; the fixture must not seed/login here.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const gate = Object.create(ReusableProviderGate.prototype);
  gate.config = { baseUrl: `http://127.0.0.1:${server.address().port}` };
  gate.secrets = { rivetKey: 'fixture-only-key' };
  gate.uiCookie = 'rivet_ui_token=fixture';
  const startedAt = '2026-01-01T00:00:00Z';
  for (const [expiresAt, expectedTtl] of [
    ['2026-01-01T02:00:00Z', 10800],
    ['2026-01-01T04:00:00Z', 14400],
  ]) {
    gate.operation = { startedAt, expiresAt };
    await assert.rejects(gate.enableOAuth(gate.config.baseUrl, 'fixture'));
    assert.equal(observed.at(-1).sessionTtlSeconds, expectedTtl);
  }
  assert.equal(observed.length, 2);
});

test('normal cleanup proves exact absence and retains shared Gateway, runner and control registry', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  await settleStaging(f.state, cloud, actor, wait);
  await cleanupStaging(f.state, actor);
  const result = await verifyStagingCleanup(f.state, cloud);
  assert.equal(result.uncertainWrites, 0);
  assert.ok(result.resources.length);
  assert.ok([...f.objects.keys()].some((k) => k.includes('/gateways/')));
  assert.ok(f.objects.has(`/api/v1/namespaces/${actor.namespace}/pods/${actor.name}`));
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 1);
});
test(
  'provider startup observer matches manifest image objects and rejects stale or recovered log evidence',
  { timeout: 15000 },
  async (t) => {
    for (const change of ['fatal', 'init', 'recovered', 'replaced', 'deleting', 'image-changed', 'starting'])
      await t.test(change, async () => {
        const gate = Object.create(ReusableProviderGate.prototype),
          stop = new AbortController();
        const image = { repository: 'registry.test/api', digest: `sha256:${'a'.repeat(64)}` };
        gate.operation = { previous: { images: { api: image } }, candidate: { images: { api: image } } };
        gate.config = { release: 'rivet-qualification' };
        const pod = {
          metadata: {
            uid: 'original-pod',
            name: 'autoscaler',
            ownerReferences: [{ kind: 'ReplicaSet', controller: true }],
          },
          spec: { containers: [{ name: 'autoscaler', image: `${image.repository}@${image.digest}` }] },
          status: {
            containerStatuses: [
              {
                name: 'autoscaler',
                ready: false,
                restartCount: 2,
                state: { waiting: { reason: 'CrashLoopBackOff' } },
                lastState: { terminated: { exitCode: 1 } },
              },
            ],
          },
        };
        if (change === 'init') {
          pod.spec.initContainers = pod.spec.containers;
          pod.spec.containers = [];
          pod.status.initContainerStatuses = pod.status.containerStatuses;
          pod.status.containerStatuses = [];
        }
        let lists = 0,
          reads = 0,
          logs = 0;
        gate.kube = async (args) => {
          if (args[0] === 'get' && args[1] === 'pods') {
            assert.ok(args.includes('app.kubernetes.io/instance=rivet-qualification'));
            if (++lists > 1) stop.abort(new Error('observation completed'));
            return { exitCode: 0, stdout: JSON.stringify({ items: lists === 1 ? [pod] : [] }) };
          }
          if (args[0] === 'get' && args[1] === 'pod') {
            const current = structuredClone(pod);
            if (++reads === 2) {
              setImmediate(() => stop.abort(new Error('observation completed')));
              if (change === 'recovered') current.status.containerStatuses[0].ready = true;
              if (change === 'replaced') current.metadata.uid = 'replacement-pod';
              if (change === 'deleting') current.metadata.deletionTimestamp = 'now';
              if (change === 'image-changed') current.spec.containers[0].image = 'foreign';
              if (change === 'starting') current.status.containerStatuses[0].state = { running: {} };
            }
            return { exitCode: 0, stdout: JSON.stringify(current) };
          }
          assert.equal(args[0], 'logs');
          assert.ok(args.includes('--previous') && args.includes('--limit-bytes=16384'));
          logs++;
          return { exitCode: 0, stdout: 'Error [ERR_MODULE_NOT_FOUND]: private dependency path' };
        };
        await gate.observeFatalStartup(stop);
        assert.equal(logs, 1, 'The real provider adapter must match the manifest image digest');
        assert.equal(stop.signal.reason.code === 'RIVET_FATAL_STARTUP', ['fatal', 'init'].includes(change));
      });
  },
);

test('independent janitor stays quiet before expiry; after expiry stops exact runner then cleans namespace', async (t) => {
  const op = operation(Date.now() - 1000),
    f = await fixture(t, op);
  await f.state.arm(actor);
  // Arm is free; expired operations cannot start a namespace.
  await assert.rejects(f.state.admission(), /closed/);
  const options = { api: f.api, cloud, settings: { ...settings(), approvedDriverDigest: digest }, owner, wait };
  const early = await stagingJanitorPass({ ...options, now: () => Date.now() - 10000 });
  assert.deepEqual(early, []);
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 0);
  const outcomes = await stagingJanitorPass(options);
  assert.equal(outcomes[0].status, 'cleaned');
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 1);
  assert.equal(f.requests.find((r) => r.method === 'DELETE').input.preconditions.uid, actor.uid);
});
test('new janitors ignore verified completed history but retain driver fences for unresolved or inconsistent records', async (t) => {
  for (const mode of ['completed', 'unresolved', 'inconsistent', 'malformed-flag', 'tampered-input'])
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      await f.state.arm(actor);
      await f.state.change((record) => {
        record.cleanupVerified = mode !== 'unresolved';
        if (mode === 'malformed-flag') record.cleanupVerified = 'true';
        record.closed = mode !== 'inconsistent';
        record.phase = 'cleaned';
      });
      if (mode === 'tampered-input') {
        const object = f.objects.get(
          `/api/v1/namespaces/${settings().controlNamespace}/configmaps/${f.state.operation.operationId}`,
        );
        const record = JSON.parse(object.data.record);
        record.operation.inputHash = 'f'.repeat(64);
        object.data.record = JSON.stringify(record);
      }
      const outcomes = await stagingJanitorPass({
        api: f.api,
        cloud,
        settings: { ...settings(), approvedDriverDigest: mode === 'malformed-flag' ? digest : 'b'.repeat(64) },
        owner,
        wait,
      });
      if (mode === 'completed') assert.deepEqual(outcomes, []);
      else assert.equal(outcomes[0].status, 'blocked-inspect-private-registry');
      assert.equal(f.requests.filter((r) => r.method === 'DELETE' || r.method === 'PATCH').length, 0);
    });
});

test('paused cleanup owner and unacknowledged DELETE block takeover/replay rather than declaring success', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  await f.state.claimCleanup(actor);
  await assert.rejects(f.state.claimCleanup(owner), /live or paused/);
  await settleStaging(f.state, cloud, actor, wait);
  f.pendingDelete();
  await assert.rejects(cleanupStaging(f.state, actor));
  await assert.rejects(verifyStagingCleanup(f.state, cloud), /uncertain/);
  await assert.rejects(cleanupStaging(f.state, actor));
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 1);
});
test('settlement waits only for pending Gateway backend creation before withdrawing routes', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  let reads = 0,
    pendingObserved = false;
  const pendingCloud = {
    ...cloud,
    async children() {
      if (++reads === 1) throw new PendingGatewayBackendError();
      return [];
    },
  };
  await settleStaging(f.state, pendingCloud, actor, async (name, check) => {
    if (name.includes('Gateway backend discovery')) {
      assert.equal(await check(), null);
      pendingObserved = true;
      assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 0);
    }
    return wait(name, check);
  });
  assert.equal(pendingObserved, true);
  assert.equal((await f.state.read()).record.phase, 'settled');

  const denied = await fixture(t);
  await denied.state.arm(actor);
  await denied.state.namespace({ create: true });
  let deniedReads = 0;
  await assert.rejects(
    settleStaging(
      denied.state,
      {
        ...cloud,
        children: async () => {
          deniedReads++;
          throw Error('denied discovery');
        },
      },
      actor,
      wait,
    ),
    /denied discovery/,
  );
  assert.equal(deniedReads, 1, 'Permission and ambiguous discovery failures are not pending-state retries');
  assert.equal(denied.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('actual HTTP/WebSocket settlement drains the exact backend container, never aborts, and incomplete CSI blocks deletion', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  f.store(`/api/v1/namespaces/${ns.metadata.name}/pods/backend-0`, {
    metadata: { name: 'backend-0', namespace: ns.metadata.name, labels: { 'app.kubernetes.io/component': 'backend' } },
  });
  await settleStaging(f.state, cloud, actor, wait);
  assert.equal(f.execCalls.length, 3);
  assert.ok(f.execCalls.every((c) => c.container === 'backend'));
  assert.ok(f.execCalls.every((c) => !c.commands.some((arg) => /abort|force/.test(arg))));
  assert.deepEqual(f.execCalls[1].commands.slice(-2), ['exact-incarnation', '120']);
  const lost = await fixture(t);
  await lost.state.arm(actor);
  const lostNamespace = await lost.state.namespace({ create: true });
  lost.store(`/api/v1/namespaces/${lostNamespace.metadata.name}/pods/backend-0`, {
    metadata: {
      name: 'backend-0',
      namespace: lostNamespace.metadata.name,
      labels: { 'app.kubernetes.io/component': 'backend' },
    },
  });
  lost.loseRetirementAck();
  await settleStaging(lost.state, cloud, actor, wait);
  assert.equal(
    lost.execCalls.filter((c) => c.commands.length > 2).length,
    1,
    'Accepted retirement is inspected, never replayed',
  );
  const second = await fixture(t);
  await second.state.arm(actor);
  const ns2 = await second.state.namespace({ create: true });
  second.store(`/api/v1/namespaces/${ns2.metadata.name}/persistentvolumeclaims/new-disk`, {
    metadata: { name: 'new-disk', namespace: ns2.metadata.name },
    status: { phase: 'Pending' },
  });
  await assert.rejects(settleStaging(second.state, cloud, actor, wait), /Pending CSI/);
  await assert.rejects(cleanupStaging(second.state, actor));
  assert.equal(second.requests.filter((r) => r.method === 'DELETE').length, 0);
});
test('a newly bound claim cannot grant cleanup ownership over an old disk/PV', async (t) => {
  const f = await fixture(t);
  await f.state.arm(actor);
  const ns = await f.state.namespace({ create: true });
  const claim = f.store(`/api/v1/namespaces/${ns.metadata.name}/persistentvolumeclaims/reused`, {
    metadata: { name: 'reused', namespace: ns.metadata.name },
    spec: { volumeName: 'pre-existing-volume' },
    status: { phase: 'Bound' },
  });
  f.store('/api/v1/persistentvolumes/pre-existing-volume', {
    metadata: {
      name: 'pre-existing-volume',
      creationTimestamp: '2020-01-01T00:00:00.000Z',
      annotations: { 'pv.kubernetes.io/provisioned-by': 'pd.csi.storage.gke.io' },
    },
    spec: {
      claimRef: { namespace: ns.metadata.name, uid: claim.metadata.uid },
      persistentVolumeReclaimPolicy: 'Delete',
      csi: {
        driver: 'pd.csi.storage.gke.io',
        volumeHandle: 'projects/isolated-staging/zones/europe-central2-a/disks/old',
      },
    },
  });
  await assert.rejects(settleStaging(f.state, cloud, actor, wait), /Pre-existing PV/);
  assert.equal(f.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('concrete phase boundary records intent before seed work and never replays a failed preparation', async (t) => {
  const f = await fixture(t),
    op = f.state.operation;
  await f.state.arm(actor);
  await f.state.change((record) => {
    record.workers.push({ id: '123:456', phase: 'prepare', closed: false });
  });
  let writes = 0;
  const gate = {
    verifySharedPrerequisites: async () => {},
    values: () => ({}),
    verifyAdmission: async () => {},
    installDependencies: async () => {
      assert.equal(
        (await f.state.read()).record.workers[0].progress.step,
        'dependencies',
        'Progress must precede the actual operation',
      );
      writes++;
      throw Error('lost fixture write acknowledgement');
    },
  };
  const input = {
    phase: 'prepare',
    operation: { ...op, previous: { images: {} }, candidate: { images: {} } },
    state: f.state,
    cloud,
    actor,
    gate,
    wait,
    step: providerProgressStep(f.state, 'prepare', '123:456', Date.parse(op.expiresAt)),
  };
  await assert.rejects(executeProviderPhase(input), /lost fixture/);
  await assert.rejects(executeProviderPhase(input), /Never replay/);
  assert.equal(writes, 1);
  const progress = (await f.state.read()).record.workers[0].progress;
  assert.equal(progress.sequence, 4);
  assert.ok(progress.deadlineAt <= Date.parse(op.expiresAt));
});
test('provider absence must be an actual 404, not JSON/HTML 5xx or a disconnected API', async (t) => {
  let status = 503;
  let payload = 'upstream unavailable';
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const reader = stagingCloudReader(settings(), {
    token: async () => 'fixture',
    fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options),
  });
  const resource = `projects/${settings().projectId}/zones/europe-central2-a/disks/owned-disk`;
  await assert.rejects(reader.get(resource), /absence/);
  status = 502;
  await assert.rejects(reader.get(resource), /absence/);
  status = 404;
  assert.equal(await reader.get(resource), null);
  await assert.rejects(reader.get(resource.replace(settings().projectId, 'wartime-storyteller')), /Foreign/);
  status = 200;
  payload = JSON.stringify({
    projectId: settings().projectId,
    projectNumber: settings().projectNumber,
    lifecycleState: 'ACTIVE',
  });
  assert.deepEqual(await reader.project(), {
    projectId: settings().projectId,
    projectNumber: settings().projectNumber,
  });
  payload = JSON.stringify({ projectId: settings().projectId, projectNumber: '99999', lifecycleState: 'ACTIVE' });
  await assert.rejects(reader.project(), /equal/);
});
test('OAuth setup rejects foreign login/callback redirects before another request or cookie disclosure', async (t) => {
  for (const foreignAt of ['login', 'callback']) {
    const calls = [];
    const server = http.createServer(async (req, res) => {
      calls.push(req.url);
      for await (const _chunk of req) {
        /* consume bounded fixture form */
      }
      if (calls.length === 1) {
        res.writeHead(302, {
          'set-cookie': 'rivet_web_app_oauth_state=fixture; Path=/',
          location: foreignAt === 'login' ? 'https://foreign.invalid/dummy?state=fixture' : '/dummy?state=fixture',
        });
      } else res.writeHead(303, { location: 'https://foreign.invalid/callback' });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await assert.rejects(
      createReleaseGateWebAppOAuthSession(
        `http://127.0.0.1:${server.address().port}`,
        'owned-app',
        'fixture@example.test',
      ),
      /owned fixture origin/,
    );
    assert.equal(calls.length, foreignAt === 'login' ? 1 : 2);
  }
});

test('shared persistence seed carries real UI/Bearer authentication through every HTTP and WebSocket path', async (t) => {
  const headers = { authorization: 'Bearer staging-only', cookie: 'rivet_ui_token=fixture-only' };
  const { relativePath, requests, failures, origin } = await persistenceFixture(t, { headers });
  const gate = new ManagedReleaseGate({}, 'unused-kubectl', 'unused-helm');
  gate.secrets = { rivetKey: 'staging-only' };
  Object.defineProperty(gate, 'probeHeaders', { get: () => headers });
  const original = gate.requestWorkflow.bind(gate);
  gate.requestWorkflow = (base, route, options) =>
    original(base, route, { ...options, headers: { ...headers, ...options?.headers } });
  const result = await gate.exercisePersistence(origin);
  assert.equal(result.relativePath, relativePath);
  assert.equal(result.replayRecordingId, 'recording-0');
  assert.deepEqual(failures, []);
  assert.ok(requests.length >= 20);
});

for (const oauth of [false, true])
  test(`provider persistence authenticates HTML, actions and sockets with ${oauth ? 'retained OAuth' : 'fresh settings'}`, async (t) => {
    const gate = Object.create(ReusableProviderGate.prototype);
    gate.secrets = { rivetKey: 'staging-only' };
    gate.uiCookie = 'rivet_ui_token=fixture-only';
    gate.operation = { startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7200000).toISOString() };
    const app = await persistenceFixture(t, { headers: () => gate.probeHeaders, oauth });
    gate.config = { baseUrl: app.origin };
    const before = await fetch(`${app.origin}/apps/release-gate-web-app`, { headers: gate.probeHeaders });
    assert.equal(before.status, oauth ? 401 : 200);
    await before.body?.cancel();
    const result = await gate.exercisePersistence(app.origin);
    assert.equal(result.projectId, app.projectId);
    assert.deepEqual(app.failures, []);
    assert.equal(app.requests.filter((route) => route.endsWith('/web-app-auth')).length, 1);
    assert.ok(
      app.requests.indexOf('/api/workflows/projects/web-apps/access') <
        app.requests.indexOf('/apps-latest/release-gate-web-app'),
    );
  });

test('web-app diagnostics reject login pages, redirects and bad responses without exporting secrets or following redirects', async (t) => {
  let response = { status: 401, type: 'text/html', body: '<title>Sign in required</title>private-test-sentinel' };
  let followed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/unexpected-redirect') followed = true;
    res.writeHead(response.status, {
      'content-type': response.type,
      location: '/unexpected-redirect',
      'set-cookie': 'private-test-sentinel=do-not-export',
    });
    res.end(response.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const gate = new ManagedReleaseGate({}, 'unused-kubectl', 'unused-helm');
  const artifacts = new Map();
  gate.artifact = async (name, content) => artifacts.set(name, JSON.parse(content));
  for (const [status, type, body] of [
    [401, 'text/html', response.body],
    [302, 'text/html', 'Managed release gate app'],
    [502, 'text/html', 'private-test-sentinel'],
    [200, 'text/html', 'Wrong app private-test-sentinel'],
    [200, 'application/json', 'Managed release gate app'],
  ]) {
    response = { status, type, body };
    await assert.rejects(
      gate.readWebAppHtml(`http://127.0.0.1:${server.address().port}`, '/apps/release-gate-web-app'),
      (error) => {
        assert.match(error.message, new RegExp(`GET /apps/release-gate-web-app returned ${status}`));
        assert.equal(error.httpEvidence.status, status);
        assert.equal(error.httpEvidence.bodyBytes, Buffer.byteLength(body));
        assert.equal(error.httpEvidence.signInRequired, status === 401);
        assert.doesNotMatch(
          JSON.stringify({ message: error.message, evidence: error.httpEvidence }),
          /private-test-sentinel/,
        );
        return true;
      },
    );
    assert.equal(artifacts.get('web-app-response-published.json').status, status);
  }
  assert.equal(followed, false);
  gate.artifact = async () => {
    throw new Error('diagnostic disk unavailable');
  };
  await assert.rejects(
    gate.readWebAppHtml(`http://127.0.0.1:${server.address().port}`, '/apps-latest/release-gate-web-app'),
    /returned 200/,
  );
});

test('actual package has a closed hash manifest, import-safe CLI boundaries and independent pinned janitor manifests', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-staging-package-'));
  t.after(() => fs.rm(folder, { recursive: true }));
  const output = path.join(folder, 'new-package');
  const result = await packageReusableStaging({
    settings: settings(),
    output,
    janitorImage: `registry.test/api@sha256:${digest}`,
    googleServiceAccount: `janitor@${settings().projectId}.iam.gserviceaccount.com`,
  });
  const entry = await verifyQualificationDriver(path.join(output, 'driver'), result.driverDigest);
  // Importing the real assembled driver must not run ANY embedded CLI main.
  const imported = await import(pathToFileURL(entry));
  assert.equal(typeof imported.executeProviderPhase, 'function');
  const objects = parseAllDocuments(await fs.readFile(path.join(output, 'janitor.yaml'), 'utf8')).map((d) => {
    assert.deepEqual(d.errors, []);
    return d.toJS();
  });
  const deployment = objects.find((o) => o.kind === 'Deployment');
  const janitorRole = objects.find((o) => o.kind === 'ClusterRole');
  const code = objects.find((o) => o.kind === 'ConfigMap' && o.immutable === true);
  assert.equal(code.metadata.name, `rivet-qualification-janitor-${result.driverDigest.slice(0, 12)}`);
  assert.equal(deployment.spec.template.spec.volumes[0].configMap.name, code.metadata.name);
  assert.deepEqual(
    janitorRole.rules.find((rule) => rule.apiGroups.includes('networking.k8s.io')),
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list'] },
  );
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const version = path.join(folder, 'configmap-version');
  await fs.mkdir(version);
  await fs.writeFile(
    path.join(version, 'janitor.mjs'),
    objects.find((object) => object.kind === 'ConfigMap' && object.data?.['janitor.mjs']).data['janitor.mjs'],
  );
  const mount = path.join(folder, 'configmap-mount');
  if (process.platform === 'win32') await fs.symlink(version, mount, 'junction');
  else {
    await fs.mkdir(mount);
    await fs.symlink('../configmap-version', path.join(mount, '..data'));
    await fs.symlink('..data/janitor.mjs', path.join(mount, 'janitor.mjs'));
  }
  const projectedEntry = path.join(mount, 'janitor.mjs');
  assert.equal(typeof (await import(pathToFileURL(projectedEntry))).stagingJanitorPass, 'function');
  const missingSettings = path.join(folder, 'deliberately-missing-settings.json');
  const command = deployment.spec.template.spec.containers[0].command;
  const environment = { ...process.env, RIVET_QUALIFICATION_SETTINGS_FILE: missingSettings };
  // The deployed node-modules actor uses bare Node, without the test runner's loader.
  delete environment.NODE_OPTIONS;
  const started = spawnSync(
    process.execPath,
    command.slice(1).map((argument) => (argument === '/qualification/janitor.mjs' ? projectedEntry : argument)),
    {
      env: environment,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  assert.equal(started.error, undefined);
  assert.equal(started.status, 1, 'Projected janitor must execute its CLI instead of silently exiting');
  assert.ok(started.stderr.includes('ENOENT') && started.stderr.includes(missingSettings));
  assert.ok(!objects.some((o) => ['Gateway', 'Namespace', 'PersistentVolumeClaim'].includes(o.kind)));
  await assert.rejects(packageReusableStaging({ settings: settings(), output }));
  const overlapSettings = {
    ...settings(),
    developerOverlapProfile: {
      protocol: 1,
      poolMaxPerApiPod: 9,
      maxConnections: 200,
      reservedConnections: 30,
      backendResources: {
        requests: { cpu: '750m', memory: '1536Mi', 'ephemeral-storage': '256Mi' },
        limits: { memory: '3Gi', 'ephemeral-storage': '2Gi' },
      },
    },
  };
  const overlapOutput = path.join(folder, 'overlap-package');
  const overlap = await packageReusableStaging({
    settings: overlapSettings,
    output: overlapOutput,
    janitorImage: `registry.test/api@sha256:${digest}`,
    googleServiceAccount: `janitor@${settings().projectId}.iam.gserviceaccount.com`,
  });
  assert.equal(
    typeof (
      await import(
        pathToFileURL(await verifyQualificationDriver(path.join(overlapOutput, 'driver'), overlap.driverDigest))
      )
    ).executeProviderPhase,
    'function',
  );
  const packaged = JSON.parse(await fs.readFile(path.join(overlapOutput, 'driver/driver.json'), 'utf8'));
  assert.equal(packaged.suite, 'compact-seven-overlap-v1');
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(overlapOutput, 'driver/settings.json'), 'utf8')).developerOverlapProfile,
    overlapSettings.developerOverlapProfile,
  );
});
