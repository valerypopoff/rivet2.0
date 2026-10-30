import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  REQUEST_CONTINUITY_CHECKS,
  requestContinuityProfile,
  continuityProfileDigest,
  CONTINUITY_DURATION_STAGES,
  continuityStages,
} from './request-continuity.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values) => assert.equal(new Set(values).size, values.length, 'Duplicate continuity identity');
const timestamp = (value) => {
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const t = Date.parse(value);
  assert.ok(Number.isFinite(t));
  return t;
};
const nonempty = (value) => {
  assert.ok(typeof value === 'string' && value.length > 0);
  return value;
};

/** An explicitly selected operation needs real full-body, transport, recording
 * and lifecycle observations. Existing short-request certificates cannot pass. */
export function assertContinuityProviderFacts(report, operation, kind) {
  if (!operation.requestContinuityProfile) {
    assert.equal(report.requestContinuity, undefined);
    return;
  }
  const facts = report.requestContinuity;
  assert.equal(facts?.protocol, 2, 'Missing complete version-2 request continuity observations');
  assert.deepEqual(facts.profile, operation.requestContinuityProfile);
  const adopted = !!requestContinuityProfile(operation.installed.qualificationValues);
  assert.equal(facts.bootstrap, adopted ? 'already-protected' : 'passed');
  assert.deepEqual(facts.failures, []);
  const stages = continuityStages(adopted, kind);
  assert.equal(facts.requests.length, stages.length * 3);
  for (const stage of stages) {
    const requests = facts.requests.filter((r) => r.stage === stage);
    assert.deepEqual(requests.map((r) => r.transport).sort(), ['fresh-http1', 'http2', 'pooled-http1']);
  }
  for (const r of facts.requests) {
    for (const key of ['requestId', 'correlationId', 'recordingId', 'executionPodUid']) nonempty(r[key]);
    assert.equal(r.outcome, 'passed');
    assert.equal(r.fullBody, true);
    const duration = CONTINUITY_DURATION_STAGES[r.stage] ?? 300000;
    assert.equal(r.durationMs, duration);
    assert.ok(Number.isSafeInteger(r.elapsedMs) && r.elapsedMs >= duration && r.elapsedMs <= duration + 30000);
    assert.ok(Number.isSafeInteger(r.bodyBytes) && r.bodyBytes >= 16384 && r.bodyBytes <= 131072);
    assert.match(r.bodySha256, /^[a-f0-9]{64}$/);
    assert.ok(timestamp(r.startedAt) >= timestamp(report.startedAt));
    assert.ok(timestamp(r.finishedAt) <= timestamp(report.finishedAt));
    assert.ok(timestamp(r.acceptedAt) >= timestamp(r.startedAt) && timestamp(r.acceptedAt) < timestamp(r.finishedAt));
    assert.ok(Math.abs(timestamp(r.finishedAt) - timestamp(r.startedAt) - r.elapsedMs) <= 2000);
  }
  for (const key of ['requestId', 'correlationId', 'recordingId']) unique(facts.requests.map((r) => r[key]));
  if (kind === 'upgrade') {
    assert.equal(report.outcomes.acceptedWork.length, 2);
    assert.ok(
      report.outcomes.acceptedWork.every((r) => r.retirementDelayMs === 315000),
      'Both original execution owners must retain accepted five-minute work',
    );
    assert.equal(facts.bridgeCleaned, true);
    const a = facts.action;
    nonempty(a.runId);
    nonempty(a.requestId);
    assert.equal(a.resumed, true);
    assert.equal(a.browserResume, true);
    assert.equal(a.starts, 1);
    assert.equal(a.completions, 1);
    assert.deepEqual(a.persisted, { runs: 1, starts: 1, completions: 1 });
    assert.ok(timestamp(a.idleOpenedAt) < timestamp(a.acceptedAt) && timestamp(a.acceptedAt) < timestamp(a.finishedAt));
    const late = facts.requests.filter((r) => r.stage === 'late-admission');
    assert.ok(timestamp(a.acceptedAt) >= Math.min(...late.map((r) => timestamp(r.startedAt))));
    assert.ok(Number.isSafeInteger(a.terminalSequence) && a.terminalSequence > 1);
    const replacement = facts.replacement;
    assert.equal(replacement.before.length, 2);
    assert.equal(replacement.after.length, 2);
    unique([...replacement.before, ...replacement.after].map(nonempty));
    const overlaps = (stage, dispatchedAt, observedAt) => {
      const dispatched = timestamp(dispatchedAt),
        observed = timestamp(observedAt);
      assert.ok(dispatched <= observed);
      assert.ok(
        facts.requests
          .filter((r) => r.stage === stage)
          .every((r) => timestamp(r.acceptedAt) <= dispatched && timestamp(r.finishedAt) > observed),
        'Protected requests must be accepted before and complete after the disruption',
      );
    };
    overlaps('protected-roll', replacement.dispatchedAt, replacement.observedAt);
    if (!adopted) overlaps('return-handoff', facts.returnHandoff.dispatchedAt, facts.returnHandoff.observedAt);
  } else {
    nonempty(facts.removal.hpaUid);
    assert.ok(facts.removal.podUids.length >= 1);
    unique(facts.removal.podUids.map(nonempty));
    assert.equal(facts.removal.hpaUid, report.proxyHpa.hpaUid);
    assert.ok(facts.removal.podUids.every((uid) => report.proxyHpa.readyUids.includes(uid)));
    assert.ok(timestamp(facts.removal.admissionConfirmedAt) < timestamp(facts.removal.observedAt));
    assert.ok(
      facts.requests.every(
        (r) =>
          timestamp(r.acceptedAt) <= timestamp(facts.removal.admissionConfirmedAt) &&
          timestamp(r.finishedAt) > timestamp(facts.removal.observedAt),
      ),
      'Protected requests must span actual HPA removal',
    );
  }
}

export function compileRequestContinuityEvidence(operation, upgrade, autoscaling) {
  if (!operation.requestContinuityProfile) return undefined;
  assertContinuityProviderFacts(upgrade, operation, 'upgrade');
  assertContinuityProviderFacts(autoscaling, operation, 'autoscaling');
  const reports = [upgrade.requestContinuity, autoscaling.requestContinuity],
    requests = reports.flatMap((r) => r.requests);
  for (const key of ['requestId', 'correlationId', 'recordingId']) unique(requests.map((r) => r[key]));
  return {
    protocol: 2,
    provider: 'gke',
    gatewayClass: 'gke-l7-regional-external-managed',
    candidateSourceSha: operation.candidate.source.sha,
    candidateImages: operation.candidate.images,
    chartDigest: operation.candidate.chart.contentDigest,
    predecessorManifestDigest: operation.predecessorManifestDigest,
    profile: operation.requestContinuityProfile,
    profileDigest: continuityProfileDigest(operation.requestContinuityProfile),
    failedRequests: 0,
    completedRequests: requests.length,
    maximumCompletedDurationMs: Math.max(...requests.map((r) => r.elapsedMs)),
    checks: [...REQUEST_CONTINUITY_CHECKS],
    reportSha256: hash(reports),
    bootstrap: upgrade.requestContinuity.bootstrap,
  };
}
