import assert from 'node:assert/strict';

// Only source-owned descriptions enter public CI output. Provider records and
// Kubernetes diagnostics stay private, including any unexpected progress fields.
export const providerSteps = Object.freeze({
  starting: 'provider worker registration',
  prerequisites: 'shared staging prerequisites',
  namespace: 'isolated fixture namespace',
  dependencies: 'database and object-storage readiness',
  routing: 'public route and Service NEG discovery',
  installation: 'exact predecessor installation',
  owners: 'seven ready exact-image application owners',
  frontend: 'public load-balancer health and authenticated routing',
  persistence: 'fixture data and recording preparation',
  oauth: 'synthetic application authentication',
  inventory: 'complete owned-resource inventory',
  authentication: 'existing fixture authentication',
  upgrade: 'protected rolling update and accepted-work completion',
  autoscaling: 'autoscaler regression observations',
  settlement: 'test writer shutdown and accepted-work settlement',
  deletion: 'owned-resource deletion',
  absence: 'namespace, CSI and NEG garbage collection',
  finalization: 'managed command shutdown and durable phase result',
});

export function providerProgressStep(state, phase, workerId, phaseDeadline, now = Date.now) {
  return async (step, action, timeoutMs = 1200000) => {
    assert.ok(Object.hasOwn(providerSteps, step), 'Unknown provider progress step');
    const startedAt = now();
    await state.change((record) => {
      const worker = record.workers.find((w) => w.id === workerId && w.phase === phase);
      assert.ok(worker && !worker.closed, 'Exact active progress worker is required');
      worker.progress = {
        step,
        sequence: (worker.progress?.sequence ?? 0) + 1,
        startedAt,
        deadlineAt: Math.min(phaseDeadline, startedAt + timeoutMs),
      };
    });
    return action();
  };
}

export function observeProviderProgress({
  phase,
  deadlineAt,
  log,
  snapshot,
  intervalMs = 30000,
  stallAfterMs = 120000,
  now = Date.now,
}) {
  let lastProgressAt = now(),
    lastLogAt = -Infinity,
    previous,
    captured = false;
  const snapshots = [];
  const report = async ({ record, worker } = {}) => {
    const current = now(),
      progress = worker?.progress;
    const step =
      typeof progress?.step === 'string' && Object.hasOwn(providerSteps, progress.step) ? progress.step : 'starting';
    const identity = JSON.stringify([worker?.id, worker?.closed, worker?.failed, step, progress?.sequence]);
    if (identity !== previous) {
      previous = identity;
      lastProgressAt = current;
      lastLogAt = -Infinity;
      captured = false;
    }
    const expectedBy =
      Number.isSafeInteger(progress?.deadlineAt) && progress.deadlineAt >= 0
        ? Math.min(progress.deadlineAt, deadlineAt)
        : deadlineAt;
    const reason =
      current >= expectedBy
        ? 'step-deadline'
        : current - lastProgressAt >= stallAfterMs
          ? 'no-step-progress'
          : undefined;
    const status = {
      phase,
      step,
      waitingFor: providerSteps[step],
      state: worker?.failed ? 'failed' : worker?.closed ? 'worker-closed' : worker ? 'running' : 'awaiting-worker',
      lastProgressAt: new Date(lastProgressAt).toISOString(),
      deadlineAt: new Date(expectedBy).toISOString(),
      ...(reason && !worker?.closed ? { diagnostic: reason } : {}),
    };
    if (reason && !worker?.closed && !captured) {
      captured = true;
      log(status); // Report before diagnostic reads or evidence upload can wait.
      lastLogAt = current;
      // Diagnostic reads must not hold up actor liveness or receipt recovery.
      snapshots.push(
        Promise.resolve()
          .then(() => snapshot({ status, record, worker }))
          .catch(() => log({ ...status, diagnostic: 'snapshot-incomplete' })),
      );
    } else if (current - lastLogAt >= intervalMs) {
      log(status);
      lastLogAt = current;
    }
  };
  report.flush = () => Promise.all(snapshots);
  return report;
}
