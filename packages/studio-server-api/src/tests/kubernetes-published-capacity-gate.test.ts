import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPublishedCapacityGateConfig,
  redactPublishedCapacityGateConfig,
} from '../../../../deploy/studio-server/scripts/lib/kubernetes-published-capacity-gate-config.mjs';
import {
  createCapacityFixtureContents,
  createPublishedCapacityLoadJobConfig,
  renderPublishedCapacityJob,
  evaluateCapacityCertificate,
  createCapacityEvidence,
  isTerminalJob,
} from '../../../../deploy/studio-server/scripts/kubernetes-published-capacity-gate.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

function createEnvironment(configFile: string, valuesFile: string, overrides = {}) {
  return {
    RIVET_K8S_PROVIDER_GATE_CONFIRM: 'deploy-staging',
    RIVET_K8S_PROVIDER_GATE_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_CONFIG_FILE: configFile,
    RIVET_K8S_PROVIDER_GATE_VALUES_FILE: valuesFile,
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_PROVIDER_GATE_REGISTRY_USERNAME: 'provider-gate',
    RIVET_K8S_PROVIDER_GATE_REGISTRY_PASSWORD: 'provider-gate-token',
    RIVET_K8S_CAPACITY_GATE_CONFIRM: 'certify-staging',
    RIVET_K8S_CAPACITY_GATE_MODE: 'certify',
    ...overrides,
  };
}

function providerConfig() {
  return {
    namespace: 'rivet-staging-capacity',
    release: 'rivet-staging',
    baseUrl: 'https://rivet-staging.example.test',
    requestHeaders: { authorization: 'Bearer capacity-secret' },
    workflowProbe: {
      path: '/workflows/provider-gate',
      method: 'POST',
      body: { input: 'provider' },
      contains: 'provider',
    },
    webAppProbe: { path: '/apps/provider-gate', contains: 'Provider gate' },
    capacity: {
      serviceNamePrefix: 'rivet-staging',
      requestTimeoutMs: 15_000,
      controlCanaryEveryRequests: 4,
      controlCanaryTimeoutMs: 3_000,
      sampleIntervalMs: 500,
      jobTimeoutSeconds: 120,
      requireExecutionMetrics: true,
      stages: [
        { name: 'steady', scenario: 'fast', expect: 'success', concurrency: 4, requests: 20 },
        { name: 'overload', scenario: 'long', expect: 'overload', concurrency: 16, requests: 32 },
      ],
      thresholds: {
        maximumP95Ms: { steady: 5_000, overload: 10_000 },
        maximumUnexpectedRate: 0.01,
        maximumControlCanaryFailureRate: 0,
        maximumRecordingDrops: 0,
      },
    },
  };
}

test('published capacity gate is explicit, staging-only, bounded, and redacts request credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-capacity-gate-test-'));
  const configFile = path.join(directory, 'provider-gate.json');
  const valuesFile = path.join(directory, 'values.yaml');
  try {
    await fs.writeFile(configFile, JSON.stringify(providerConfig()));
    await fs.writeFile(valuesFile, 'metrics:\n  enabled: true\n');
    const config = buildPublishedCapacityGateConfig({ rootDir, env: createEnvironment(configFile, valuesFile) });
    assert.equal(config.mode, 'certify');
    assert.equal(config.capacity.stages.length, 2);
    assert.equal(config.capacity.serviceNamePrefix, 'rivet-staging');
    assert.equal(JSON.stringify(redactPublishedCapacityGateConfig(config)).includes('capacity-secret'), false);
    assert.throws(
      () =>
        buildPublishedCapacityGateConfig({
          rootDir,
          env: createEnvironment(configFile, valuesFile, { RIVET_K8S_CAPACITY_GATE_CONFIRM: 'yes' }),
        }),
      /must equal certify-staging/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...providerConfig(),
        capacity: { ...providerConfig().capacity, stages: [providerConfig().capacity.stages[0]] },
      }),
    );
    assert.throws(
      () => buildPublishedCapacityGateConfig({ rootDir, env: createEnvironment(configFile, valuesFile) }),
      /must include an explicit overload stage/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...providerConfig(),
        capacity: { ...providerConfig().capacity, requireExecutionMetrics: false },
      }),
    );
    assert.throws(
      () => buildPublishedCapacityGateConfig({ rootDir, env: createEnvironment(configFile, valuesFile) }),
      /certify mode requires capacity\.requireExecutionMetrics=true/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('capacity fixtures receive unique isolated identities and the requested execution shape', () => {
  const template = [
    'projectId: 230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b',
    'graphId: 59701e85-9052-43e1-a71d-af698ef7c1fe',
    'title: Managed release gate',
    'delay: 300',
  ].join('\n');
  const fixture = createCapacityFixtureContents(template, { title: 'Capacity fixture', delayMs: 75 });
  assert.match(fixture, /title: Capacity fixture/);
  assert.match(fixture, /delay: 75/);
  assert.doesNotMatch(fixture, /230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b/);
  assert.doesNotMatch(fixture, /59701e85-9052-43e1-a71d-af698ef7c1fe/);
});

test('published capacity load Job config uses only the published proxy route and contains no control credentials', () => {
  const jobConfig = createPublishedCapacityLoadJobConfig({
    serviceNamePrefix: 'rivet-staging',
    namespace: 'rivet-staging-capacity',
    jobName: 'rivet-capacity-test',
    capacity: {
      requestTimeoutMs: 10_000,
      controlCanaryEveryRequests: 5,
      controlCanaryTimeoutMs: 1_000,
      stages: [{ name: 'steady', scenario: 'fast', expect: 'success', concurrency: 2, requests: 3 }],
    },
  });
  assert.equal(jobConfig.proxyBaseUrl, 'http://rivet-staging-proxy.rivet-staging-capacity.svc.cluster.local');
  assert.equal(jobConfig.controlBaseUrl, 'http://rivet-staging-api.rivet-staging-capacity.svc.cluster.local');
  assert.deepEqual(jobConfig.scenarios, [
    { name: 'fast', endpoint: 'rivet-capacity-test-fast', body: { input: 'capacity-fast' } },
    { name: 'long', endpoint: 'rivet-capacity-test-long', body: { input: 'capacity-long' } },
  ]);
  assert.equal(JSON.stringify(jobConfig).includes('authorization'), false);
});

test('published capacity Job is explicitly unprivileged and cannot receive a Kubernetes API credential', () => {
  const manifest = renderPublishedCapacityJob({
    namespace: 'rivet-staging-capacity',
    name: 'rivet-capacity-test',
    image: 'example.test/rivet/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    registrySecretName: 'rivet-registry',
    configMapName: 'rivet-capacity-test-config',
    timeoutSeconds: 120,
  });
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /runAsNonRoot: true/);
  assert.match(manifest, /type: RuntimeDefault/);
  assert.match(manifest, /allowPrivilegeEscalation: false/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /drop:\n\s+- ALL/);
  assert.doesNotMatch(manifest, /serviceAccountName:/);
  assert.doesNotMatch(manifest, /env:/);
});

test('capacity gate ignores nonterminal Job conditions and retains partial failure evidence without error text', () => {
  assert.equal(isTerminalJob({ status: { conditions: [{ type: 'Complete', status: 'False' }] } }), false);
  assert.equal(isTerminalJob({ status: { conditions: [{ type: 'Failed', status: 'True' }] } }), true);

  const evidence = createCapacityEvidence({
    mode: 'certify',
    phase: 'wait-for-job',
    completed: false,
    snapshots: [{ baseline: true, podCount: 1 }],
    certificate: [],
    failure: new Error('Bearer should never be serialized'),
  });
  assert.deepEqual(evidence, {
    version: 1,
    mode: 'certify',
    status: 'failed',
    phase: 'wait-for-job',
    report: null,
    snapshots: [{ baseline: true, podCount: 1 }],
    certificate: { evaluated: false, passed: false, failures: [] },
    failure: { phase: 'wait-for-job', kind: 'Error' },
    cleanup: { attempted: true, succeeded: true, failureKind: null },
  });
  assert.equal(JSON.stringify(evidence).includes('Bearer should never be serialized'), false);
  const cleanupEvidence = createCapacityEvidence({
    mode: 'certify',
    phase: 'cleanup',
    completed: true,
    snapshots: [],
    certificate: [],
    cleanupFailure: new Error('cleanup error'),
  });
  assert.equal(cleanupEvidence.status, 'failed');
  assert.deepEqual(cleanupEvidence.cleanup, { attempted: true, succeeded: false, failureKind: 'Error' });
  assert.equal(JSON.stringify(cleanupEvidence).includes('cleanup error'), false);
});

test('capacity certification fails closed on malformed evidence and requires overload admission rejection', () => {
  const config = {
    capacity: {
      stages: [
        { name: 'steady', scenario: 'fast', expect: 'success', requests: 2 },
        { name: 'overload', scenario: 'long', expect: 'overload', requests: 3 },
      ],
      controlCanaryEveryRequests: 2,
      requireExecutionMetrics: true,
      thresholds: {
        maximumP95Ms: { steady: 100, overload: 100 },
        maximumUnexpectedRate: 0,
        maximumControlCanaryFailureRate: 0,
        maximumRecordingDrops: 0,
      },
    },
  };
  const report = {
    version: 1,
    stages: [
      {
        name: 'steady',
        scenario: 'fast',
        requested: 2,
        completed: 2,
        requestTimings: { count: 2, p95Ms: 10 },
        outcomes: {
          succeeded: 2,
          capacityRejected: 0,
          serverErrors: 0,
          clientErrors: 0,
          networkErrors: 0,
          timeouts: 0,
          unexpected: 0,
        },
        controlCanaries: { attempted: 1, succeeded: 1, failures: 0, timings: { count: 1 } },
      },
      {
        name: 'overload',
        scenario: 'long',
        requested: 3,
        completed: 3,
        requestTimings: { count: 3, p95Ms: 10 },
        outcomes: {
          succeeded: 0,
          capacityRejected: 3,
          serverErrors: 0,
          clientErrors: 0,
          networkErrors: 0,
          timeouts: 0,
          unexpected: 0,
        },
        controlCanaries: { attempted: 1, succeeded: 1, failures: 0, timings: { count: 1 } },
      },
    ],
  };
  const snapshots = [
    {
      baseline: true,
      podCount: 0,
      eventsAvailable: true,
      restartCount: 0,
      restartCountsByPod: {},
      oomKilledPods: [],
      evictedPods: [],
    },
    {
      baseline: false,
      podCount: 1,
      metricsAvailable: true,
      eventsAvailable: true,
      restartCount: 0,
      restartCountsByPod: { 'rivet-execution-replacement': 0 },
      oomKilledPods: [],
      evictedPods: [],
      recordingDropsObserved: 0,
    },
  ];

  assert.deepEqual(evaluateCapacityCertificate(report, snapshots, config), []);
  assert.match(
    evaluateCapacityCertificate({ ...report, stages: [] }, snapshots, config).join('\n'),
    /does not contain exactly the configured capacity stages/,
  );

  const malformedCanaryEvidence = structuredClone(report);
  malformedCanaryEvidence.stages[0].controlCanaries = {
    attempted: 1,
    succeeded: 2,
    failures: -1,
    timings: { count: 1 },
  };
  assert.match(
    evaluateCapacityCertificate(malformedCanaryEvidence, snapshots, config).join('\n'),
    /incomplete control-canary evidence/,
  );

  const malformedTimingEvidence = structuredClone(report);
  malformedTimingEvidence.stages[0].requestTimings.p95Ms = -1;
  assert.match(
    evaluateCapacityCertificate(malformedTimingEvidence, snapshots, config).join('\n'),
    /missing complete request timing evidence/,
  );

  const missingAdmissionRejection = structuredClone(report);
  missingAdmissionRejection.stages[1].outcomes.succeeded = 3;
  missingAdmissionRejection.stages[1].outcomes.capacityRejected = 0;
  assert.match(
    evaluateCapacityCertificate(missingAdmissionRejection, snapshots, config).join('\n'),
    /expected visible admission rejection/,
  );

  const restartedReplacement = structuredClone(snapshots);
  restartedReplacement[1].restartCountsByPod = { 'rivet-execution-replacement': 1 };
  assert.match(
    evaluateCapacityCertificate(report, restartedReplacement, config).join('\n'),
    /execution pod restart observed/,
  );

  const droppedOnReplacement = structuredClone(snapshots);
  droppedOnReplacement[1].recordingDropsObserved = 1;
  assert.match(
    evaluateCapacityCertificate(report, droppedOnReplacement, config).join('\n'),
    /recording drops increased/,
  );
});
