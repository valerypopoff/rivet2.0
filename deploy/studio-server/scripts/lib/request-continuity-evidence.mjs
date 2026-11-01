import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  continuityChecks,
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
  const focused = operation.qualification?.tier === 'focused';
  if (focused) assert.equal(kind, 'upgrade', 'Focused continuity is observed in the real rollout');
  const facts = report.requestContinuity;
  assert.equal(facts?.protocol, focused ? 4 : 2, 'Missing complete request continuity observations');
  assert.deepEqual(facts.profile, operation.requestContinuityProfile);
  const adopted = !!requestContinuityProfile(operation.installed.qualificationValues);
  assert.equal(facts.bootstrap, adopted ? 'already-protected' : 'passed');
  assert.deepEqual(facts.failures, []);
  if (focused)
    assert.equal(typeof facts.replacement?.changed, 'boolean', 'Actual proxy template observation is missing');
  const stages = continuityStages(adopted, kind, focused ? 'focused' : 'full', facts.replacement?.changed);
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
    if (focused) {
      assert.equal(facts.action, undefined, 'Focused rollout cannot claim browser resume');
      assert.equal(facts.removal, undefined, 'Focused rollout cannot claim HPA removal');
      nonempty(facts.replacement.deploymentUid);
    } else {
      const a = facts.action;
      nonempty(a.runId);
      nonempty(a.requestId);
      assert.equal(a.resumed, true);
      assert.equal(a.browserResume, true);
      assert.equal(a.starts, 1);
      assert.equal(a.completions, 1);
      assert.deepEqual(a.persisted, { runs: 1, starts: 1, completions: 1 });
      assert.ok(
        timestamp(a.idleOpenedAt) < timestamp(a.acceptedAt) && timestamp(a.acceptedAt) < timestamp(a.finishedAt),
      );
      const late = facts.requests.filter((r) => r.stage === 'late-admission');
      assert.ok(timestamp(a.acceptedAt) >= Math.min(...late.map((r) => timestamp(r.startedAt))));
      assert.ok(Number.isSafeInteger(a.terminalSequence) && a.terminalSequence > 1);
    }
    const replacement = facts.replacement;
    assert.ok(focused ? replacement.before.length >= 2 : replacement.before.length === 2);
    assert.equal(replacement.after.length, 2);
    unique(replacement.before.map(nonempty));
    unique(replacement.after.map(nonempty));
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
    if (!focused || replacement.changed) {
      unique([...replacement.before, ...replacement.after]);
      if (!focused || adopted) overlaps('protected-roll', replacement.dispatchedAt, replacement.observedAt);
    } else {
      assert.ok(adopted, 'First adoption cannot omit proxy replacement');
      assert.deepEqual(operation.previous.images.proxy, operation.candidate.images.proxy);
      assert.deepEqual([...replacement.after].sort(), [...replacement.before].sort());
      assert.equal(replacement.dispatchedAt, undefined);
      assert.equal(replacement.observedAt, undefined);
    }
    if (focused) {
      nonempty(facts.executionWithdrawal?.podUid);
      assert.ok(
        report.outcomes.acceptedWork.some((r) => r.uid === facts.executionWithdrawal?.podUid),
        'Execution withdrawal must belong to an accepted-work owner',
      );
      overlaps('execution-retirement', facts.executionWithdrawal.dispatchedAt, facts.executionWithdrawal.observedAt);
    }
    if (!adopted) overlaps('return-handoff', facts.returnHandoff.dispatchedAt, facts.returnHandoff.observedAt);
    if (focused && !adopted) {
      const dispatched = timestamp(facts.bootstrapHandoff.dispatchedAt),
        settled = timestamp(facts.bootstrapHandoff.settledAt);
      assert.ok(dispatched < settled && settled <= timestamp(report.finishedAt));
      assert.ok(
        timestamp(replacement.dispatchedAt) >= settled &&
          timestamp(replacement.observedAt) >= timestamp(replacement.dispatchedAt) &&
          timestamp(replacement.observedAt) < timestamp(facts.returnHandoff.dispatchedAt),
        'First-adoption proxies must be replaced behind the protected bridge before return handoff',
      );
      assert.ok(
        facts.requests
          .filter((r) => r.stage === 'bootstrap')
          .every(
            (r) =>
              timestamp(r.acceptedAt) <= dispatched &&
              timestamp(r.finishedAt) > dispatched &&
              timestamp(r.finishedAt) <= settled,
          ),
        'Bridge traffic must finish inside the real handoff drain window',
      );
    }
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
  const focused = operation.qualification?.tier === 'focused';
  if (!focused) assertContinuityProviderFacts(autoscaling, operation, 'autoscaling');
  const reports = [upgrade.requestContinuity, ...(!focused ? [autoscaling.requestContinuity] : [])],
    requests = reports.flatMap((r) => r.requests);
  for (const key of ['requestId', 'correlationId', 'recordingId']) unique(requests.map((r) => r[key]));
  return {
    protocol: focused ? 4 : 2,
    ...(focused ? { proxyReplaced: upgrade.requestContinuity.replacement.changed } : {}),
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
    checks: continuityChecks(
      upgrade.requestContinuity.bootstrap === 'already-protected',
      focused ? 'focused' : 'full',
      upgrade.requestContinuity.replacement?.changed,
    ),
    reportSha256: hash(reports),
    bootstrap: upgrade.requestContinuity.bootstrap,
  };
}
