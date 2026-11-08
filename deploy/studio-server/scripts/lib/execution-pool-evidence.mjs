import assert from 'node:assert/strict';
import { executionPoolLimit } from './execution-autoscaler.mjs';

export function assertExecutionPoolEvidence(value) {
  assert.equal(value?.protocol, 1, 'Paired execution needs its own qualified transition');
  const ownerCount = value.acceptedOwners?.length;
  assert.ok(Number.isSafeInteger(ownerCount) && ownerCount >= 2 && ownerCount <= 50);
  assert.equal(value.parallelAcceptedWork, true);
  assert.equal(value.previousPoolRemoved, true);
  assert.ok(Number.isSafeInteger(value.minimumReady) && value.minimumReady >= ownerCount);
  assert.ok(Number.isSafeInteger(value.maxReplicas) && value.maxReplicas >= 4 && value.maxReplicas <= 100);
  assert.ok(
    Number.isSafeInteger(value.maximumPhysicalPods) &&
      value.maximumPhysicalPods >= 2 * ownerCount &&
      value.maximumPhysicalPods <= value.maxReplicas,
  );
  assert.equal(new Set(value.acceptedOwners.map((owner) => owner.uid)).size, ownerCount);
  for (const key of ['correlationId', 'recordingId'])
    assert.equal(new Set(value.acceptedOwners.map((owner) => owner[key])).size, ownerCount);
  for (const owner of value.acceptedOwners)
    for (const key of ['uid', 'correlationId', 'recordingId']) assert.ok(typeof owner[key] === 'string' && owner[key]);
  return structuredClone(value);
}

export function compileExecutionPoolEvidence(report, operation) {
  const state = report.outcomes?.executionPool,
    accepted = report.outcomes?.acceptedWork;
  assert.equal(state?.protocol, 1);
  assert.equal(state.phase, 'complete');
  assert.equal(state.plan.maxReplicas, executionPoolLimit(operation.policy));
  assert.equal(
    state.plan.image,
    `${operation.candidate.images.api.repository}@${operation.candidate.images.api.digest}`,
  );
  const ownerCount = state.plan.previous.replicas;
  assert.ok(Number.isSafeInteger(ownerCount) && ownerCount >= 2);
  assert.ok(state.candidateUid && state.scaleIssued);
  if (state.legacyHttp) {
    assert.equal(state.legacyHttp.protocol, 1);
    assert.equal(typeof state.legacyHttp.required, 'boolean');
    if (state.legacyHttp.required)
      for (const flag of ['routeIssued', 'settled', 'restoreIssued'])
        assert.equal(state.legacyHttp[flag], true, 'Legacy HTTP handoff is incomplete');
  }
  assert.equal(state.owners.length, ownerCount);
  assert.equal(accepted?.length, ownerCount);
  assert.deepEqual(
    new Set(state.owners.map((owner) => owner.uid)),
    new Set(accepted.map((run) => run.uid)),
    'Accepted work must belong to all recorded original owners',
  );
  for (const owner of state.owners) {
    assert.ok(owner.withdrawIssued && owner.beginIssued && owner.probeDone);
    assert.ok(accepted.some((run) => run.uid === owner.uid));
  }
  const starts = accepted.map((run) => Date.parse(run.acceptedAt)),
    ends = accepted.map((run) => Date.parse(run.completedAt));
  assert.ok(starts.every(Number.isFinite) && ends.every(Number.isFinite));
  assert.ok(starts.every((start, index) => ends[index] > start));
  assert.ok(Math.max(...starts) < Math.min(...ends), 'Accepted long work must overlap across the replacement batch');
  return assertExecutionPoolEvidence({
    protocol: 1,
    parallelAcceptedWork: true,
    previousPoolRemoved: true,
    maxReplicas: state.plan.maxReplicas,
    ...state.capacity,
    acceptedOwners: accepted.map(({ uid, correlationId, recordingId }) => ({ uid, correlationId, recordingId })),
  });
}
