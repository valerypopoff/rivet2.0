import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assertContinuityProviderFacts, compileRequestContinuityEvidence } from './lib/request-continuity-evidence.mjs';
import {
  assertRequestContinuityEvidence,
  CONTINUITY_DURATION_STAGES,
  continuityStages,
} from './lib/request-continuity.mjs';
import { qualificationSizing } from './lib/runtime-qualification-installation.mjs';
import { collectContinuityResponse } from './qualification/provider-request-continuity.mjs';

const profile = {
  protocol: 1,
  maxProtectedRequestSeconds: 300,
  backendServiceDrainSeconds: 600,
  propagationSeconds: 60,
  proxyPreStopDelaySeconds: 660,
  proxyTerminationGracePeriodSeconds: 900,
};
function facts() {
  const start = Date.now() - 700000,
    date = (n) => new Date(start + n).toISOString();
  const operation = {
    requestContinuityProfile: profile,
    installed: { qualificationValues: {} },
    predecessorManifestDigest: 'previous',
    candidate: { source: { sha: 'candidate' }, images: { api: 'image' }, chart: { contentDigest: 'chart' } },
  };
  const cohort = (stage) =>
    ['fresh-http1', 'pooled-http1', 'http2'].map((transport) => ({
      stage,
      transport,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      recordingId: randomUUID(),
      executionPodUid: 'execution-owner',
      durationMs: CONTINUITY_DURATION_STAGES[stage] ?? 300000,
      outcome: 'passed',
      fullBody: true,
      bodyBytes: 18000,
      bodySha256: 'a'.repeat(64),
      elapsedMs: CONTINUITY_DURATION_STAGES[stage] ?? 300000,
      startedAt: date(2000),
      acceptedAt: date(2500),
      finishedAt: date(2000 + (CONTINUITY_DURATION_STAGES[stage] ?? 300000)),
    }));
  const upgrade = {
    outcomes: { acceptedWork: [{ retirementDelayMs: 315000 }, { retirementDelayMs: 315000 }] },
    startedAt: date(0),
    finishedAt: date(400000),
    requestContinuity: {
      protocol: 2,
      profile,
      bootstrap: 'passed',
      bridgeCleaned: true,
      failures: [],
      requests: continuityStages(false, 'upgrade').flatMap(cohort),
      replacement: {
        before: ['old1', 'old2'],
        after: ['new1', 'new2'],
        dispatchedAt: date(4000),
        observedAt: date(5000),
      },
      returnHandoff: { dispatchedAt: date(4000), observedAt: date(5000) },
      action: {
        idleOpenedAt: date(500),
        acceptedAt: date(3000),
        finishedAt: date(63000),
        runId: randomUUID(),
        requestId: randomUUID(),
        resumed: true,
        browserResume: true,
        starts: 1,
        completions: 1,
        persisted: { runs: 1, starts: 1, completions: 1 },
        terminalSequence: 2,
      },
    },
  };
  const autoscaling = {
    startedAt: date(0),
    finishedAt: date(400000),
    proxyHpa: { hpaUid: 'hpa', readyUids: ['proxy1', 'proxy2', 'proxy3', 'proxy4'] },
    requestContinuity: {
      protocol: 2,
      profile,
      bootstrap: 'passed',
      failures: [],
      requests: cohort('hpa-removal'),
      removal: {
        hpaUid: 'hpa',
        admissionConfirmedAt: date(4000),
        observedAt: date(5000),
        podUids: ['proxy3', 'proxy4'],
      },
    },
  };
  return { operation, upgrade, autoscaling };
}

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
      maxProtectedRequestSeconds: 300,
      backendServiceDrainSeconds: 600,
      propagationSeconds: 60,
    },
    lifecycle: { shutdownGraceSeconds: 120, proxy: { preStopDelaySeconds: 660, terminationGracePeriodSeconds: 900 } },
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
