import { randomUUID } from 'node:crypto';
import { CONTINUITY_DURATION_STAGES, continuityStages } from '../lib/request-continuity.mjs';

export const continuityFixtureProfile = {
  protocol: 1,
  maxProtectedRequestSeconds: 300,
  backendServiceDrainSeconds: 360,
  propagationSeconds: 60,
  proxyPreStopDelaySeconds: 420,
  proxyTerminationGracePeriodSeconds: 600,
};
const profile = continuityFixtureProfile;

export function continuityProviderFacts() {
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
