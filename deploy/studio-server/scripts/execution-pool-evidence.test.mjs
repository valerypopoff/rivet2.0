import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExecutionPoolEvidence, assertExecutionPoolEvidence } from './lib/execution-pool-evidence.mjs';
import { executionPoolSettled } from './lib/release-operation-state.mjs';

function fixture(count = 2) {
  const operation = {
    policy: { maxReplicas: Math.max(7, count * 2) },
    candidate: { images: { api: { repository: 'registry/api', digest: 'sha256:fixture' } } },
  };
  const plan = {
    protocol: 1,
    maxReplicas: operation.policy.maxReplicas,
    image: 'registry/api@sha256:fixture',
    previous: { replicas: count },
  };
  const owners = Array.from({ length: count }, (_, index) => ({
    uid: 'owner-' + index,
    withdrawIssued: true,
    beginIssued: true,
    probeDone: true,
  }));
  const accepted = owners.map((owner, index) => ({
    uid: owner.uid,
    correlationId: 'correlation-' + index,
    recordingId: 'recording-' + index,
    acceptedAt: new Date(1000 + index * 500).toISOString(),
    completedAt: new Date(320000 + index * 500).toISOString(),
  }));
  return {
    operation,
    report: {
      outcomes: {
        acceptedWork: accepted,
        executionPool: {
          protocol: 1,
          phase: 'complete',
          plan,
          owners,
          candidateUid: 'new-controller',
          scaleIssued: true,
          capacity: { minimumReady: count, maximumPhysicalPods: 2 * count },
        },
      },
    },
  };
}

test('pool qualification proves overlapping accepted work, distinct recordings and actual capacity', () => {
  const f = fixture();
  const proof = compileExecutionPoolEvidence(f.report, f.operation);
  assert.equal(proof.maximumPhysicalPods, 4);
  for (const patch of [
    { minimumReady: 1 },
    { maximumPhysicalPods: 8 },
    { previousPoolRemoved: false },
    { acceptedOwners: [proof.acceptedOwners[0], proof.acceptedOwners[0]] },
  ])
    assert.throws(() => assertExecutionPoolEvidence({ ...proof, ...patch }));
  f.report.outcomes.acceptedWork[1].acceptedAt = new Date(400000).toISOString();
  f.report.outcomes.acceptedWork[1].completedAt = new Date(720000).toISOString();
  assert.throws(() => compileExecutionPoolEvidence(f.report, f.operation), /must overlap/);
});

test('an incomplete or stray pool journal cannot be treated as a completed release', () => {
  const { report } = fixture(),
    executionPool = report.outcomes.executionPool;
  assert.equal(executionPoolSettled({}), true);
  assert.equal(executionPoolSettled({ executionPool }), false);
  assert.equal(
    Boolean(
      executionPoolSettled({ executionPoolPlan: executionPool.plan, abortedBeforeTemplates: true, completed: [] }),
    ),
    true,
  );
  assert.equal(Boolean(executionPoolSettled({ executionPool, executionPoolPlan: executionPool.plan })), true);
  assert.equal(
    Boolean(
      executionPoolSettled({
        executionPool: { ...executionPool, phase: 'draining' },
        executionPoolPlan: executionPool.plan,
      }),
    ),
    false,
  );
});

test('a duplicated recorded owner cannot borrow the other job receipt to qualify a pool handoff', () => {
  const f = fixture();
  f.report.outcomes.executionPool.owners[1] = f.report.outcomes.executionPool.owners[0];
  assert.throws(() => compileExecutionPoolEvidence(f.report, f.operation), /all recorded original owners/);
});

test('a legacy handoff cannot qualify before both routing and restoration are confirmed', () => {
  const complete = { protocol: 1, required: true, routeIssued: true, settled: true, restoreIssued: true };
  for (const flag of ['routeIssued', 'settled', 'restoreIssued']) {
    const f = fixture();
    f.report.outcomes.executionPool.legacyHttp = { ...complete, [flag]: false };
    assert.throws(() => compileExecutionPoolEvidence(f.report, f.operation), /Legacy HTTP handoff is incomplete/);
  }
  for (const legacyHttp of [complete, { protocol: 1, required: false }]) {
    const f = fixture();
    f.report.outcomes.executionPool.legacyHttp = legacyHttp;
    compileExecutionPoolEvidence(f.report, f.operation);
  }
});

for (const count of [3, 4, 7])
  test(`evidence covers every original owner in a ${count}-worker parallel handoff`, () => {
    const f = fixture(count);
    const proof = compileExecutionPoolEvidence(f.report, f.operation);
    assert.equal(proof.acceptedOwners.length, count);
    assert.equal(
      executionPoolSettled({
        executionPoolPlan: f.report.outcomes.executionPool.plan,
        executionPool: f.report.outcomes.executionPool,
      }),
      true,
    );
    assert.throws(() => assertExecutionPoolEvidence({ ...proof, maximumPhysicalPods: 2 * count - 1 }));
    f.report.outcomes.acceptedWork.pop();
    assert.throws(() => compileExecutionPoolEvidence(f.report, f.operation));
  });
