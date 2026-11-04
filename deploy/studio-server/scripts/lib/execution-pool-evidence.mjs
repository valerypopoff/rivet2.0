import assert from 'node:assert/strict';

export function assertExecutionPoolEvidence(value) {
  assert.equal(value?.protocol, 1, 'Paired execution needs its own qualified transition');
  assert.equal(value.parallelAcceptedWork, true);
  assert.equal(value.previousPoolRemoved, true);
  assert.ok(Number.isSafeInteger(value.minimumReady) && value.minimumReady >= 2);
  assert.ok(Number.isSafeInteger(value.maxReplicas) && value.maxReplicas >= 4 && value.maxReplicas <= 100);
  assert.ok(
    Number.isSafeInteger(value.maximumPhysicalPods) &&
      value.maximumPhysicalPods >= 4 &&
      value.maximumPhysicalPods <= value.maxReplicas,
  );
  assert.equal(value.acceptedOwners?.length, 2);
  assert.equal(new Set(value.acceptedOwners.map((owner) => owner.uid)).size, 2);
  for (const key of ['correlationId', 'recordingId'])
    assert.equal(new Set(value.acceptedOwners.map((owner) => owner[key])).size, 2);
  for (const owner of value.acceptedOwners)
    for (const key of ['uid', 'correlationId', 'recordingId']) assert.ok(typeof owner[key] === 'string' && owner[key]);
  return structuredClone(value);
}

export function compileExecutionPoolEvidence(report, operation) {
  const state = report.outcomes?.executionPool,
    accepted = report.outcomes?.acceptedWork;
  assert.equal(state?.protocol, 1);
  assert.equal(state.phase, 'complete');
  assert.equal(state.plan.maxReplicas, operation.policy.maxReplicas);
  assert.equal(
    state.plan.image,
    `${operation.candidate.images.api.repository}@${operation.candidate.images.api.digest}`,
  );
  assert.equal(state.plan.previous.replicas, 2);
  assert.ok(state.candidateUid && state.scaleIssued);
  assert.equal(state.owners.length, 2);
  assert.equal(accepted?.length, 2);
  assert.deepEqual(
    new Set(state.owners.map((owner) => owner.uid)),
    new Set(accepted.map((run) => run.uid)),
    'Accepted work must belong to both recorded original owners',
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
