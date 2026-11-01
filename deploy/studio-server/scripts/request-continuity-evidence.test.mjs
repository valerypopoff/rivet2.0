import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  continuityProviderFacts as facts,
  continuityFixtureProfile as profile,
} from './fixtures/continuity-provider-facts.mjs';
import { assertContinuityProviderFacts, compileRequestContinuityEvidence } from './lib/request-continuity-evidence.mjs';
import { assertRequestContinuityEvidence, continuityStages } from './lib/request-continuity.mjs';
import { qualificationSizing } from './lib/runtime-qualification-installation.mjs';
import { collectContinuityResponse } from './qualification/provider-request-continuity.mjs';
import {
  assertRuntimeControlEvidence,
  assertRuntimeAutoscalingEvidence,
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_FOCUSED_AUTOSCALING_CHECKS,
} from './lib/ha-release-evidence.mjs';

test('continuity certificates compile only from all exact transport/lifecycle/recording facts', () => {
  const f = facts();
  const proof = compileRequestContinuityEvidence(f.operation, f.upgrade, f.autoscaling);
  assert.equal(proof.completedRequests, 30);
  assert.doesNotThrow(() =>
    assertRequestContinuityEvidence(
      proof,
      { ...f.operation.candidate, lineage: { predecessor: { manifestDigest: 'previous' } } },
      profile,
    ),
  );
  for (const mutate of [
    (f) => {
      f.upgrade.requestContinuity.requests[0].fullBody = false;
    },
    (f) => {
      f.upgrade.requestContinuity.requests[0].elapsedMs = 15000;
    },
    (f) => {
      f.upgrade.requestContinuity.requests[0].transport = 'fresh-http1';
      f.upgrade.requestContinuity.requests[1].transport = 'fresh-http1';
    },
    (f) => {
      f.upgrade.requestContinuity.requests[1].recordingId = f.upgrade.requestContinuity.requests[0].recordingId;
    },
    (f) => {
      f.upgrade.requestContinuity.action.persisted.runs = 2;
    },
    (f) => {
      f.upgrade.requestContinuity.bridgeCleaned = false;
    },
    (f) => {
      f.upgrade.outcomes.acceptedWork[0].retirementDelayMs = 105000;
    },
    (f) => {
      f.autoscaling.requestContinuity.removal.podUids = ['foreign'];
    },
    (f) => {
      f.autoscaling.requestContinuity.requests = [];
    },
    (f) => {
      delete f.upgrade.requestContinuity;
    },
    (f) => {
      f.upgrade.requestContinuity.requests = f.upgrade.requestContinuity.requests.filter(
        (r) => r.stage !== 'return-handoff',
      );
    },
    (f) => {
      f.upgrade.requestContinuity.requests = f.upgrade.requestContinuity.requests.filter(
        (r) => r.stage !== 'duration-295',
      );
    },
    (f) => {
      delete f.upgrade.requestContinuity.replacement.observedAt;
    },
    (f) => {
      f.upgrade.requestContinuity.replacement.observedAt = f.upgrade.finishedAt;
    },
    (f) => {
      f.autoscaling.requestContinuity.removal.observedAt = f.autoscaling.startedAt;
    },
    (f) => {
      f.autoscaling.requestContinuity.removal.observedAt = f.autoscaling.finishedAt;
    },
    (f) => {
      f.upgrade.requestContinuity.returnHandoff.dispatchedAt = f.upgrade.startedAt;
    },
    (f) => {
      delete f.upgrade.requestContinuity.requests[0].acceptedAt;
    },
    (f) => {
      delete f.autoscaling.requestContinuity.removal.admissionConfirmedAt;
    },
  ]) {
    const invalid = facts();
    mutate(invalid);
    assert.throws(() => compileRequestContinuityEvidence(invalid.operation, invalid.upgrade, invalid.autoscaling));
  }
});

test('adopted installations qualify the ordinary protected path without inventing another first transition', () => {
  const f = facts();
  f.operation.installed.qualificationValues = {
    requestContinuity: {
      enabled: true,
      maxProtectedRequestSeconds: profile.maxProtectedRequestSeconds,
      backendServiceDrainSeconds: profile.backendServiceDrainSeconds,
      propagationSeconds: profile.propagationSeconds,
    },
    lifecycle: {
      shutdownGraceSeconds: 120,
      proxy: {
        preStopDelaySeconds: profile.proxyPreStopDelaySeconds,
        terminationGracePeriodSeconds: profile.proxyTerminationGracePeriodSeconds,
      },
    },
  };
  f.upgrade.requestContinuity.bootstrap = 'already-protected';
  f.autoscaling.requestContinuity.bootstrap = 'already-protected';
  f.upgrade.requestContinuity.requests = f.upgrade.requestContinuity.requests.filter(
    (r) => !['bootstrap', 'policy-adoption', 'return-handoff'].includes(r.stage),
  );
  assert.equal(compileRequestContinuityEvidence(f.operation, f.upgrade, f.autoscaling).completedRequests, 21);
  f.upgrade.requestContinuity.bootstrap = 'passed';
  assert.throws(() => assertContinuityProviderFacts(f.upgrade, f.operation, 'upgrade'));
});

test('provider sizing never exports production route or project identities', () => {
  const exported = qualificationSizing({
    requestContinuity: {
      enabled: true,
      maxProtectedRequestSeconds: 300,
      backendServiceDrainSeconds: 600,
      propagationSeconds: 60,
      routeName: 'private-route',
      gcpProject: 'production-project',
    },
    lifecycle: { shutdownGraceSeconds: 120, proxy: { preStopDelaySeconds: 660, terminationGracePeriodSeconds: 900 } },
  });
  assert.equal(exported.requestContinuity.gcpProject, undefined);
  assert.equal(exported.requestContinuity.routeName, undefined);
  assert.equal(exported.lifecycle.proxy.preStopDelaySeconds, 660);
});

test('a response counts only after every body byte arrives; a closed partial body rejects', async () => {
  const complete = new PassThrough(),
    result = collectContinuityResponse(complete, 200, {});
  complete.write(Buffer.from('first'));
  complete.end(Buffer.from('last'));
  assert.equal((await result).body.toString(), 'firstlast');
  const partial = new PassThrough(),
    failed = collectContinuityResponse(partial, 200, {});
  partial.write('first');
  partial.destroy();
  await assert.rejects(failed, /complete body/);
});

function focusedFacts() {
  const f = facts();
  f.operation.qualification = {
    protocol: 1,
    tier: 'focused',
    safetyDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
    fullBaselineManifestDigest: `sha256:${'d'.repeat(64)}`,
  };
  f.operation.installed.qualificationValues = {
    requestContinuity: {
      enabled: true,
      maxProtectedRequestSeconds: 300,
      backendServiceDrainSeconds: 600,
      propagationSeconds: 60,
    },
    lifecycle: { shutdownGraceSeconds: 120, proxy: { preStopDelaySeconds: 660, terminationGracePeriodSeconds: 900 } },
  };
  f.upgrade.requestContinuity.protocol = 3;
  f.upgrade.requestContinuity.bootstrap = 'already-protected';
  const stages = continuityStages(true, 'upgrade', 'focused');
  f.upgrade.requestContinuity.requests = f.upgrade.requestContinuity.requests.filter((r) => stages.includes(r.stage));
  delete f.autoscaling.requestContinuity;
  return f;
}

test('focused continuity proves fresh full five-minute bodies across real upgrade stages without claiming HPA or duration-matrix tests', () => {
  const f = focusedFacts();
  const proof = compileRequestContinuityEvidence(f.operation, f.upgrade, f.autoscaling);
  assert.equal(proof.completedRequests, 9);
  assert.equal(proof.protocol, 3);
  assert.ok(!proof.checks.includes('proxy-hpa-removal'));
  const release = {
    ...f.operation.candidate,
    lineage: { predecessor: { manifestDigest: 'previous', sourceSha: 'e'.repeat(40), images: { api: 'old' } } },
  };
  const control = {
    protocol: 4,
    qualification: f.operation.qualification,
    requestContinuity: proof,
    purpose: 'ordinary-upgrade',
    controlPlaneMode: 'singleton',
    edgeProfiles: ['compact'],
    predecessorManifestDigest: 'previous',
    predecessorSourceSha: 'e'.repeat(40),
    predecessorImages: { api: 'old' },
    autoscalerPolicyDigest: 'f'.repeat(64),
    candidateSourceSha: release.source.sha,
    candidateImages: release.images,
    chartDigest: release.chart.contentDigest,
    failedRequests: 0,
    requestSamples: 200,
    checks: [...HA_ORDINARY_RUNTIME_CHECKS],
  };
  assert.equal(assertRuntimeControlEvidence(control, release, 'compact').protocol, 4);
  assert.throws(() => assertRuntimeControlEvidence({ ...control, protocol: 2 }, release));
  const scaling = {
    ...control,
    protocol: 3,
    policyDigest: 'f'.repeat(64),
    provider: 'gke',
    checks: [...HA_FOCUSED_AUTOSCALING_CHECKS],
  };
  assert.equal(assertRuntimeAutoscalingEvidence(scaling, release).protocol, 3);
  assert.throws(() => assertRuntimeAutoscalingEvidence({ ...scaling, protocol: 2 }, release));
  for (const change of [
    (x) => {
      x.upgrade.requestContinuity.requests[0].fullBody = false;
    },
    (x) => {
      x.upgrade.requestContinuity.requests[0].elapsedMs = 200;
    },
    (x) => {
      x.upgrade.requestContinuity.replacement.observedAt = x.upgrade.finishedAt;
    },
    (x) => {
      x.upgrade.requestContinuity.bootstrap = 'passed';
    },
    (x) => {
      x.upgrade.requestContinuity.action.persisted.starts = 2;
    },
    (x) => {
      x.autoscaling.requestContinuity = { inventedHpa: true };
    },
    (x) => {
      x.operation.qualification.tier = 'full';
    },
  ]) {
    const changed = focusedFacts();
    change(changed);
    assert.throws(() => compileRequestContinuityEvidence(changed.operation, changed.upgrade, changed.autoscaling));
  }
});

test('focused first adoption proves the bridge and return handoff without autoscaling stress claims', () => {
  const f = facts();
  f.operation.qualification = {
    protocol: 2,
    tier: 'focused',
    safetyDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
  };
  const stages = continuityStages(false, 'upgrade', 'focused');
  f.upgrade.requestContinuity.protocol = 3;
  f.upgrade.requestContinuity.requests = f.upgrade.requestContinuity.requests.filter((r) => stages.includes(r.stage));
  delete f.autoscaling.requestContinuity;
  const proof = compileRequestContinuityEvidence(f.operation, f.upgrade, f.autoscaling);
  assert.equal(proof.completedRequests, 18);
  assert.equal(proof.bootstrap, 'passed');
  assert.ok(proof.checks.includes('bridge-return-handoff'));
  assert.ok(!proof.checks.includes('proxy-hpa-removal'));
  const release = { ...f.operation.candidate, lineage: { predecessor: { manifestDigest: 'previous' } } };
  assertRequestContinuityEvidence(proof, release, profile);
  assert.throws(() => assertRequestContinuityEvidence({ ...proof, completedRequests: 9 }, release, profile));
  assert.throws(() =>
    assertRequestContinuityEvidence(
      { ...proof, checks: proof.checks.filter((c) => c !== 'bridge-return-handoff') },
      release,
      profile,
    ),
  );
  for (const mutate of [
    (x) => {
      x.upgrade.requestContinuity.requests = x.upgrade.requestContinuity.requests.filter(
        (r) => r.stage !== 'bootstrap',
      );
    },
    (x) => {
      x.upgrade.requestContinuity.bridgeCleaned = false;
    },
    (x) => {
      x.upgrade.requestContinuity.returnHandoff.observedAt = x.upgrade.finishedAt;
    },
  ]) {
    const changed = structuredClone(f);
    mutate(changed);
    assert.throws(() => compileRequestContinuityEvidence(changed.operation, changed.upgrade, changed.autoscaling));
  }
});
