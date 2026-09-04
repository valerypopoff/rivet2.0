import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublishedExecutionAdmission,
  getPublishedExecutionAdmissionConfig,
  toPublishedExecutionAdmissionError,
} from '../published-execution-admission.js';

test('enforced published execution admission rejects without queueing and releases a completed permit once', () => {
  const admission = createPublishedExecutionAdmission({
    maxActiveRuns: 1,
    mode: 'enforce',
    retryAfterSeconds: 7,
  });

  const first = admission.acquire('workflow-endpoint');
  assert.equal(first.kind, 'accepted');
  if (first.kind !== 'accepted') return;

  const rejected = admission.acquire('web-app-action');
  assert.equal(rejected.kind, 'capacity-exceeded');
  if (rejected.kind !== 'capacity-exceeded') return;
  const error = toPublishedExecutionAdmissionError(rejected);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'execution_capacity_exceeded');
  assert.equal(error.retryAfterSeconds, 7);
  assert.equal(admission.getSnapshot().activeRuns, 1);

  first.permit.release();
  first.permit.release();
  assert.equal(admission.getSnapshot().activeRuns, 0);
  assert.equal(admission.acquire('workflow-endpoint').kind, 'accepted');
});

test('observe mode reports only threshold crossings while continuing work', () => {
  const events: string[] = [];
  const admission = createPublishedExecutionAdmission(
    { maxActiveRuns: 1, mode: 'observe', retryAfterSeconds: 1 },
    { onEvent: (event) => events.push(event.type) },
  );

  const first = admission.acquire('workflow-endpoint');
  const second = admission.acquire('workflow-endpoint');
  const third = admission.acquire('web-app-action');
  assert.equal(first.kind, 'accepted');
  assert.equal(second.kind, 'accepted');
  assert.equal(third.kind, 'accepted');
  assert.deepEqual(events, ['observe-over-capacity']);

  if (second.kind === 'accepted') second.permit.release();
  if (third.kind === 'accepted') third.permit.release();
  if (first.kind === 'accepted') first.permit.release();
  const fourth = admission.acquire('workflow-endpoint');
  const fifth = admission.acquire('workflow-endpoint');
  assert.equal(fourth.kind, 'accepted');
  assert.equal(fifth.kind, 'accepted');
  assert.deepEqual(events, ['observe-over-capacity', 'observe-over-capacity']);
});

test('draining rejects even when admission mode is disabled', () => {
  const admission = createPublishedExecutionAdmission({
    maxActiveRuns: 1,
    mode: 'disabled',
    retryAfterSeconds: 3,
  });

  assert.equal(admission.acquire('workflow-endpoint').kind, 'accepted');
  admission.beginDrain();
  const rejected = admission.acquire('workflow-endpoint');
  assert.equal(rejected.kind, 'draining');
  if (rejected.kind !== 'draining') return;
  assert.equal(toPublishedExecutionAdmissionError(rejected).status, 503);
  assert.equal(toPublishedExecutionAdmissionError(rejected).code, 'execution_draining');
});

test('environment configuration is strict when a non-disabled mode is selected', () => {
  assert.deepEqual(
    getPublishedExecutionAdmissionConfig({
      RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'observe',
      RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS: '8',
      RIVET_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS: '2',
    }),
    { maxActiveRuns: 8, mode: 'observe', retryAfterSeconds: 2 },
  );
  assert.throws(
    () => getPublishedExecutionAdmissionConfig({ RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'enforce' }),
    /RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS is required/,
  );
  assert.throws(
    () => getPublishedExecutionAdmissionConfig({ RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'queue' }),
    /must be disabled, observe, or enforce/,
  );
});
test('enforced admission reports each saturation period once and reports again after capacity reopens', () => {
  const events: string[] = [];
  const admission = createPublishedExecutionAdmission(
    { maxActiveRuns: 1, mode: 'enforce', retryAfterSeconds: 1 },
    { onEvent: (event) => events.push(event.type) },
  );

  const first = admission.acquire('workflow-endpoint');
  assert.equal(first.kind, 'accepted');
  assert.equal(admission.acquire('workflow-endpoint').kind, 'capacity-exceeded');
  assert.equal(admission.acquire('web-app-action').kind, 'capacity-exceeded');
  assert.deepEqual(events, ['capacity-exceeded']);

  if (first.kind === 'accepted') first.permit.release();
  const second = admission.acquire('web-app-action');
  assert.equal(second.kind, 'accepted');
  assert.equal(admission.acquire('workflow-endpoint').kind, 'capacity-exceeded');
  assert.deepEqual(events, ['capacity-exceeded', 'capacity-exceeded']);
  if (second.kind === 'accepted') second.permit.release();
});
test('draining reports once while consistently rejecting new public work', () => {
  const events: string[] = [];
  const admission = createPublishedExecutionAdmission(
    { maxActiveRuns: 1, mode: 'disabled', retryAfterSeconds: 1 },
    { onEvent: (event) => events.push(event.type) },
  );

  admission.beginDrain();
  assert.equal(admission.acquire('workflow-endpoint').kind, 'draining');
  assert.equal(admission.acquire('web-app-action').kind, 'draining');
  assert.deepEqual(events, ['draining']);
});
test('admission snapshots expose fixed public surfaces and never change permit decisions when observers fail', () => {
  const decisions: string[] = [];
  const snapshots: Array<{ activeRuns: number; webApps: number; workflows: number }> = [];
  const admission = createPublishedExecutionAdmission(
    { maxActiveRuns: 2, mode: 'enforce', retryAfterSeconds: 1 },
    {
      onDecision: (decision) => decisions.push(`${decision.kind}:${decision.surface}`),
      onSnapshot: (snapshot) =>
        snapshots.push({
          activeRuns: snapshot.activeRuns,
          webApps: snapshot.activeRunsBySurface['web-app-action'],
          workflows: snapshot.activeRunsBySurface['workflow-endpoint'],
        }),
      onEvent: () => {
        throw new Error('observability must not alter admission');
      },
    },
  );

  const workflow = admission.acquire('workflow-endpoint');
  const webApp = admission.acquire('web-app-action');
  assert.equal(workflow.kind, 'accepted');
  assert.equal(webApp.kind, 'accepted');
  assert.equal(admission.acquire('workflow-endpoint').kind, 'capacity-exceeded');
  assert.deepEqual(decisions, [
    'accepted:workflow-endpoint',
    'accepted:web-app-action',
    'capacity-exceeded:workflow-endpoint',
  ]);
  assert.deepEqual(snapshots.at(-1), { activeRuns: 2, webApps: 1, workflows: 1 });

  if (workflow.kind === 'accepted') workflow.permit.release();
  if (webApp.kind === 'accepted') webApp.permit.release();
  assert.deepEqual(admission.getSnapshot().activeRunsBySurface, {
    'web-app-action': 0,
    'workflow-endpoint': 0,
  });
});
