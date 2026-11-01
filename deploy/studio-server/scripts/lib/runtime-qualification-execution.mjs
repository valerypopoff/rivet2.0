import assert from 'node:assert/strict';
import { overlapQualificationProfile, overlapProfileDigest } from './qualification-overlap-profile.mjs';
import { createHash } from 'node:crypto';
import { assertRuntimeUpgradePair } from './runtime-upgrade-qualification.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import {
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_COOPERATIVE_AUTOSCALING_CHECKS,
  HA_FOCUSED_AUTOSCALING_CHECKS,
  HA_PROVIDER_OVERLAP_CHECKS,
} from './ha-release-evidence.mjs';
import { getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';
import { assertRequestContinuityProfile, requestContinuityProfile } from './request-continuity.mjs';
import { assertContinuityProviderFacts, compileRequestContinuityEvidence } from './request-continuity-evidence.mjs';
import { releaseQualificationPlan } from './release-qualification-policy.mjs';

// The hosted workflow reserves another hour for cleanup and 30 minutes for setup.
export const ACTIONS_QUALIFICATION_MAX_SECONDS = 4 * 60 * 60;
export function assertActionsQualificationWindow(seconds) {
  assert.ok(
    Number.isSafeInteger(seconds) && seconds > 0 && seconds <= ACTIONS_QUALIFICATION_MAX_SECONDS,
    'Actions qualification requires a whole-second test window from 1 to 14400 seconds',
  );
  return seconds;
}

export const qualificationHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = (value) => {
  assert.equal(typeof value, 'string');
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/);
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result) && new Date(result).toISOString().slice(0, 19) === value.slice(0, 19));
  return result;
};
const count = (value) => {
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  return value;
};
const nonempty = (value) => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  return value;
};
const digest = (value) => {
  assert.match(value, /^sha256:[a-f0-9]{64}$/);
  return value;
};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Immutable operation input. The registry's publication pointer is NOT the
 * installed production version. The driver must observe the installation. */
export function qualificationOperation({
  candidate,
  previous,
  installed,
  policy,
  approval,
  operationId,
  now = Date.now(),
}) {
  assertRuntimeUpgradePair(previous, candidate);
  assert.match(operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
  assert.equal(approval.enabled, true, 'Automated provider qualification is not enabled');
  assert.match(approval.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  assert.notEqual(approval.projectId, 'wartime-storyteller', 'Production cannot be a qualification project');
  assert.match(approval.projectNumber, /^[1-9][0-9]{5,20}$/);
  assert.ok(Number.isFinite(approval.maxUsd) && approval.maxUsd > 0);
  assert.ok(Number.isSafeInteger(approval.maxSeconds) && approval.maxSeconds > 0 && approval.maxSeconds <= 86400);
  assert.match(approval.driverBundleSha256, /^[a-f0-9]{64}$/);
  const staging = approval.staging;
  assert.equal(staging.mode, 'reusable-cluster');
  nonempty(staging.clusterUid);
  nonempty(staging.gatewayUid);
  const server = new URL(staging.clusterServer);
  assert.equal(server.protocol, 'https:');
  assert.ok(!server.username && !server.password && server.pathname === '/' && !server.search && !server.hash);
  assert.notEqual(staging.clusterUid, nonempty(installed.clusterUid), 'Staging cannot share the production cluster');
  const parent = approval.temporaryEnvironment;
  if (parent) {
    assert.match(parent.inputHash, /^[a-f0-9]{64}$/);
    assert.ok(time(parent.startedAt) <= now && time(parent.expiresAt) > now);
    assert.equal(
      time(parent.expiresAt) - time(parent.startedAt),
      approval.maxSeconds * 1000,
      'Temporary allowance clock changed',
    );
  }
  const normalized = autoscalerPolicy(policy);
  assert.equal(normalized.minReplicas, 2);
  assert.ok(normalized.maxReplicas >= 4, 'Active and paused growth tests need two surge steps');
  const predecessorManifestDigest = getStudioServerReleaseManifestDigest(previous, { requirePromoted: true });
  assert.equal(installed.scope, 'production-read-only');
  assert.equal(
    installed.manifestDigest,
    predecessorManifestDigest,
    'Installed predecessor differs from candidate lineage',
  );
  assert.deepEqual(installed.images, previous.images, 'Installed image settings disagree with the predecessor');
  assert.equal(installed.schemaVersion, previous.database.managedWorkflowSchema.version);
  assert.ok(
    now - time(installed.observedAt) >= 0 && now - time(installed.observedAt) <= 300_000,
    'Installed snapshot is stale',
  );
  digest(installed.valuesDigest);
  digest(installed.settingsDigest);
  nonempty(installed.namespaceUid);
  assert.ok(
    (approval.developerOverlapProfile ? ['singleton', 'singleton-overlap'] : ['singleton']).includes(
      installed.controlPlaneMode,
    ),
  );
  assert.equal(installed.edgeProfile, 'compact');
  const adoptedContinuity = requestContinuityProfile(installed.qualificationValues ?? {});
  if (adoptedContinuity)
    assert.deepEqual(
      approval.requestContinuityProfile,
      adoptedContinuity,
      'Adopted continuity must be qualified again for the new exact image pair',
    );
  if (approval.requestContinuityProfile)
    assert.ok(
      approval.maxSeconds >= 7200,
      'Continuity observation and cleanup require at least a two-hour approved window',
    );
  if (approval.developerOverlapProfile) {
    const sourcePool = installed.qualificationValues?.postgres?.poolMaxPerApiPod;
    assert.ok(
      Number.isSafeInteger(sourcePool) && sourcePool >= approval.developerOverlapProfile.poolMaxPerApiPod,
      'Overlap adoption must record its original pool and cannot increase it',
    );
  }
  assert.equal(installed.policyDigest, autoscalerPolicyDigest(normalized));
  assert.deepEqual(installed.baseline, { backend: 1, web: 1, execution: 2, proxy: 2, autoscaler: 1 });
  const input = {
    protocol: 1,
    operationId,
    scope: 'isolated-provider',
    provider: 'gke',
    projectId: approval.projectId,
    projectNumber: approval.projectNumber,
    startedAt: parent?.startedAt ?? new Date(now).toISOString(),
    expiresAt: parent?.expiresAt ?? new Date(now + approval.maxSeconds * 1000).toISOString(),
    maxUsd: approval.maxUsd,
    staging,
    ...(parent ? { temporaryEnvironment: structuredClone(parent) } : {}),
    driverBundleSha256: approval.driverBundleSha256,
    candidate,
    previous,
    installed,
    policy: normalized,
    ...(approval.safetyDigest
      ? {
          qualification: releaseQualificationPlan({
            safetyDigest: approval.safetyDigest,
            previous,
            predecessorDigest: predecessorManifestDigest,
            candidate,
            installed,
            policy: normalized,
            profile: approval.requestContinuityProfile,
            overlap: approval.developerOverlapProfile,
          }),
        }
      : {}),
    ...(approval.requestContinuityProfile
      ? { requestContinuityProfile: assertRequestContinuityProfile(approval.requestContinuityProfile) }
      : {}),
    ...(approval.developerOverlapProfile
      ? { developerOverlapProfile: overlapQualificationProfile(approval.developerOverlapProfile) }
      : {}),
    candidateManifestDigest: getStudioServerReleaseManifestDigest(candidate),
    predecessorManifestDigest,
    policyDigest: autoscalerPolicyDigest(normalized),
  };
  return freeze(structuredClone({ ...input, inputHash: qualificationHash(input) }));
}

function bound(report, operation) {
  assert.equal(report.protocol, 1);
  for (const key of ['operationId', 'inputHash', 'projectId', 'projectNumber'])
    assert.equal(report[key], operation[key]);
}
function window(report, operation) {
  bound(report, operation);
  assert.ok(time(report.startedAt) >= time(operation.startedAt));
  assert.ok(time(report.finishedAt) > time(report.startedAt));
  assert.ok(time(report.finishedAt) <= time(operation.expiresAt), 'Protected test exceeded the approved deadline');
  assert.ok(time(report.finishedAt) <= Date.now(), 'Provider report is from the future');
  assert.equal(report.outcome, 'passed');
}
export function assertQualificationGuard(guard, operation) {
  bound(guard, operation);
  assert.equal(guard.expiresAt, operation.expiresAt);
  assert.equal(guard.maxUsd, operation.maxUsd);
  assert.equal(guard.billableActivation, false, 'Arm the existing janitor before creating paid test resources');
  if (operation.temporaryEnvironment) {
    assert.equal(guard.activationScope, 'fixture-only');
    assert.equal(guard.foundationBillableActivation, true);
    assert.equal(guard.foundationInputHash, operation.temporaryEnvironment.inputHash);
  }
  assert.equal(guard.stagingClusterUid, operation.staging.clusterUid);
  nonempty(guard.identity);
  assert.equal(guard.independent, true, 'Expiry cleanup must survive the workflow/runner');
  assert.equal(guard.armed, true);
}
function inventory(items, operation) {
  assert.ok(Array.isArray(items));
  const ids = new Set();
  for (const item of items) {
    nonempty(item.id);
    nonempty(item.kind);
    assert.equal(item.operationId, operation.operationId);
    assert.equal(item.projectNumber, operation.projectNumber);
    assert.equal(item.newlyCreated, true, 'Pre-existing resources are not cleanup-owned');
    assert.ok(
      [
        'namespace',
        'pod',
        'service',
        'configmap',
        'secret',
        'deployment',
        'statefulset',
        'job',
        'pvc',
        'pv',
        'httproute',
        'healthcheckpolicy',
        'gcpbackendpolicy',
        'neg',
        'disk',
        'backendservice',
        'healthcheck',
      ].includes(item.kind.toLowerCase()),
      'Reusable staging infrastructure is never operation cleanup-owned',
    );
    assert.ok(![operation.staging.clusterUid, operation.staging.gatewayUid].includes(item.id));
    assert.equal(typeof item.billable, 'boolean');
    assert.ok(!ids.has(item.id), 'Duplicate resource identity');
    ids.add(item.id);
  }
  return ids;
}

export function assertOrdinaryProviderReport(report, operation) {
  assertContinuityProviderFacts(report, operation, 'upgrade');
  window(report, operation);
  assert.equal(report.qualification, 'isolated-provider');
  assert.equal(report.purpose, 'ordinary-upgrade');
  assert.equal(report.predecessorManifestDigest, operation.predecessorManifestDigest);
  assert.equal(report.candidateSourceSha, operation.candidate.source.sha);
  assert.deepEqual(report.candidateImages, operation.candidate.images);
  assert.equal(report.chartDigest, operation.candidate.chart.contentDigest);
  assert.equal(report.policyDigest, operation.policyDigest);
  assert.equal(report.initialApplicationPods, 7);
  assert.equal(report.finalApplicationPods, 7);
  assertPublicTraffic(report);
  assert.ok(count(report.readiness.samples) > 0);
  for (const role of ['execution', 'proxy']) assert.ok(count(report.readiness.minimumReady[role]) >= 2);
  const work = report.outcomes.acceptedWork;
  assert.equal(work.length, 2);
  assert.equal(new Set(work.map((r) => nonempty(r.uid))).size, 2);
  assert.equal(new Set(work.map((r) => nonempty(r.recordingId))).size, 2);
  for (const r of work) {
    // Both probes use the same synthetic workflow. The second scoped page
    // legitimately contains both runs; uniqueness belongs to correlationId.
    assert.ok(count(r.recordingLookup.totalRuns) >= 1 && r.recordingLookup.totalRuns <= work.length);
    assert.equal(r.recordingLookup.hasMore, false);
    assert.equal(nonempty(r.workflowId), r.recordingLookup.workflowId);
    assert.deepEqual(r.recordingLookup.matches, [{ id: r.recordingId, status: 'succeeded' }]);
  }
  for (const sample of ['initialAutoscaler', 'autoscaler', 'finalAutoscaler']) {
    const value = report.outcomes[sample];
    assert.equal(value.policyDigest, operation.policyDigest);
    assert.ok(
      Number.isSafeInteger(value.sampleAt) &&
        value.sampleAt >= time(report.startedAt) &&
        value.sampleAt <= time(report.finishedAt),
    );
  }
  assert.equal(report.outcomes.maintenanceArchivePreserved, true);
  if (operation.developerOverlapProfile) {
    assert.deepEqual(report.outcomes.overlapPreparation, {
      sourceMode: operation.installed.controlPlaneMode,
      sourcePool: operation.installed.qualificationValues.postgres.poolMaxPerApiPod,
      preparationComplete: true,
    });
    const observed = report.outcomes.developerOverlap;
    assert.equal(observed.profileDigest, overlapProfileDigest(operation.developerOverlapProfile));
    assert.equal(observed.adoptionOrAlreadyEnabled, true);
    assert.equal(observed.interruptedSameOperationRecovered, true);
    assert.ok(observed.sameNodeSamples > 0);
    assert.ok(observed.readinessSamples > 0);
    assert.equal(observed.minimumReady, 1);
    assert.equal(observed.maximumHousekeepingOwners, 1);
    assert.equal(observed.handoverCount, 2);
    assert.equal(observed.claimIdentityPreserved, true);
    for (const key of ['name', 'uid', 'volume', 'volumeUid', 'size']) nonempty(observed.maintenanceClaim.before[key]);
    assert.deepEqual(observed.maintenanceClaim.after, observed.maintenanceClaim.before);
    assert.equal(observed.finalBackendCount, 1);
    assert.equal(observed.finalOwnerCount, 1);
    assert.equal(observed.editorRuns.length, 2);
    assert.equal(new Set(observed.editorRuns.map((r) => r.uid)).size, 2);
    for (const run of observed.editorRuns) {
      nonempty(run.uid);
      assert.equal(run.receipt.phase, 'passed');
      assert.equal(run.receipt.editorResumed, true);
      assert.equal(run.receipt.latestMesh, true);
      assert.equal(run.receipt.bundleSharedExecution, true);
      assert.equal(run.receipt.bundleProjectIds.length, 2);
      assert.equal(new Set(run.receipt.bundleProjectIds).size, 2);
      assert.equal(run.receipt.starts, 1);
      assert.equal(run.receipt.completions, 1);
    }
    for (const field of ['passed', 'unsavedEdit', 'savedByCandidate', 'newRun', 'outputs', 'recordingOpened'])
      assert.equal(observed.browser[field], true);
    assert.equal(observed.browser.reloads, 0);
    assert.equal(observed.browser.iframeReloads, 0);
    assert.ok(observed.developerTraffic.samples >= 100);
    assert.deepEqual(observed.developerTraffic.failures, []);
  }
  assert.equal(report.storageIdentityPreserved, true);
  for (const field of ['coldProxyReplacement', 'browserOAuthAction', 'publishedScheduleRecording'])
    assert.equal(report.outcomes.independence[field], true);
}

/** Compile from completed probe facts, never a submitted array of check names. */
export function assertProviderAutoscalingReport(report, operation) {
  assertContinuityProviderFacts(report, operation, 'autoscaling');
  window(report, operation);
  assertPublicTraffic(report);
  assert.equal(report.source, operation.candidate.source.sha);
  assert.deepEqual(report.policy, operation.policy);
  assert.equal(report.policyDigest, operation.policyDigest);
  assert.equal(report.finalApplicationPods, 7);
  if (operation.qualification?.tier === 'focused') {
    assert.equal(report.purpose, 'focused-policy-observation');
    assert.ok(report.observations.length >= 2);
    for (const observation of report.observations) {
      assert.equal(observation.autoscaler.policyDigest, operation.policyDigest);
      assert.ok(Number.isSafeInteger(observation.autoscaler.sampleAt));
      assert.ok(observation.autoscaler.sampleAt >= time(report.startedAt));
      assert.ok(observation.autoscaler.sampleAt <= time(report.finishedAt));
      for (const role of ['execution', 'proxy']) assert.ok(count(observation.ready[role]) >= 2);
    }
    assert.ok(report.observations.at(-1).autoscaler.sampleAt > report.observations[0].autoscaler.sampleAt);
    for (const key of ['cooperative', 'capacity', 'cpu', 'drain', 'metrics', 'proxyHpa'])
      assert.equal(report[key], undefined, 'Focused evidence cannot claim unexecuted stress tests');
    return;
  }
  const cooperative = report.cooperative;
  for (const mode of ['active', 'paused']) {
    assert.ok(count(cooperative[mode].to) > count(cooperative[mode].from));
    assert.ok(cooperative[mode].to <= operation.policy.maxReplicas);
    nonempty(cooperative[mode].token);
    nonempty(cooperative[mode].ownerUid);
  }
  assert.equal(cooperative.active.token, cooperative.paused.token);
  assert.ok(cooperative.paused.from >= cooperative.active.to);
  assert.equal(cooperative.active.ownerUid, cooperative.paused.ownerUid);
  assert.ok(
    cooperative.paused.scaleDownSuppressedMs >=
      (operation.policy.stabilizationSeconds + operation.policy.cooldownSeconds) * 1000,
  );
  assert.equal(cooperative.paused.acceptedWorkRecorded, true);
  assert.equal(cooperative.resumedSameToken, true);
  assert.equal(cooperative.finalExecutionReplicas, 2);
  assert.equal(cooperative.developerReplicasUnchanged, true);
  assert.equal(report.capacity.peak.replicas, operation.policy.maxReplicas);
  assert.equal(report.capacity.actualProviderHosts.length, operation.policy.maxReplicas);
  assert.equal(
    new Set(report.capacity.actualProviderHosts.map((p) => nonempty(p.node))).size,
    operation.policy.maxReplicas,
  );
  for (const p of report.capacity.actualProviderHosts) {
    nonempty(p.podUid);
    assert.ok(
      p.providerId.startsWith(`gce://${operation.projectId}/`) ||
        p.providerId.startsWith(`gce://${operation.projectNumber}/`),
    );
  }
  assert.equal(report.capacity.automaticallyReturnedToTwo, true);
  assert.equal(report.cpu.separateCpuGrowth, true);
  assert.equal(report.cpu.developerReplicasUnchanged, true);
  assert.ok(count(report.cpu.to) > count(report.cpu.from));
  const drain = report.drain;
  for (const key of ['higherUidPreserved', 'longCorrelation', 'retirementOperationId', 'incarnation'])
    nonempty(drain[key]);
  for (const key of [
    'busyEvictionRejected',
    'sameOperationRecovered',
    'concurrentDeploymentRejected',
    'acceptedWorkRecorded',
  ])
    assert.equal(drain[key], true);
  assert.equal(report.metrics.length, 2);
  assert.deepEqual(new Set(report.metrics.map((m) => m.mode)), new Set(['metrics-missing', 'metrics-stale']));
  for (const m of report.metrics) {
    assert.ok(count(m.observations) >= 2);
    assert.ok(m.capacityUnchangedForMs >= operation.policy.stabilizationSeconds * 1000);
    assert.equal(m.lowDemandWindowReset, true);
  }
  assert.equal(report.lostAck.sameTransitionDispatches, 1);
  assert.equal(report.lostAck.acceptedScale.state, 'accepted-response-suppressed');
  assert.equal(report.proxyHpa.manuallyChangedReplicas, false);
  assert.equal(report.proxyHpa.developerReplicasUnchanged, true);
  assert.equal(report.proxyHpa.readyUids.length, 4);
  assert.equal(new Set(report.proxyHpa.readyUids).size, 4);
  assert.ok(report.accepted.length > 0);
  for (const r of report.accepted) {
    assert.ok(count(r.count) > 0);
    assert.equal(r.responses.length, r.count);
    for (const response of r.responses) {
      assert.equal(response.status, 200);
      nonempty(r.recordings[response.correlationId]);
    }
  }
}

function assertPublicTraffic(report) {
  for (const traffic of [report.workflow, report.web]) {
    assert.ok(count(traffic.samples) >= 100);
    assert.deepEqual(traffic.failures, []);
  }
}

/** A failed/expired observation still settles and cleans. Never replay a phase.
 * Durable inventory and the independent janitor belong to the approved provider
 * driver, not an Actions finally block. The latter cannot survive runner loss. */
export async function executeRuntimeQualification(operation, driver, persist, { now = Date.now, signal } = {}) {
  const record = {
    protocol: 1,
    operationId: operation.operationId,
    inputHash: operation.inputHash,
    outcome: 'running',
    phase: 'created',
  };
  const facts = {};
  let failure;
  const phase = async (name, { cleanup = false } = {}) => {
    if (!cleanup) {
      signal?.throwIfAborted();
      assert.ok(now() < time(operation.expiresAt), 'Qualification expired');
    }
    record.phase = name;
    await persist(structuredClone(record)); // intent before every side effect
    if (!cleanup) {
      signal?.throwIfAborted();
      assert.ok(now() < time(operation.expiresAt), 'Qualification expired before phase dispatch');
    }
    const result = await driver[name](operation);
    if (!cleanup) {
      signal?.throwIfAborted();
      assert.ok(now() < time(operation.expiresAt), 'Qualification expired before phase acknowledgement');
    }
    bound(result, operation);
    // Drivers own their returned objects. Later awaits must not let them revise
    // facts that have already passed validation or alter cleanup authority.
    return freeze(structuredClone(result));
  };
  try {
    facts.guard = await phase('armExpiry');
    assertQualificationGuard(facts.guard, operation);
    facts.prepared = await phase('prepare');
    assert.equal(facts.prepared.inventoryComplete, true);
    assert.equal(facts.prepared.stagingClusterUid, operation.staging.clusterUid);
    inventory(facts.prepared.inventory, operation);
    assert.equal(facts.prepared.expiryIdentity, facts.guard.identity);
    facts.upgrade = await phase('upgrade');
    assertOrdinaryProviderReport(facts.upgrade, operation);
    facts.autoscaling = await phase('autoscaling');
    assertProviderAutoscalingReport(facts.autoscaling, operation);
    assert.ok(time(facts.autoscaling.startedAt) >= time(facts.upgrade.finishedAt), 'Protected phase windows overlap');
  } catch (error) {
    failure = error;
  } finally {
    try {
      const settled = await phase('settle', { cleanup: true });
      assert.equal(settled.writersStopped, true);
      assert.equal(settled.acceptedWorkSettled, true);
      assert.equal(settled.inventoryComplete, true);
      const owned = inventory(settled.inventory, operation);
      for (const original of facts.prepared?.inventory ?? []) {
        assert.ok(owned.has(original.id), 'Inventory lost an owned resource');
        const current = settled.inventory.find((item) => item.id === original.id);
        for (const key of ['id', 'kind', 'operationId', 'projectNumber', 'newlyCreated', 'billable'])
          assert.deepEqual(current[key], original[key], 'Cleanup inventory reclassified an owned resource');
      }
      await phase('cleanup', { cleanup: true });
      const verified = await phase('verifyCleanup', { cleanup: true });
      assert.equal(verified.inventoryComplete, true);
      assert.equal(verified.inventoryHash, qualificationHash(settled.inventory));
      assert.equal(verified.resources.length, owned.size);
      assert.deepEqual(new Set(verified.resources.map((r) => r.id)), owned);
      for (const item of verified.resources) {
        const original = settled.inventory.find((r) => r.id === item.id);
        assert.ok(item.state === 'absent' || (!original.billable && item.state === 'non-billable-hold'));
      }
      assert.equal(verified.uncertainWrites, 0);
      record.cleanupVerified = true;
    } catch (error) {
      record.cleanupVerified = false;
      failure ??= error;
    }
  }
  record.phase = 'terminal';
  record.outcome = failure ? 'failed' : 'passed';
  record.finishedAt = new Date(now()).toISOString();
  await persist(structuredClone(record));
  if (failure)
    throw new Error(
      'Qualification failed; inspect private phase diagnostics and cleanup status. No release was qualified.',
      { cause: failure },
    );
  const common = {
    ...(operation.qualification ? { qualification: operation.qualification } : {}),
    protocol: 1,
    candidateSourceSha: operation.candidate.source.sha,
    candidateImages: operation.candidate.images,
    chartDigest: operation.candidate.chart.contentDigest,
    failedRequests: 0,
  };
  const declaration = (report, evidence) => ({
    protocol: 1,
    provider: 'gke',
    scope: 'isolated-provider',
    outcome: 'passed',
    cleanupVerified: true,
    operationId: operation.operationId,
    projectId: operation.projectId,
    projectNumber: operation.projectNumber,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    reportSha256: qualificationHash(report),
    evidence,
  });
  return {
    status: 'qualified',
    operationId: operation.operationId,
    inputHash: operation.inputHash,
    control: declaration(facts.upgrade, {
      ...common,
      ...(operation.requestContinuityProfile
        ? { requestContinuity: compileRequestContinuityEvidence(operation, facts.upgrade, facts.autoscaling) }
        : {}),
      protocol: operation.qualification?.tier === 'focused' ? 4 : operation.developerOverlapProfile ? 3 : 2,
      purpose: 'ordinary-upgrade',
      controlPlaneMode: operation.developerOverlapProfile ? 'singleton-overlap' : 'singleton',
      ...(operation.developerOverlapProfile
        ? {
            developerOverlap: {
              protocol: 2,
              sourceMode: operation.installed.controlPlaneMode,
              sourcePool: operation.installed.qualificationValues.postgres.poolMaxPerApiPod,
              profile: operation.developerOverlapProfile,
              profileDigest: overlapProfileDigest(operation.developerOverlapProfile),
              checks: [...HA_PROVIDER_OVERLAP_CHECKS],
            },
          }
        : {}),
      edgeProfiles: ['compact'],
      predecessorManifestDigest: operation.predecessorManifestDigest,
      predecessorSourceSha: operation.previous.source.sha,
      predecessorImages: operation.previous.images,
      autoscalerPolicyDigest: operation.policyDigest,
      requestSamples: facts.upgrade.workflow.samples + facts.upgrade.web.samples,
      checks: [...HA_ORDINARY_RUNTIME_CHECKS],
    }),
    autoscaling: {
      ...declaration(facts.autoscaling, {
        ...common,
        protocol: operation.qualification?.tier === 'focused' ? 3 : 2,
        provider: 'gke',
        policyDigest: operation.policyDigest,
        requestSamples: facts.autoscaling.workflow.samples + facts.autoscaling.web.samples,
        checks: [
          ...(operation.qualification?.tier === 'focused'
            ? HA_FOCUSED_AUTOSCALING_CHECKS
            : HA_COOPERATIVE_AUTOSCALING_CHECKS),
        ],
      }),
      policy: operation.policy,
    },
  };
}

export function assertQualificationPreflight(
  receipt,
  operation,
  qualifiedManifestDigest,
  { now = Date.now(), adoptionStage, valuesDigest = operation.installed.valuesDigest } = {},
) {
  assert.equal(receipt.formatVersion, 1);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.scope, 'installed-state-and-local-readiness');
  assert.equal(receipt.workloadMutations, false);
  assert.equal(receipt.applicationJourneysRun, false);
  assert.equal(receipt.installedManifestDigest, operation.predecessorManifestDigest);
  if (adoptionStage) {
    assert.ok(['sizing', 'ownership'].includes(adoptionStage));
    assert.equal(operation.installed.controlPlaneMode, 'singleton');
    assert.equal(receipt.candidateManifestDigest, operation.predecessorManifestDigest);
    assert.equal(receipt.authorizationManifestDigest, digest(qualifiedManifestDigest));
    assert.equal(receipt.adoptionStage, adoptionStage);
  } else {
    assert.equal(receipt.candidateManifestDigest, digest(qualifiedManifestDigest));
    assert.equal(receipt.authorizationManifestDigest, undefined);
    assert.equal(receipt.adoptionStage, undefined);
  }
  assert.equal(receipt.namespaceUid, operation.installed.namespaceUid);
  assert.equal(receipt.valuesDigest, valuesDigest);
  assert.ok(now - time(receipt.observedAt) >= 0 && now - time(receipt.observedAt) <= 300_000);
  return {
    status: adoptionStage ? 'adoption-preflight-passed' : 'deployment-preflight-passed',
    ...(adoptionStage
      ? {
          pendingSteps: [
            ...(adoptionStage === 'sizing' ? ['same-image-pool-preparation'] : []),
            'same-image-ownership-transfer',
            'ordinary-qualified-upgrade',
          ],
        }
      : {}),
    observedAt: receipt.observedAt,
    candidateManifestDigest: qualifiedManifestDigest,
    productionUnchanged: true,
    deploymentAuthorized: false,
    recoveryBackupTaken: false,
  };
}
