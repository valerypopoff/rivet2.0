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

export function focusedContinuityProviderFacts({ adopted = false, proxyReplaced = true } = {}) {
  const f = continuityProviderFacts();
  f.operation.qualification = {
    protocol: 2,
    tier: 'focused',
    safetyDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
  };
  if (adopted)
    f.operation.installed.qualificationValues = {
      requestContinuity: {
        enabled: true,
        maxProtectedRequestSeconds: 300,
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
  const facts = f.upgrade.requestContinuity;
  facts.protocol = 4;
  facts.bootstrap = adopted ? 'already-protected' : 'passed';
  facts.replacement.changed = proxyReplaced;
  facts.replacement.deploymentUid = 'proxy-deployment';
  if (!proxyReplaced) {
    f.operation.previous = { images: { ...f.operation.candidate.images } };
    facts.replacement.after = [...facts.replacement.before];
    delete facts.replacement.dispatchedAt;
    delete facts.replacement.observedAt;
  }
  const stages = continuityStages(adopted, 'upgrade', 'focused', proxyReplaced);
  facts.requests = facts.requests.filter((r) => stages.includes(r.stage));
  delete facts.action;
  const order = [
    ...(!adopted ? ['bootstrap'] : proxyReplaced ? ['protected-roll'] : []),
    'execution-retirement',
    ...(!adopted ? ['return-handoff'] : []),
  ];
  const start = Date.now() - order.length * 400000 - 100000;
  const date = (offset) => new Date(start + offset).toISOString();
  f.upgrade.startedAt = date(0);
  f.upgrade.finishedAt = date(order.length * 400000);
  for (const r of facts.requests) {
    const offset = order.indexOf(r.stage) * 400000;
    r.startedAt = date(offset + 2000);
    r.acceptedAt = date(offset + 2500);
    r.finishedAt = date(offset + 302000);
  }
  f.upgrade.outcomes.acceptedWork.forEach((r, i) => {
    r.uid = `execution-owner${i || ''}`;
  });
  const retirement = order.indexOf('execution-retirement') * 400000;
  facts.executionWithdrawal = {
    podUid: 'execution-owner',
    dispatchedAt: date(retirement + 4000),
    observedAt: date(retirement + 5000),
  };
  if (proxyReplaced) {
    facts.replacement.dispatchedAt = date(adopted ? 4000 : 365000);
    facts.replacement.observedAt = date(adopted ? 5000 : 366000);
  }
  if (!adopted) {
    facts.bootstrapHandoff = {
      dispatchedAt: date(4000),
      settledAt: date(362000),
    };
    const returning = order.indexOf('return-handoff') * 400000;
    facts.returnHandoff = { dispatchedAt: date(returning + 4000), observedAt: date(returning + 5000) };
  } else delete facts.returnHandoff;
  delete f.autoscaling.requestContinuity;
  return f;
}
