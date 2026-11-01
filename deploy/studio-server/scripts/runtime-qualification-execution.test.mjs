import assert from 'node:assert/strict';
// test-style: fixture-read: Execute the local driver fixture and inspect only generated receipts/call logs, never production implementation text.
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  assertStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';
import {
  qualificationOperation,
  executeRuntimeQualification,
  qualificationHash,
  assertQualificationPreflight,
  assertProviderAutoscalingReport,
  assertActionsQualificationWindow,
} from './lib/runtime-qualification-execution.mjs';
import {
  verifyQualificationDriver,
  qualificationDriverEnvironment,
  providerPhaseProcess,
} from './lib/runtime-qualification-driver.mjs';
import {
  inspectQualificationInstallation,
  assertQualificationInstallationMatches,
} from './lib/runtime-qualification-installation.mjs';
import { prepareRuntimeQualification } from './lib/runtime-qualification-publication.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { HA_REQUIRED_CHECKS } from './lib/ha-release-evidence.mjs';
import { overlapProfileDigest } from './lib/qualification-overlap-profile.mjs';
import { prepareQualificationReadinessPolicy } from './lib/runtime-qualification-readiness.mjs';
import { readDeploymentPolicy } from './lib/deployment-workflow.mjs';
import { deployQualifiedRelease } from './lib/deploy-qualified-release.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = 'a'.repeat(40),
  repository = 'example/rivet';
const evidence = { workflow: 'Build Images', runId: '123', runAttempt: 1 };

test('fresh read-only checkout receives exact reviewed private policy without executing adapters', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-readiness-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'private');
  const checkout = path.join(directory, 'checkout');
  const packet = path.join(checkout, 'artifacts');
  await fs.mkdir(bundle);
  await fs.mkdir(packet, { recursive: true });
  const source = "throw Error('Adapter must not execute during materialization');\n";
  await fs.writeFile(path.join(bundle, 'adapter.mjs'), source);
  const identity = { context: 'production-context', namespace: 'rivet', release: 'rivet' };
  const policy = {
    formatVersion: 1,
    ...identity,
    namespaceUid: 'namespace-uid',
    ...Object.fromEntries(
      ['backup', 'acceptance'].map((name) => [
        name,
        {
          script: 'adapter.mjs',
          sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
        },
      ]),
    ),
  };
  const policyFile = path.join(bundle, 'policy.json');
  await fs.writeFile(policyFile, JSON.stringify(policy));
  const prepare = () => prepareQualificationReadinessPolicy({ policyFile, root: checkout, packet, identity });
  const file = await prepare();
  const copied = await readDeploymentPolicy(file, checkout, identity);
  assert.equal(await fs.readFile(copied.scripts.backup, 'utf8'), source);
  assert.equal(await fs.readFile(copied.scripts.acceptance, 'utf8'), source);
  await assert.rejects(prepare(), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(bundle, 'adapter.mjs'), 'utf8'), source);
});

test('private readiness preparation rejects changed bytes, escaped scripts and installation confusion', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-readiness-policy-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'private'),
    checkout = path.join(directory, 'checkout');
  await fs.mkdir(bundle);
  await fs.mkdir(checkout);
  await fs.writeFile(path.join(bundle, 'adapter.mjs'), 'changed');
  const entry = { script: 'adapter.mjs', sha256: `sha256:${'a'.repeat(64)}` };
  const identity = { context: 'production-context', namespace: 'rivet', release: 'rivet' };
  const policy = { formatVersion: 1, ...identity, namespaceUid: 'uid', backup: entry, acceptance: entry };
  const policyFile = path.join(bundle, 'policy.json');
  const prepare = () => prepareQualificationReadinessPolicy({ policyFile, root: checkout, packet: checkout, identity });
  await fs.writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(prepare(), /adapter changed/i);
  policy.backup = { ...entry, script: '../outside.mjs' };
  await fs.writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(prepare(), /inside the repository/);
  policy.release = 'other';
  await fs.writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(prepare(), /installation identity/);
  const verifiedEntry = { ...entry, sha256: `sha256:${createHash('sha256').update('changed').digest('hex')}` };
  Object.assign(policy, { release: identity.release, backup: verifiedEntry, acceptance: verifiedEntry });
  await fs.writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(
    prepareQualificationReadinessPolicy({ policyFile, root: checkout, packet: bundle, identity }),
    /packet escaped checkout/,
  );
  const link = path.join(directory, 'redirect');
  await fs.symlink(bundle, link, 'junction');
  await assert.rejects(
    prepareQualificationReadinessPolicy({
      policyFile: path.join(link, 'policy.json'),
      root: checkout,
      packet: checkout,
      identity,
    }),
    /directory cannot be redirected/,
  );
  assert.deepEqual(await fs.readdir(checkout), []);
});
function fixture(overlap = false) {
  const imageSet = (prefix) =>
    Object.fromEntries(
      ['api', 'executor', 'proxy', 'web'].map((k, i) => [
        k,
        { repository: `registry.test/${prefix}/${k}`, digest: `sha256:${String(i + 1).repeat(64)}` },
      ]),
    );
  const create = (source, images, predecessorRelease) =>
    createStudioServerReleaseManifest({
      rootDir: root,
      source: { repository, ref: 'refs/heads/main', sha: source },
      images,
      candidateEvidence: evidence,
      predecessorRelease,
    });
  const previous = promoteStudioServerReleaseManifest(create('b'.repeat(40), imageSet('old')), {
    promotionEvidence: evidence,
  });
  const candidate = create(sha, imageSet('new'), previous);
  const ha = {
    protocol: 3,
    mode: 'bootstrap',
    candidateSourceSha: sha,
    candidateImages: candidate.images,
    chartDigest: candidate.chart.contentDigest,
    failedRequests: 0,
    requestSamples: 100,
    checks: [...HA_REQUIRED_CHECKS],
    browserContract: { protocol: 2, baseline: { sourceSha: sha, image: candidate.images.web } },
  };
  const promoted = promoteStudioServerReleaseManifest(
    { ...candidate, evidence: { ...candidate.evidence, ha } },
    { promotionEvidence: evidence },
  );
  const t = Date.now() - 120_000,
    iso = (n) => new Date(t + n).toISOString();
  const policy = {
    minReplicas: 2,
    maxReplicas: 4,
    targetSlotsPercent: 60,
    targetCpuPercent: 75,
    stabilizationSeconds: 300,
    cooldownSeconds: 60,
    withdrawalSeconds: 60,
    pollSeconds: 15,
    metricsMaxAgeSeconds: 90,
  };
  const installed = {
    scope: 'production-read-only',
    observedAt: iso(0),
    manifestDigest: getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
    images: previous.images,
    schemaVersion: previous.database.managedWorkflowSchema.version,
    namespaceUid: 'production-ns',
    clusterUid: 'production-cluster',
    valuesDigest: 'sha256:' + 'c'.repeat(64),
    settingsDigest: 'sha256:' + 'd'.repeat(64),
    controlPlaneMode: 'singleton',
    ...(overlap ? { qualificationValues: { postgres: { poolMaxPerApiPod: 10 } } } : {}),
    edgeProfile: 'compact',
    policyDigest: autoscalerPolicyDigest(policy),
    policy,
    baseline: { backend: 1, web: 1, execution: 2, proxy: 2, autoscaler: 1 },
  };
  const input = {
    candidate,
    previous,
    installed,
    policy,
    operationId: 'rivet-q-456-1',
    now: t,
    approval: {
      ...(overlap
        ? {
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
          }
        : {}),
      enabled: true,
      projectId: 'isolated-project',
      projectNumber: '123456789',
      maxUsd: 50,
      maxSeconds: 7200,
      driverBundleSha256: 'e'.repeat(64),
      staging: {
        mode: 'reusable-cluster',
        clusterUid: 'isolated-cluster',
        clusterServer: 'https://isolated.gke.goog',
        gatewayUid: 'shared-staging-gateway',
      },
    },
  };
  const operation = qualificationOperation(input);
  const bound = {
    protocol: 1,
    operationId: operation.operationId,
    inputHash: operation.inputHash,
    projectId: operation.projectId,
    projectNumber: operation.projectNumber,
  };
  const owned = [
    {
      id: 'exact-new-cloud-id',
      kind: 'namespace',
      operationId: operation.operationId,
      projectNumber: operation.projectNumber,
      newlyCreated: true,
      billable: true,
    },
  ];
  const window = { ...bound, startedAt: iso(1000), finishedAt: iso(2000), outcome: 'passed' };
  const autoscale = { policyDigest: operation.policyDigest, sampleAt: t + 1500 };
  const facts = {
    armExpiry: {
      ...bound,
      stagingClusterUid: 'isolated-cluster',
      expiresAt: operation.expiresAt,
      maxUsd: operation.maxUsd,
      billableActivation: false,
      identity: 'exact-independent-watchdog',
      armed: true,
      independent: true,
    },
    prepare: {
      ...bound,
      stagingClusterUid: 'isolated-cluster',
      inventoryComplete: true,
      expiryIdentity: 'exact-independent-watchdog',
      inventory: owned,
    },
    upgrade: {
      ...window,
      qualification: 'isolated-provider',
      purpose: 'ordinary-upgrade',
      predecessorManifestDigest: operation.predecessorManifestDigest,
      candidateSourceSha: sha,
      candidateImages: candidate.images,
      chartDigest: candidate.chart.contentDigest,
      policyDigest: operation.policyDigest,
      initialApplicationPods: 7,
      finalApplicationPods: 7,
      workflow: { samples: 200, failures: [] },
      web: { samples: 100, failures: [] },
      readiness: { samples: 100, minimumReady: { execution: 2, proxy: 2 } },
      storageIdentityPreserved: true,
      outcomes: {
        acceptedWork: [0, 1].map((i) => ({
          uid: `pod-${i}`,
          recordingId: `recording-${i}`,
          workflowId: 'owned-background-workflow',
          recordingLookup: {
            workflowId: 'owned-background-workflow',
            totalRuns: i + 1,
            hasMore: false,
            matches: [{ id: `recording-${i}`, status: 'succeeded' }],
          },
        })),
        initialAutoscaler: autoscale,
        autoscaler: autoscale,
        finalAutoscaler: autoscale,
        maintenanceArchivePreserved: true,
        independence: { coldProxyReplacement: true, browserOAuthAction: true, publishedScheduleRecording: true },
      },
    },
    autoscaling: {
      ...window,
      startedAt: iso(2000),
      finishedAt: iso(3000),
      workflow: { samples: 800, failures: [] },
      web: { samples: 200, failures: [] },
      source: sha,
      policy,
      policyDigest: operation.policyDigest,
      finalApplicationPods: 7,
      cooperative: {
        active: { from: 2, to: 3, token: 'same', ownerUid: 'owner' },
        paused: {
          from: 3,
          to: 4,
          token: 'same',
          ownerUid: 'owner',
          scaleDownSuppressedMs: 360000,
          acceptedWorkRecorded: true,
        },
        resumedSameToken: true,
        finalExecutionReplicas: 2,
        developerReplicasUnchanged: true,
      },
      capacity: {
        peak: { replicas: 4 },
        actualProviderHosts: [0, 1, 2, 3].map((i) => ({
          node: `node-${i}`,
          podUid: `uid-${i}`,
          providerId: `gce://isolated-project/zone/node-${i}`,
        })),
        automaticallyReturnedToTwo: true,
      },
      cpu: { separateCpuGrowth: true, developerReplicasUnchanged: true, from: 2, to: 3 },
      drain: {
        higherUidPreserved: 'uid',
        longCorrelation: 'correlation',
        retirementOperationId: 'retire',
        incarnation: 'process',
        busyEvictionRejected: true,
        sameOperationRecovered: true,
        concurrentDeploymentRejected: true,
        acceptedWorkRecorded: true,
      },
      metrics: ['metrics-missing', 'metrics-stale'].map((mode) => ({
        mode,
        observations: 2,
        capacityUnchangedForMs: 300000,
        lowDemandWindowReset: true,
      })),
      lostAck: { sameTransitionDispatches: 1, acceptedScale: { state: 'accepted-response-suppressed' } },
      proxyHpa: { manuallyChangedReplicas: false, developerReplicasUnchanged: true, readyUids: ['a', 'b', 'c', 'd'] },
      accepted: [{ count: 1, responses: [{ status: 200, correlationId: 'r' }], recordings: { r: 'recording' } }],
    },
    settle: { ...bound, writersStopped: true, acceptedWorkSettled: true, inventoryComplete: true, inventory: owned },
    cleanup: bound,
    verifyCleanup: {
      ...bound,
      inventoryComplete: true,
      inventoryHash: qualificationHash(owned),
      resources: [{ id: owned[0].id, state: 'absent' }],
      uncertainWrites: 0,
    },
  };
  if (overlap) {
    facts.upgrade.outcomes.overlapPreparation = { sourceMode: 'singleton', sourcePool: 10, preparationComplete: true };
    facts.upgrade.outcomes.developerOverlap = {
      profileDigest: overlapProfileDigest(operation.developerOverlapProfile),
      adoptionOrAlreadyEnabled: true,
      interruptedSameOperationRecovered: true,
      sameNodeSamples: 2,
      readinessSamples: 10,
      minimumReady: 1,
      maximumHousekeepingOwners: 1,
      handoverCount: 2,
      claimIdentityPreserved: true,
      maintenanceClaim: {
        before: { name: 'restore', uid: 'claim', volume: 'pv', volumeUid: 'pv-uid', size: '8Gi' },
        after: { name: 'restore', uid: 'claim', volume: 'pv', volumeUid: 'pv-uid', size: '8Gi' },
      },
      finalBackendCount: 1,
      finalOwnerCount: 1,
      editorRuns: [0, 1].map((i) => ({
        uid: `editor-${i}`,
        receipt: {
          phase: 'passed',
          editorResumed: true,
          latestMesh: true,
          starts: 1,
          completions: 1,
          bundleProjectIds: ['root', 'child'],
          bundleSharedExecution: true,
        },
      })),
      browser: {
        passed: true,
        unsavedEdit: true,
        savedByCandidate: true,
        newRun: true,
        outputs: true,
        recordingOpened: true,
        reloads: 0,
        iframeReloads: 0,
      },
      developerTraffic: { samples: 100, failures: [] },
    };
  }
  return { input, operation, facts, promoted, now: () => t + 3000 };
}

test('temporary foundation consumes the original allowance instead of restarting it for fixture tests', () => {
  const { input } = fixture();
  const parent = {
    inputHash: '1'.repeat(64),
    startedAt: new Date(input.now - 3600000).toISOString(),
    expiresAt: new Date(input.now + 3600000).toISOString(),
  };
  const operation = qualificationOperation({ ...input, approval: { ...input.approval, temporaryEnvironment: parent } });
  assert.equal(operation.startedAt, parent.startedAt);
  assert.equal(operation.expiresAt, parent.expiresAt);
  assert.throws(() =>
    qualificationOperation({
      ...input,
      approval: {
        ...input.approval,
        temporaryEnvironment: { ...parent, expiresAt: new Date(input.now + 7200000).toISOString() },
      },
    }),
  );
});

test('initial overlap readiness is an adoption preflight, never permission for a direct image upgrade', () => {
  const { operation } = fixture(true);
  const qualified = 'sha256:' + 'e'.repeat(64),
    values = 'sha256:' + 'f'.repeat(64);
  const receipt = {
    formatVersion: 1,
    passed: true,
    scope: 'installed-state-and-local-readiness',
    workloadMutations: false,
    applicationJourneysRun: false,
    installedManifestDigest: operation.predecessorManifestDigest,
    candidateManifestDigest: operation.predecessorManifestDigest,
    authorizationManifestDigest: qualified,
    adoptionStage: 'sizing',
    namespaceUid: operation.installed.namespaceUid,
    valuesDigest: values,
    observedAt: new Date().toISOString(),
  };
  const options = { adoptionStage: 'sizing', valuesDigest: values };
  const result = assertQualificationPreflight(receipt, operation, qualified, options);
  assert.equal(result.status, 'adoption-preflight-passed');
  assert.equal(result.pendingSteps.length, 3);
  assert.equal(result.deploymentAuthorized, false);
  for (const patch of [
    { authorizationManifestDigest: values },
    { candidateManifestDigest: qualified },
    { adoptionStage: 'ownership' },
    { valuesDigest: qualified },
  ])
    assert.throws(() => assertQualificationPreflight({ ...receipt, ...patch }, operation, qualified, options));
  assert.throws(() => assertQualificationPreflight(receipt, operation, qualified));
});

test('overlap facts compile a distinct exact-profile certificate, and missing continuity fails after cleanup', async () => {
  const f = fixture(true),
    d = driver(f);
  const result = await executeRuntimeQualification(f.operation, d.api, async () => {}, { now: f.now });
  assert.equal(result.control.evidence.protocol, 3);
  assert.equal(result.control.evidence.controlPlaneMode, 'singleton-overlap');
  assert.equal(
    result.control.evidence.developerOverlap.profileDigest,
    overlapProfileDigest(f.operation.developerOverlapProfile),
  );
  assert.doesNotThrow(() =>
    prepareRuntimeQualification({
      candidate: f.operation.candidate,
      promoted: f.promoted,
      repository,
      sourceSha: sha,
      build: { runId: '123', runAttempt: 1 },
      ...result,
    }),
  );
  for (const corrupt of [
    (x) => {
      x.control.evidence.protocol = 2;
    },
    (x) => {
      x.control.evidence.developerOverlap.profile.poolMaxPerApiPod = 10;
    },
    (x) => {
      x.control.evidence.developerOverlap.profileDigest = 'f'.repeat(64);
    },
    (x) => {
      x.control.evidence.controlPlaneMode = 'singleton';
    },
  ]) {
    const changed = structuredClone(result);
    corrupt(changed);
    assert.throws(() =>
      prepareRuntimeQualification({
        candidate: f.operation.candidate,
        promoted: f.promoted,
        repository,
        sourceSha: sha,
        build: { runId: '123', runAttempt: 1 },
        ...changed,
      }),
    );
  }
  for (const corrupt of [
    (x) => {
      delete x.upgrade.outcomes.developerOverlap;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.maximumHousekeepingOwners = 2;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.interruptedSameOperationRecovered = false;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.editorRuns[1].receipt.completions = 2;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.editorRuns[1].receipt.bundleSharedExecution = false;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.browser.iframeReloads = 1;
    },
    (x) => {
      x.upgrade.outcomes.developerOverlap.developerTraffic.failures.push('request failed');
    },
  ]) {
    const broken = fixture(true);
    corrupt(broken.facts);
    const failed = driver(broken);
    await assert.rejects(
      executeRuntimeQualification(broken.operation, failed.api, async () => {}, { now: broken.now }),
    );
    assert.deepEqual(failed.calls.slice(-3), ['settle', 'cleanup', 'verifyCleanup']);
  }
});
function driver(f, fail) {
  const calls = [];
  return {
    calls,
    api: Object.fromEntries(
      Object.keys(f.facts).map((phase) => [
        phase,
        async () => {
          calls.push(phase);
          if (phase === fail) throw Error('PRIVATE-TEST-CREDENTIAL');
          return structuredClone(f.facts[phase]);
        },
      ]),
    ),
  };
}

test('operation freezes exact inputs and cannot qualify another installation, budget, bundle or expired snapshot', () => {
  const f = fixture();
  assert.ok(Object.isFrozen(f.operation.candidate.images));
  f.input.policy.maxReplicas = 5;
  assert.equal(f.operation.policy.maxReplicas, 4);
  for (const change of [
    (x) => {
      x.approval.enabled = false;
    },
    (x) => {
      x.approval.projectId = 'wartime-storyteller';
    },
    (x) => {
      x.installed.manifestDigest = 'sha256:' + '1'.repeat(64);
    },
    (x) => {
      x.installed.observedAt = '2020-01-01T00:00:00Z';
    },
    (x) => {
      x.approval.maxUsd = NaN;
    },
    (x) => {
      x.approval.driverBundleSha256 = '';
    },
    (x) => {
      x.approval.staging.clusterUid = 'production-cluster';
    },
  ]) {
    const input = structuredClone(fixture().input);
    change(input);
    assert.throws(() => qualificationOperation(input));
  }
});

test('actual phase sequencing compiles existing publication evidence only after exact cleanup verification', async () => {
  const f = fixture(),
    d = driver(f),
    states = [];
  const result = await executeRuntimeQualification(f.operation, d.api, async (s) => states.push(s), { now: f.now });
  assert.deepEqual(d.calls, ['armExpiry', 'prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup']);
  assert.deepEqual(
    states.map((s) => s.phase),
    [...d.calls, 'terminal'],
  );
  assert.equal(states.at(-1).cleanupVerified, true);
  const packet = prepareRuntimeQualification({
    candidate: f.operation.candidate,
    promoted: f.promoted,
    control: result.control,
    autoscaling: result.autoscaling,
    repository,
    sourceSha: sha,
    build: { runId: '123', runAttempt: 1 },
  });
  assert.equal(packet.candidate.evidence.runtimeControl.protocol, 2);
  assert.equal(packet.candidate.evidence.runtimeAutoscaling.protocol, 2);
  assert.equal(packet.candidate.evidence.runtimeAutoscaling.requestSamples, 1000);
  assert.equal(packet.candidate.evidence.runtimeControl.requestSamples, 300);
  assert.ok(!JSON.stringify(result).includes('exact-new-cloud-id'));
});

test('failures, unknown writes, expiry and dishonest/missing facts cannot become qualification or trigger replay', async () => {
  const mutations = [
    (f) => {
      f.facts.autoscaling.web.failures.push({ status: 502 });
    },
    (f) => {
      delete f.facts.autoscaling.workflow;
    },
    (f) => {
      f.facts.autoscaling.startedAt = f.facts.upgrade.startedAt;
    },
    (f) => {
      f.facts.upgrade.workflow.failures.push({ status: 502 });
    },
    (f) => {
      f.facts.upgrade.outcomes.acceptedWork[0].recordingLookup.totalRuns = 3;
    },
    (f) => {
      f.facts.upgrade.qualification = 'local-functional-only';
    },
    (f) => {
      f.facts.upgrade.inputHash = 'wrong';
    },
    (f) => {
      f.facts.upgrade.readiness.minimumReady.proxy = 1;
    },
    (f) => {
      f.facts.autoscaling.cooperative.paused.acceptedWorkRecorded = false;
    },
    (f) => {
      f.facts.autoscaling.metrics[0].capacityUnchangedForMs = 1;
    },
    (f) => {
      f.facts.verifyCleanup.resources[0].state = 'still-present';
    },
    (f) => {
      f.facts.verifyCleanup.uncertainWrites = 1;
    },
    (f) => {
      f.facts.settle.inventory = structuredClone(f.facts.settle.inventory);
      f.facts.settle.inventory[0].billable = false;
      f.facts.verifyCleanup.resources[0].state = 'non-billable-hold';
      f.facts.verifyCleanup.inventoryHash = qualificationHash(f.facts.settle.inventory);
    },
    (f) => {
      f.facts.armExpiry.independent = false;
    },
    (f) => {
      f.facts.prepare.inventory[0].kind = 'Cluster';
    },
  ];
  for (const mutation of mutations) {
    const f = fixture();
    mutation(f);
    const d = driver(f),
      states = [];
    await assert.rejects(
      executeRuntimeQualification(f.operation, d.api, async (s) => states.push(s), { now: f.now }),
      /No release was qualified/,
    );
    assert.equal(states.at(-1).outcome, 'failed');
    for (const phase of d.calls) assert.equal(d.calls.filter((p) => p === phase).length, 1);
  }
  for (const failedPhase of ['prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup']) {
    const f = fixture(),
      d = driver(f, failedPhase);
    await assert.rejects(executeRuntimeQualification(f.operation, d.api, async () => {}, { now: f.now }));
    if (failedPhase === 'settle') assert.ok(!d.calls.includes('cleanup'));
    assert.equal(d.calls.filter((p) => p === failedPhase).length, 1);
  }
  const f = fixture(),
    d = driver(f);
  await assert.rejects(
    executeRuntimeQualification(f.operation, d.api, async () => {}, { now: () => Date.parse(f.operation.expiresAt) }),
  );
  assert.deepEqual(d.calls, ['settle', 'cleanup', 'verifyCleanup']);
});

test('late cancellation, expiry and driver-owned mutations cannot revise accepted evidence', async () => {
  for (const mode of ['cancel', 'expire']) {
    const f = fixture(),
      d = driver(f),
      stop = new AbortController();
    let now = f.now();
    const original = d.api.autoscaling;
    d.api.autoscaling = async (operation) => {
      const result = await original(operation);
      if (mode === 'cancel') stop.abort(Error('cancelled'));
      else now = Date.parse(operation.expiresAt);
      return result;
    };
    const states = [];
    await assert.rejects(
      executeRuntimeQualification(f.operation, d.api, async (state) => states.push(state), {
        now: () => now,
        signal: stop.signal,
      }),
    );
    assert.equal(states.at(-1).outcome, 'failed');
    assert.deepEqual(d.calls.slice(-3), ['settle', 'cleanup', 'verifyCleanup']);
  }
  const f = fixture(),
    d = driver(f);
  const returned = structuredClone(f.facts.upgrade);
  d.api.upgrade = async () => returned;
  const original = d.api.autoscaling;
  d.api.autoscaling = async (operation) => {
    returned.workflow.samples = 999999;
    returned.outcomes.acceptedWork.length = 0;
    return original(operation);
  };
  const result = await executeRuntimeQualification(f.operation, d.api, async () => {}, { now: f.now });
  assert.equal(result.control.evidence.requestSamples, 300);
});

test('driver credential boundary is case-insensitive and process startup failure waits for close', async () => {
  const child = qualificationDriverEnvironment({
    Path: 'tools',
    Github_Token: 'secret',
    Gh_Enterprise_Token: 'secret',
    Actions_Runtime_Token: 'secret',
    Rivet_Qualification_Production_Context: 'production',
    Rivet_Production_Deploy_Kubeconfig: 'production-deployment-credential',
    RIVET_PRODUCTION_PRIVATE_STORE: 'private-production-receipts',
    Kubeconfig: 'production-credentials',
    RIVET_QUALIFICATION_STAGING_KUBECONFIG: 'staging-credentials',
  });
  assert.deepEqual(child, {
    Path: 'tools',
    RIVET_QUALIFICATION_STAGING_KUBECONFIG: 'staging-credentials',
    KUBECONFIG: 'staging-credentials',
  });
  assert.throws(() => qualificationDriverEnvironment({ KUBECONFIG: 'production-credentials' }), /explicit staging/);
  await assert.rejects(
    providerPhaseProcess(
      'unused.mjs',
      'prepare',
      {},
      { cwd: path.join(os.tmpdir(), `absent-rivet-${process.pid}-${Date.now()}`) },
    ),
    /process failed/,
  );
});

test('installation observation reads exact context and never returns raw credentials; preflight freshness is separate from qualification', async () => {
  const f = fixture();
  const values = {
    ha: { enabled: true, controlPlane: { mode: 'singleton' } },
    availability: { gkeGatewayProfile: 'compact' },
    replicaCount: { backend: 1, web: 1, execution: 3, proxy: 3 },
    autoscaling: {
      execution: { enabled: false, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 75 },
      executionController: { enabled: true, ...f.operation.policy },
      proxy: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 75 },
    },
    release: {
      production: {
        manifestDigest: f.operation.predecessorManifestDigest,
        database: { managedWorkflowSchemaVersion: f.operation.installed.schemaVersion },
      },
    },
    images: f.operation.previous.images,
    secret: 'PRIVATE-TEST-CREDENTIAL',
  };
  const calls = [];
  const observe = (run, options = {}) =>
    inspectQualificationInstallation({
      context: 'read-only',
      namespace: 'prod',
      release: 'rivet',
      expectedNamespaceUid: 'production-ns',
      valuesText: 'operator-values',
      ...options,
      run,
    });
  const snapshot = await observe(async (bin, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify(
        bin === 'kubectl'
          ? { metadata: { uid: args.includes('kube-system') ? 'production-cluster' : 'production-ns' } }
          : values,
      ),
    };
  });
  assert.ok(calls.every((args) => args.includes('read-only') && args.includes('get')));
  assert.ok(!JSON.stringify(snapshot).includes(values.secret));
  const digestOnly = await observe(
    async (bin, args) => ({
      stdout: JSON.stringify(
        bin === 'kubectl'
          ? { metadata: { uid: args.includes('kube-system') ? 'production-cluster' : 'production-ns' } }
          : values,
      ),
    }),
    { valuesText: undefined, valuesDigest: snapshot.valuesDigest },
  );
  assert.equal(digestOnly.valuesDigest, snapshot.valuesDigest);
  await assert.rejects(
    observe(
      () => {
        throw Error('Must reject before cluster read');
      },
      { valuesText: undefined, valuesDigest: 'invalid' },
    ),
    { code: 'ERR_ASSERTION' },
  );
  assertQualificationInstallationMatches(snapshot, snapshot);
  for (const key of ['manifestDigest', 'namespaceUid', 'clusterUid', 'settingsDigest', 'valuesDigest'])
    assert.throws(() => assertQualificationInstallationMatches({ ...snapshot, [key]: 'changed' }, snapshot));
  for (const changed of ['prod', 'kube-system']) {
    const reads = new Map();
    await assert.rejects(
      observe(async (bin, args) => {
        if (bin !== 'kubectl') return { stdout: JSON.stringify(values) };
        const name = args[args.indexOf('namespace') + 1];
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return {
          stdout: JSON.stringify({
            metadata: {
              uid:
                name === changed && reads.get(name) > 1
                  ? 'replacement'
                  : name === 'kube-system'
                    ? 'production-cluster'
                    : 'production-ns',
            },
          }),
        };
      }),
      /namespace changed/,
    );
  }
  const receipt = {
    formatVersion: 1,
    passed: true,
    scope: 'installed-state-and-local-readiness',
    workloadMutations: false,
    applicationJourneysRun: false,
    observedAt: new Date().toISOString(),
    installedManifestDigest: f.operation.predecessorManifestDigest,
    candidateManifestDigest: 'sha256:' + 'f'.repeat(64),
    namespaceUid: 'production-ns',
    valuesDigest: f.operation.installed.valuesDigest,
  };
  assert.equal(
    assertQualificationPreflight(receipt, f.operation, receipt.candidateManifestDigest).deploymentAuthorized,
    false,
  );
  for (const patch of [
    { workloadMutations: true },
    { installedManifestDigest: 'changed' },
    { observedAt: '2020-01-01T00:00:00Z' },
  ])
    assert.throws(() =>
      assertQualificationPreflight({ ...receipt, ...patch }, f.operation, receipt.candidateManifestDigest),
    );
});

test('hosted qualification rejects invalid windows before private setup and accepts the four-hour CLI boundary', async (t) => {
  for (const seconds of [1, 7200, 14400]) assert.equal(assertActionsQualificationWindow(seconds), seconds);
  for (const seconds of [NaN, Infinity, 0, -1, 1.5, 14401])
    assert.throws(() => assertActionsQualificationWindow(seconds), /whole-second test window/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qualification-window-'));
  const packet = await fs.mkdtemp(path.join(root, 'artifacts/qualification-window-'));
  t.after(() => Promise.all([directory, packet].map((p) => fs.rm(p, { recursive: true, force: true }))));
  const env = {
    ...process.env,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: directory,
    RIVET_DEPLOYMENT_CONFIGURATION: '{}',
    RIVET_QUALIFICATION_MAX_SECONDS: '14401',
    RIVET_QUALIFICATION_PACKET: packet,
  };
  const prepare = spawnSync(
    process.execPath,
    ['.yarn/releases/yarn-4.17.1.cjs', 'node', 'deploy/studio-server/scripts/prepare-hosted-release.mjs', 'staging'],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(prepare.status, 1, prepare.stderr);
  assert.deepEqual(await fs.readdir(directory), [], 'Window validation must precede private setup and cloud access');
  for (const [value, status] of [
    ['7200', 0],
    ['14400', 0],
    ['14401', 1],
    ['', 1],
    ['NaN', 1],
    ['1.5', 1],
  ]) {
    const validation = spawnSync(
      process.execPath,
      [
        '.yarn/releases/yarn-4.17.1.cjs',
        'node',
        'deploy/studio-server/scripts/execute-runtime-qualification.mjs',
        'validate-window',
      ],
      { cwd: root, env: { ...env, RIVET_QUALIFICATION_MAX_SECONDS: value }, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(validation.status, status, validation.stderr);
    assert.deepEqual(await fs.readdir(packet), [], 'Standalone window check must not create an operation');
  }
});

test('real CLI runs two/four-hour hash-pinned drivers once, rejects over-limit windows and blocks publication on failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(root, 'artifacts/qualification-command-'));
  const privateStore = await fs.mkdtemp(path.join(os.tmpdir(), 'qualification-private-'));
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), 'qualification-driver-'));
  t.after(async () => {
    await Promise.all([directory, privateStore, bundle].map((p) => fs.rm(p, { recursive: true, force: true })));
  });
  const f = fixture();
  const entrypoint = await fs.readFile(
    path.join(root, 'deploy/studio-server/scripts/fixtures/qualification-phase-driver.mjs'),
  );
  await fs.writeFile(path.join(bundle, 'entry.mjs'), entrypoint);
  const files = { 'entry.mjs': createHash('sha256').update(entrypoint).digest('hex') };
  const createBundle = async (facts) => {
    const data = Buffer.from(JSON.stringify(facts));
    await fs.writeFile(path.join(bundle, 'facts.json'), data);
    files['facts.json'] = createHash('sha256').update(data).digest('hex');
    const manifest = {
      protocol: 1,
      provider: 'gke',
      scope: 'isolated-provider',
      suite: 'compact-seven-v1',
      entrypoint: 'entry.mjs',
      files,
    };
    await fs.writeFile(path.join(bundle, 'driver.json'), JSON.stringify(manifest));
    return qualificationHash(manifest);
  };
  for (const [attempt, failure, maxSeconds] of [
    [1, undefined, 7200],
    [2, undefined, 14400],
    [3, 'window', 14401],
    [4, 'upgrade', 14400],
  ]) {
    const target = path.join(directory, String(attempt));
    await fs.mkdir(path.join(target, 'candidate'), { recursive: true });
    await fs.mkdir(path.join(target, 'original'));
    const put = (file, value) => fs.writeFile(path.join(target, file), JSON.stringify(value));
    await put('candidate/candidate-release-manifest.json', f.operation.candidate);
    await put('original/promoted-release-manifest.json', f.promoted);
    await put('predecessor.json', f.operation.previous);
    await put('installed.json', { ...f.operation.installed, observedAt: new Date().toISOString() });
    await put('build-identity.json', { runId: '123', runAttempt: 1 });
    const start = Date.now() + 100; // Child creates its operation after this timestamp; reports must follow it.
    const facts = structuredClone(f.facts);
    facts.fail = failure;
    // The fixture emits actual observation timestamps at execution, not forged old windows.
    facts.fixtureTime = start;
    const driverDigest = await createBundle(facts);
    const env = {
      ...process.env,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: '456',
      GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: 'PRIVATE-TEST-CREDENTIAL',
      RIVET_QUALIFICATION_PRODUCTION_CONTEXT: 'must-not-leak',
      RIVET_QUALIFICATION_PACKET: target,
      RIVET_AUTOMATED_QUALIFICATION_ENABLED: 'true',
      RIVET_QUALIFICATION_PROJECT_ID: 'isolated-project',
      RIVET_QUALIFICATION_PROJECT_NUMBER: '123456789',
      RIVET_QUALIFICATION_MAX_USD: '50',
      RIVET_QUALIFICATION_MAX_SECONDS: String(maxSeconds),
      RIVET_QUALIFICATION_ENVIRONMENT_MODE: 'reusable-cluster',
      RIVET_QUALIFICATION_COORDINATOR_MODE: '',
      RIVET_QUALIFICATION_EVIDENCE_BUCKET: '',
      RIVET_QUALIFICATION_DRIVER_DIRECTORY: bundle,
      RIVET_QUALIFICATION_DRIVER_SHA256: driverDigest,
      RIVET_QUALIFICATION_PRIVATE_STORE: privateStore,
      RIVET_QUALIFICATION_STAGING_KUBECONFIG: 'local-fixture',
      RIVET_QUALIFICATION_CLUSTER_UID: 'isolated-cluster',
      RIVET_QUALIFICATION_CLUSTER_SERVER: 'https://isolated.gke.goog',
      RIVET_QUALIFICATION_GATEWAY_UID: 'shared-staging-gateway',
      GITHUB_OUTPUT: path.join(target, 'outputs'),
    };
    const result = spawnSync(
      process.execPath,
      [
        '.yarn/releases/yarn-4.17.1.cjs',
        'node',
        'deploy/studio-server/scripts/execute-runtime-qualification.mjs',
        'execute',
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(
      result.status,
      failure ? 1 : 0,
      `${result.stderr}\nPrivate filenames: ${JSON.stringify(await fs.readdir(privateStore))}\nPhase calls: ${await fs.readFile(path.join(privateStore, `rivet-q-456-${attempt}`, 'calls.jsonl'), 'utf8').catch(() => 'not started')}`,
    );
    assert.ok(!(result.stdout + result.stderr).includes('PRIVATE-TEST-CREDENTIAL'));
    const privateDirectory = path.join(privateStore, `rivet-q-456-${attempt}`);
    if (failure === 'window') {
      await assert.rejects(fs.stat(privateDirectory), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(privateStore, 'active.lock')), { code: 'ENOENT' });
      continue;
    }
    const frozen = JSON.parse(await fs.readFile(path.join(privateDirectory, 'operation.json'), 'utf8')).operation;
    assert.equal(Date.parse(frozen.expiresAt) - Date.parse(frozen.startedAt), maxSeconds * 1000);
    const calls = (await fs.readFile(path.join(privateDirectory, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(calls.filter((v) => v === 'upgrade').length, 1);
    assert.equal(calls.at(-1), 'verifyCleanup');
    assert.equal(
      await fs.stat(path.join(target, 'qualification-result.json')).then(
        () => true,
        () => false,
      ),
      !failure,
    );
    assert.equal(
      await fs.stat(path.join(privateStore, 'active.lock')).then(
        () => true,
        () => false,
      ),
      Boolean(failure),
    );
    await fs.writeFile(path.join(bundle, 'unexpected.txt'), 'unrecorded');
    await assert.rejects(verifyQualificationDriver(bundle, driverDigest), /unrecorded/);
    await fs.unlink(path.join(bundle, 'unexpected.txt'));
  }
});

async function qualifiedFixture() {
  const f = fixture();
  f.input.approval.safetyDigest = '9'.repeat(64);
  f.input.installed.qualificationValues = { resources: {}, postgres: {}, lifecycle: {} };
  f.operation = qualificationOperation(f.input);
  for (const report of Object.values(f.facts))
    if (report && typeof report === 'object') report.inputHash = f.operation.inputHash;
  const result = await executeRuntimeQualification(f.operation, driver(f).api, async () => {}, { now: f.now });
  const input = {
    candidate: f.operation.candidate,
    promoted: f.promoted,
    control: result.control,
    autoscaling: result.autoscaling,
    repository,
    sourceSha: sha,
    build: { runId: '123', runAttempt: 1 },
    safetyDigest: f.input.approval.safetyDigest,
  };
  return { f, input, packet: prepareRuntimeQualification(input) };
}

test('source safety basis survives compilation/publication and cannot be mixed across tiers or source trees', async () => {
  const { f, input, packet } = await qualifiedFixture();
  assert.equal(packet.candidate.evidence.runtimeControl.qualification.tier, 'full');
  assert.deepEqual(packet.candidate.evidence.runtimeAutoscaling.qualification, f.operation.qualification);
  assert.throws(() => prepareRuntimeQualification({ ...input, safetyDigest: '8'.repeat(64) }), /committed runtime/);
  const invalid = structuredClone(packet.candidate);
  delete invalid.evidence.runtimeAutoscaling.qualification;
  assert.throws(() => assertStudioServerReleaseManifest(invalid), /same operation/);
});

test('focused policy observation requires fresh independent controller samples, ready floors and its own successful traffic', () => {
  const f = fixture();
  const operation = { ...f.operation, qualification: { tier: 'focused' } };
  const report = {
    ...f.facts.autoscaling,
    purpose: 'focused-policy-observation',
    observations: [2200, 2800].map((offset) => ({
      ready: { execution: 2, proxy: 2 },
      autoscaler: { policyDigest: operation.policyDigest, sampleAt: Date.parse(operation.startedAt) + offset },
    })),
  };
  for (const key of ['cooperative', 'capacity', 'cpu', 'drain', 'metrics', 'proxyHpa']) delete report[key];
  assert.doesNotThrow(() => assertProviderAutoscalingReport(report, operation));
  for (const change of [
    (x) => {
      x.observations[1].autoscaler.sampleAt = x.observations[0].autoscaler.sampleAt;
    },
    (x) => {
      x.observations[0].ready.proxy = 1;
    },
    (x) => {
      x.observations[0].autoscaler.sampleAt = String(x.observations[0].autoscaler.sampleAt);
    },
    (x) => {
      x.observations[0].autoscaler.policyDigest = 'changed';
    },
    (x) => {
      x.workflow.samples = 0;
    },
    (x) => {
      x.web.failures.push('unavailable');
    },
    (x) => {
      x.proxyHpa = { invented: true };
    },
  ]) {
    const invalid = structuredClone(report);
    change(invalid);
    assert.throws(() => assertProviderAutoscalingReport(invalid, operation));
  }
});

test('production action invokes the normal command once with bound inputs and publishes only a sanitized success', async (t) => {
  const { f, packet } = await qualifiedFixture();
  const manifest = promoteStudioServerReleaseManifest(packet.candidate, { promotionEvidence: evidence });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-qualified-deploy-'));
  const privateStore = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-qualified-deploy-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => fs.rm(privateStore, { recursive: true, force: true }));
  const identity = { context: 'production', namespace: 'rivet', release: 'rivet' };
  const adapter = 'throw Error("should only be executed by the normal deployment command");';
  const installation = path.join(privateStore, 'installation');
  await fs.mkdir(installation);
  await fs.writeFile(path.join(installation, 'adapter.mjs'), adapter);
  const entry = { script: 'adapter.mjs', sha256: `sha256:${createHash('sha256').update(adapter).digest('hex')}` };
  const policyFile = path.join(installation, 'policy.json');
  await fs.writeFile(
    policyFile,
    JSON.stringify({ formatVersion: 1, ...identity, namespaceUid: 'production-ns', backup: entry, acceptance: entry }),
  );
  const valuesFile = path.join(directory, 'values.yaml');
  await fs.writeFile(valuesFile, 'private: never-upload');
  const operation = {
    ...structuredClone(f.operation),
    candidate: { sourceSha: sha, images: manifest.images, chartDigest: manifest.chart.contentDigest },
  };
  operation.installed.valuesDigest = `sha256:${createHash('sha256')
    .update(await fs.readFile(valuesFile))
    .digest('hex')}`;
  const digest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
  let calls = 0;
  const args = {
    root: directory,
    packet: directory,
    operation,
    manifest,
    digest,
    sourceSha: sha,
    identity,
    valuesFile,
    policyFile,
    privateStore,
    run: async (_bin, argv) => {
      calls++;
      assert.ok(argv[0].endsWith('deploy-kubernetes-release.mjs'));
      assert.ok(!argv.includes('--preflight-only'));
      assert.equal(argv[argv.indexOf('--expected-installed-settings-digest') + 1], operation.installed.settingsDigest);
      assert.equal(await fs.readFile(argv[argv.indexOf('--values') + 1], 'utf8'), 'private: never-upload');
      await fs.writeFile(
        path.join(directory, 'private-deployment/deployment-result.json'),
        JSON.stringify({
          state: 'complete',
          candidateManifestDigest: digest,
          outcome: { infrastructure: 'applied', autoscaling: 'verified', application: 'passed' },
        }),
      );
    },
  };
  for (const change of [
    (x) => {
      x.sourceSha = '1'.repeat(40);
    },
    (x) => {
      x.digest = `sha256:${'2'.repeat(64)}`;
    },
    (x) => {
      x.operation.installed.namespaceUid = 'other-namespace';
    },
    (x) => {
      x.operation.installed.valuesDigest = `sha256:${'3'.repeat(64)}`;
    },
    (x) => {
      x.operation.candidate.images.api.digest = `sha256:${'4'.repeat(64)}`;
    },
  ]) {
    const invalid = { ...args, operation: structuredClone(operation) };
    invalid.packet = await fs.mkdtemp(path.join(directory, 'invalid-'));
    change(invalid);
    await assert.rejects(deployQualifiedRelease(invalid));
    assert.equal(calls, 0);
  }
  const result = await deployQualifiedRelease(args);
  assert.equal(result.status, 'deployed');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
  const saved = path.join(privateStore, operation.operationId, 'receipts');
  assert.equal(await fs.readFile(path.join(saved, 'values.yaml'), 'utf8'), 'private: never-upload');
  assert.equal(await fs.readFile(path.join(saved, 'private-installation-policy/backup.mjs'), 'utf8'), adapter);
  const newCheckoutPacket = await fs.mkdtemp(path.join(directory, 'retry-'));
  await assert.rejects(deployQualifiedRelease({ ...args, packet: newCheckoutPacket }), { code: 'EEXIST' });
  assert.equal(calls, 1, 'Fresh checkout packets cannot replay the durable production attempt');
  await assert.rejects(deployQualifiedRelease(args), { code: 'EEXIST' });
  assert.equal(calls, 1);
  const failedPacket = await fs.mkdtemp(path.join(directory, 'failed-'));
  let failedCalls = 0;
  const failed = {
    ...args,
    packet: failedPacket,
    operation: { ...operation, operationId: 'rivet-q-999-1' },
    run: async () => {
      failedCalls++;
      throw Error('private stderr: uncertain write');
    },
  };
  await assert.rejects(deployQualifiedRelease(failed), /uncertain write/);
  assert.match(
    await fs.readFile(path.join(failedPacket, 'private-deployment/command-failure.log'), 'utf8'),
    /private stderr/,
  );
  await assert.rejects(deployQualifiedRelease(failed), { code: 'EEXIST' });
  assert.equal(failedCalls, 1);
});
