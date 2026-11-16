import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProfile, applyExecutionProfile, assertExecutionProfile } from './lib/execution-profile.mjs';
import { transitionRetainedExecutionProfile } from './lib/retained-execution-profile.mjs';
import { qualificationConfigurationDigest } from './lib/release-qualification-policy.mjs';
import { autoscalerPolicy, autoscalerPolicyFromConfig } from './lib/execution-autoscaler.mjs';
import { ReusableProviderGate } from './qualification/provider-gate.mjs';
import {
  createStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const production = { minReplicas: 2, maxActiveRunsPerPod: 32, requests: { cpu: '2', memory: '4Gi' } };
const staging = { minReplicas: 1, maxActiveRunsPerPod: 4, requests: { cpu: '500m', memory: '1Gi' } };

test('profiles change only execution requests and admission, preserving limits and other workloads', () => {
  assert.deepEqual(executionProfile(production), production);
  assert.deepEqual(executionProfile(staging, { staging: true }), staging);
  for (const invalid of [
    staging,
    { ...production, minReplicas: 3 },
    { ...production, maxActiveRunsPerPod: '32' },
    { ...production, maxActiveRunsPerPod: 10001 },
    { ...production, requests: { cpu: '2', memory: '0Gi' } },
    { ...production, requests: { cpu: 'NaN', memory: '4Gi' } },
    { ...production, limits: {} },
  ])
    assert.throws(() => executionProfile(invalid));
  const original = {
    resources: {
      execution: {
        requests: { ...staging.requests, 'ephemeral-storage': '1Gi' },
        limits: { 'ephemeral-storage': '1Gi' },
      },
      web: { requests: { cpu: '50m' } },
    },
    publishedExecutionAdmission: { mode: 'enforce', maxActiveRunsPerPod: 4, retryAfterSeconds: 1 },
  };
  const values = applyExecutionProfile(original, production);
  assertExecutionProfile(values, production);
  assert.deepEqual(values.resources.execution.limits, original.resources.execution.limits);
  assert.equal(values.resources.execution.requests['ephemeral-storage'], '1Gi');
  assert.deepEqual(values.resources.web, original.resources.web);
  assert.equal(values.publishedExecutionAdmission.retryAfterSeconds, 1);
  assertExecutionProfile(original, staging);
  assert.throws(() => assertExecutionProfile(values, staging));
});

test('qualification binds both production and staging profiles without changing legacy digests', () => {
  const installed = {
    controlPlaneMode: 'singleton',
    qualificationValues: { resources: {}, lifecycle: {}, postgres: {} },
  };
  const digest = (...args) => qualificationConfigurationDigest(installed, { minReplicas: 2 }, ...args);
  assert.equal(digest(), digest(undefined, undefined, undefined));
  assert.notEqual(digest(), digest(undefined, undefined, staging));
  assert.notEqual(
    digest(undefined, undefined, staging),
    digest(undefined, undefined, { ...staging, maxActiveRunsPerPod: 8 }),
  );
  const previous = digest(undefined, undefined, staging);
  installed.qualificationValues = {
    ...installed.qualificationValues,
    ...applyExecutionProfile(
      {
        resources: { execution: { requests: {} } },
        publishedExecutionAdmission: {},
      },
      production,
    ),
  };
  assert.notEqual(previous, digest(undefined, undefined, staging));
});

function fixture({ replicas = 3, lostAck, changed = false, losePatch = 1 } = {}) {
  let values = {
    images: { api: { repository: 'registry.test/api', digest: 'sha256:' + 'a'.repeat(64) } },
    release: { production: { manifestDigest: 'sha256:' + 'b'.repeat(64) } },
    resources: {
      execution: {
        requests: { ...staging.requests, 'ephemeral-storage': '1Gi' },
        limits: { 'ephemeral-storage': '1Gi' },
      },
    },
    publishedExecutionAdmission: { mode: 'enforce', maxActiveRunsPerPod: 4 },
    ha: {
      executionPools: { enabled: true, active: 'b', retiringReplicas: 0 },
      rolloutResourceVersions: { stale: 'old' },
    },
    replicaCount: { execution: 3, proxy: 1 },
    autoscaling: { execution: { minReplicas: 2 }, executionController: { enabled: true }, proxy: { minReplicas: 1 } },
    workflowSchema: { migrationJob: { enabled: false } },
  };
  const record = {
    closed: true,
    phase: 'settled',
    acceptedWorkSettled: true,
    testPhases: { prepare: { state: 'intent' } },
  };
  if (replicas === 1) {
    values.ha.stagingSingleExecution = true;
    values.autoscaling.execution.minReplicas = 1;
  }
  const writes = [];
  const patches = [];
  const policy = autoscalerPolicy({ minReplicas: 2, maxReplicas: 7, maxSurgeReplicas: 7 });
  const config = {
    namespace: 'rivet-staging-persistent',
    release: 'rivet-qualification',
    workload: 'pool-b',
    policy: { ...policy, minReplicas: 1 },
    stagingSingleExecution: true,
    maxSurgeReplicas: 7,
    image: `${values.images.api.repository}@${values.images.api.digest}`,
    manifestDigest: values.release.production.manifestDigest,
  };
  delete config.policy.maxSurgeReplicas;
  const owners = {
    deployment: {
      metadata: { uid: 'controller-uid', resourceVersion: '1' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'autoscaler', env: [{ name: 'RIVET_AUTOSCALER_CONFIG', value: JSON.stringify(config) }] },
            ],
          },
        },
      },
    },
    statefulset: { metadata: { uid: 'pool-b', resourceVersion: '1' }, spec: { replicas } },
  };
  const gate = {
    config: { namespace: config.namespace, release: config.release },
    operation: {
      stagingExecutionProfile: staging,
      policy,
      candidate: {},
      qualification: { tier: 'focused' },
      executionPools: true,
    },
    state: { read: async () => ({ record: structuredClone(record) }), change: async (fn) => fn(record) },
    assertProofContext: async () => {},
    verifyRetainedInstallation: async () => structuredClone(values),
    retainedExecutionPool: async () => ({
      uid: changed ? 'foreign' : 'pool-b',
      name: 'pool-b',
      replicas,
      versions: { 'pool-b': 'fresh' },
      frontends: { proxy: 2 },
      controller: {
        name: 'autoscaler',
        uid: 'controller-uid',
        policy: autoscalerPolicyFromConfig(JSON.parse(owners.deployment.spec.template.spec.containers[0].env[0].value)),
      },
    }),
    kube: async (args) => {
      const object = owners[args[1]];
      if (args[0] === 'get') return { stdout: JSON.stringify(object) };
      assert.equal(args[0], 'patch');
      const patch = JSON.parse(args.at(-1));
      assert.equal(patch[0].value, object.metadata.uid);
      assert.equal(patch[1].value, object.metadata.resourceVersion);
      patches.push(args);
      if (lostAck !== 'uncommitted' || patches.length !== losePatch) {
        if (args[1] === 'deployment') object.spec.template.spec.containers[0].env[0].value = patch.at(-1).value;
        else {
          object.spec.replicas = patch.at(-1).value;
          replicas = object.spec.replicas;
        }
      }
      if (lostAck && patches.length === losePatch) throw Error('Patch acknowledgement lost');
      return {};
    },
    apply: async (target) => {
      writes.push(structuredClone(target));
      if (lostAck !== 'uncommitted') values = structuredClone(target);
      if (lostAck) throw Error('Helm acknowledgement lost');
    },
    waitRetainedExecutionProfile: async ({ idle, minimum, profile }) => {
      assert.deepEqual(profile, staging);
      assert.equal(minimum, idle ? 1 : 2);
      if (idle) replicas = minimum;
    },
  };
  return {
    gate,
    record,
    writes,
    patches,
    owners,
    values: () => values,
    changeOwner: () => {
      changed = true;
    },
  };
}

test('retained staging grows to three before testing, then lets the controller drain to one', async () => {
  const prepare = fixture({ replicas: 1 });
  await transitionRetainedExecutionProfile(prepare.gate, { idle: false });
  assert.equal(prepare.writes.length, 0, 'Preparation must not apply the candidate chart to predecessor workloads');
  assert.equal(prepare.owners.statefulset.spec.replicas, 3);
  const config = JSON.parse(prepare.owners.deployment.spec.template.spec.containers[0].env[0].value);
  assert.equal(config.stagingSingleExecution, undefined);
  assert.equal(config.policy.minReplicas, 2);
  assert.equal(prepare.record.executionProfileTransitions.prepare.state, 'settled');
  const idle = fixture();
  await transitionRetainedExecutionProfile(idle.gate, { idle: true });
  const target = idle.writes[0];
  assert.equal(target.replicaCount.execution, 3, 'Helm must not directly scale down accepted owners');
  assert.equal(target.replicaCount.proxy, 2, 'Retain live frontend capacity');
  assert.deepEqual(target.ha.rolloutResourceVersions, { 'pool-b': 'fresh' });
  assert.equal(target.ha.executionPools.active, 'b');
  assert.equal(target.ha.stagingSingleExecution, true);
  assert.equal(target.autoscaling.execution.minReplicas, 1);
  assert.equal(idle.record.executionProfileTransitions.idle.state, 'settled');
});

test('uncertain profile writes are read back without replay, and mismatches remain blocked', async () => {
  for (const lostAck of ['committed', 'uncommitted']) {
    const f = fixture({ lostAck });
    await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: true }), /acknowledgement lost/);
    if (lostAck === 'committed') {
      await transitionRetainedExecutionProfile(f.gate, { idle: true });
      assert.equal(f.record.executionProfileTransitions.idle.state, 'settled');
    } else await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: true }), /do not replay/);
    assert.equal(f.writes.length, 1);
  }
  const foreign = fixture({ lostAck: 'committed' });
  await assert.rejects(transitionRetainedExecutionProfile(foreign.gate, { idle: true }));
  foreign.changeOwner();
  await assert.rejects(transitionRetainedExecutionProfile(foreign.gate, { idle: true }), /owner was replaced/);
  assert.equal(foreign.writes.length, 1);
});

test('preparation observes an uncertain controller patch and never resubmits it', async () => {
  for (const lostAck of ['committed', 'uncommitted']) {
    const f = fixture({ replicas: 1, lostAck });
    await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: false }), /Patch acknowledgement lost/);
    if (lostAck === 'committed') {
      await transitionRetainedExecutionProfile(f.gate, { idle: false });
      assert.equal(f.owners.statefulset.spec.replicas, 3);
      assert.equal(f.patches.filter((args) => args[1] === 'deployment').length, 1);
      assert.equal(f.record.executionProfileTransitions.prepare.state, 'settled');
    } else {
      await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: false }), /do not replay/);
      assert.equal(f.patches.length, 1);
    }
    assert.equal(f.writes.length, 0);
  }
});

test('preparation observes an uncertain worker increase without issuing a second scale request', async () => {
  for (const lostAck of ['committed', 'uncommitted']) {
    const f = fixture({ replicas: 1, lostAck, losePatch: 2 });
    await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: false }), /Patch acknowledgement lost/);
    if (lostAck === 'committed') {
      await transitionRetainedExecutionProfile(f.gate, { idle: false });
      assert.equal(f.record.executionProfileTransitions.prepare.state, 'settled');
    } else await assert.rejects(transitionRetainedExecutionProfile(f.gate, { idle: false }), /do not replay/);
    assert.equal(f.patches.length, 2);
    assert.equal(f.writes.length, 0);
  }
});

test('idle settlement requires drained work and rejects configuration drift', async () => {
  const policyDrift = fixture({ replicas: 1 });
  policyDrift.gate.operation.policy.maxReplicas = 8;
  await assert.rejects(transitionRetainedExecutionProfile(policyDrift.gate, { idle: false }), /policy changed/);
  assert.equal(policyDrift.patches.length, 0);
  const busy = fixture();
  busy.record.acceptedWorkSettled = false;
  await assert.rejects(transitionRetainedExecutionProfile(busy.gate, { idle: true }));
  assert.equal(busy.writes.length, 0);
  const drift = fixture();
  drift.gate.waitRetainedExecutionProfile = async () => {
    drift.values().publishedExecutionAdmission.maxActiveRunsPerPod = 8;
  };
  await assert.rejects(transitionRetainedExecutionProfile(drift.gate, { idle: true }), /changed during settlement/);
  assert.equal(drift.record.executionProfileTransitions.idle.state, 'acknowledged');
});

test('idle profile confirmation accepts normal stabilization capacity and verifies live owners and admission', async () => {
  const image = { repository: 'registry.test/api', digest: 'sha256:' + 'a'.repeat(64) };
  const manifest = createStudioServerReleaseManifest({
    rootDir: fileURLToPath(new URL('../../../', import.meta.url)),
    source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'a'.repeat(40) },
    images: Object.fromEntries(['api', 'executor', 'web', 'proxy'].map((name) => [name, image])),
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const gate = Object.create(ReusableProviderGate.prototype);
  gate.config = { namespace: 'rivet-staging-persistent', release: 'rivet-qualification', deploymentTimeoutSeconds: 1 };
  gate.operation = { candidate: manifest, policy: autoscalerPolicy({ maxReplicas: 7 }) };
  gate.assertProofContext = async () => {};
  const controller = {
    metadata: { uid: 'owner', generation: 1 },
    spec: { replicas: 3 },
    status: { observedGeneration: 1 },
  };
  const journal = {
    release: gate.config.release,
    namespace: gate.config.namespace,
    phase: 'complete',
    policyDigest: 'idle-policy',
    lastSampleAt: Date.now(),
    manifestDigest: getStudioServerReleaseManifestDigest(manifest),
  };
  gate.state = { api: { json: async () => ({ data: { record: JSON.stringify(journal) } }) } };
  gate.kube = async () => ({ stdout: JSON.stringify(controller) });
  const pods = Array.from({ length: 3 }, (_, index) => ({
    metadata: {
      uid: `pod-${index}`,
      labels: { 'app.kubernetes.io/component': 'execution' },
      ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: 'owner' }],
    },
    spec: {
      containers: [
        {
          name: 'api',
          image: `${image.repository}@${image.digest}`,
          resources: { requests: staging.requests },
          env: [
            { name: 'RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_ADMISSION_MODE', value: 'enforce' },
            { name: 'RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS', value: '4' },
          ],
        },
      ],
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  }));
  gate.pods = async () => pods;
  const confirm = () =>
    gate.waitRetainedExecutionProfile({
      uid: 'owner',
      name: 'pool',
      idle: true,
      minimum: 1,
      policyDigest: journal.policyDigest,
      profile: staging,
      after: journal.lastSampleAt,
    });
  await confirm();
  pods[0].spec.containers[0].env[1].value = '32';
  await assert.rejects(confirm());
  pods[0].spec.containers[0].env[1].value = '4';
  controller.metadata.uid = 'foreign';
  await assert.rejects(confirm(), /controller changed/);
});

test('retained values are accepted only from a successfully deployed Helm revision', async () => {
  const manifest = createStudioServerReleaseManifest({
    rootDir: fileURLToPath(new URL('../../../', import.meta.url)),
    source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'b'.repeat(40) },
    images: Object.fromEntries(
      ['api', 'executor', 'web', 'proxy'].map((name) => [
        name,
        { repository: `registry.test/${name}`, digest: 'sha256:' + 'c'.repeat(64) },
      ]),
    ),
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const gate = Object.create(ReusableProviderGate.prototype);
  gate.config = { release: 'rivet-qualification', namespace: 'rivet-staging-persistent' };
  gate.assertProofContext = async () => {};
  const release = {
    name: gate.config.release,
    namespace: gate.config.namespace,
    version: 7,
    info: { status: 'deployed' },
    config: {
      images: manifest.images,
      release: { production: { manifestDigest: getStudioServerReleaseManifestDigest(manifest) } },
    },
  };
  gate.readRetainedHelmRelease = async () => structuredClone(release);
  assert.deepEqual(await gate.verifyRetainedInstallation(manifest), release.config);
  for (const status of ['pending-install', 'pending-upgrade', 'pending-rollback', 'failed']) {
    release.info.status = status;
    await assert.rejects(gate.verifyRetainedInstallation(manifest), /not successfully deployed/);
  }
  release.info.status = 'deployed';
  release.namespace = 'rivet';
  await assert.rejects(gate.verifyRetainedInstallation(manifest));
});

// test-style: fixture-read: Native Helm reads only this test's temporary kubeconfig and local synthetic release Secret.
test('native Helm status exposes deployed values and pending state in one read', async (t) => {
  const release = {
    name: 'rivet-qualification',
    namespace: 'rivet-staging-native',
    version: 3,
    info: { status: 'deployed' },
    config: { execution: { fixture: true } },
  };
  const calls = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/version') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ gitVersion: 'v1.36.6' }));
      return;
    }
    calls.push(request.method);
    assert.equal(url.pathname, `/api/v1/namespaces/${release.namespace}/secrets`);
    assert.match(url.searchParams.get('labelSelector'), /owner=helm/);
    const data = Buffer.from(gzipSync(JSON.stringify(release)).toString('base64')).toString('base64');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'SecretList',
        items: [
          {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: 'sh.helm.release.v1.rivet-qualification.v3',
              namespace: release.namespace,
              labels: { owner: 'helm', name: release.name, status: release.info.status, version: '3' },
            },
            data: { release: data },
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-helm-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kubeconfig = path.join(directory, 'config.json');
  await fs.writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'local', cluster: { server: `http://127.0.0.1:${server.address().port}` } }],
      contexts: [{ name: 'local', context: { cluster: 'local', user: 'local' } }],
      users: [{ name: 'local', user: {} }],
      'current-context': 'local',
    }),
  );
  const helm = resolveHelmBinOrThrow(fileURLToPath(new URL('../../../', import.meta.url)));
  for (const status of ['deployed', 'pending-upgrade']) {
    release.info.status = status;
    const { stdout } = await promisify(execFile)(
      helm,
      [
        'status',
        release.name,
        '--namespace',
        release.namespace,
        '--kubeconfig',
        kubeconfig,
        '--kube-context',
        'local',
        '-o',
        'json',
      ],
      { timeout: 10000, windowsHide: true },
    );
    const observed = JSON.parse(stdout);
    assert.equal(observed.info.status, status);
    assert.equal(observed.version, release.version);
    assert.deepEqual(observed.config, release.config);
  }
  assert.equal(calls.length, 2, 'Status and values must come from the same release read');
});
