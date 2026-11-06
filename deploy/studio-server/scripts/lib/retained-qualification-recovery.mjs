import assert from 'node:assert/strict';
import {
  assertOrdinaryProviderReport,
  assertQualificationGuard,
  executeRuntimeQualification,
  qualificationHash,
} from './runtime-qualification-execution.mjs';
import { compileRequestContinuityEvidence } from './request-continuity-evidence.mjs';

export function assertRetainedRecoveryArchive(operation, archive) {
  const { inputHash, ...input } = operation;
  assert.equal(qualificationHash(input), inputHash);
  assert.ok(operation.retainedApplication && !operation.sizingRequests && !operation.developerOverlapProfile);
  assert.equal(operation.qualification?.tier, 'focused');
  const terminal = archive.terminal;
  assert.equal(terminal.operationId, operation.operationId);
  assert.equal(terminal.inputHash, operation.inputHash);
  assert.equal(terminal.phase, 'terminal');
  assert.equal(terminal.outcome, 'failed');
  assert.equal(terminal.cleanupVerified, false);
  assert.equal(terminal.failedPhase, undefined, 'Failed rollout/report validation cannot be recovered as cleanup');
  assertQualificationGuard(archive.armExpiry, operation);
  for (const receipt of [archive.prepare, archive.upgrade])
    for (const key of ['protocol', 'operationId', 'inputHash', 'projectId', 'projectNumber'])
      assert.equal(receipt[key], operation[key]);
  assert.equal(archive.prepare.expiryIdentity, archive.armExpiry.identity);
  assert.equal(archive.prepare.stagingClusterUid, operation.staging.clusterUid);
  assert.equal(archive.prepare.inventoryComplete, true);
  assert.deepEqual(archive.prepare.inventory, [], 'Recovery is limited to the retained application');
  assert.ok(archive.prepare.retainedApplication?.namespaceUid);
  assert.equal(qualificationHash(archive.upgrade), archive.reportSha256, 'Archived rollout report changed');
  assertOrdinaryProviderReport(archive.upgrade, operation);
  compileRequestContinuityEvidence(operation, archive.upgrade, archive.upgrade);
}

/** Revalidate original observation receipts; only cleanup methods may act.
 * Original timestamps/deadlines and the failed workflow remain unchanged. */
export async function recoverRetainedQualification(operation, archive, cleanup, persist, options) {
  assertRetainedRecoveryArchive(operation, archive);
  const cached = (name) => async () => structuredClone(archive[name]);
  return executeRuntimeQualification(
    operation,
    {
      armExpiry: cached('armExpiry'),
      prepare: cached('prepare'),
      upgrade: cached('upgrade'),
      settle: (...args) => cleanup.settle(...args),
      cleanup: (...args) => cleanup.cleanup(...args),
      verifyCleanup: (...args) => cleanup.verifyCleanup(...args),
    },
    persist,
    options,
  );
}

/** Operator-only recovery of an already settled quarantine. The shared cloud
 * operation lock must be held by the caller before inspecting or beginning it. */
export async function inspectRetainedCleanupRecovery(state, archive, { deadlineAt, now = Date.now() }) {
  assertRetainedRecoveryArchive(state.operation, archive);
  assert.ok(Number.isSafeInteger(deadlineAt) && deadlineAt > now && deadlineAt <= now + 3600000);
  assert.ok(
    deadlineAt <= Date.parse(state.operation.expiresAt),
    'Recovery cannot extend the original operation window',
  );
  const { object, record } = await state.read(),
    application = await state.application.read();
  assert.equal(object.metadata.uid, archive.armExpiry.identity);
  assert.ok(record.closed && record.cleanupVerified && record.acceptedWorkSettled);
  assert.equal(record.phase, 'cleaned');
  assert.equal(record.retainedCleanup?.phase, 'quarantined');
  assert.equal(record.retainedCleanup.healthy, false);
  assert.ok(!record.retainedRecovery, 'Recovery already has an intent; inspect without replay');
  assert.ok(record.workers.length && record.workers.every((w) => w.closed));
  assert.ok(record.workers.some((w) => w.phase === 'settle' && w.failed));
  assert.ok(record.workers.every((w) => !w.failed || w.phase === 'settle'));
  for (const phase of ['prepare', 'upgrade']) assert.equal(record.testPhases?.[phase]?.state, 'acknowledged');
  assert.ok(record.processes.every((p) => p.state === 'settled'));
  assert.ok(
    record.fixtureFolder && !record.fixtureFolderDelete && !record.fixtureProjects && !record.fixtureProjectWrites,
  );
  assert.equal(record.namespaceUid, archive.prepare.retainedApplication.namespaceUid);
  assert.equal((await state.namespace())?.metadata.uid, record.namespaceUid);
  for (const resource of [
    `/apis/batch/v1/namespaces/${state.settings.runnerNamespace}/jobs/${state.operation.operationId}`,
    `/api/v1/namespaces/${record.actor.namespace}/pods/${record.actor.name}`,
  ])
    assert.ok(!(await state.api.json('GET', resource)), 'Original actor must be physically absent');
  assert.equal(application.object.metadata.uid, record.retainedApplication.uid);
  assert.equal(application.record.nonce, record.creationNonce);
  assert.equal(application.record.namespaceUid, record.namespaceUid);
  assert.equal(application.record.phase, 'quarantined');
  assert.ok(!application.record.owner);
  assert.equal(application.record.lastOperationId, state.operation.operationId);
  assert.equal(application.record.lastReceipt.healthy, false);
  return {
    protocol: 1,
    operationId: state.operation.operationId,
    inputHash: state.operation.inputHash,
    reportSha256: archive.reportSha256,
    candidateManifestDigest: state.operation.candidateManifestDigest,
    registryUid: object.metadata.uid,
    registryHash: qualificationHash(record),
    applicationUid: application.object.metadata.uid,
    applicationResourceVersion: application.object.metadata.resourceVersion,
    namespaceUid: record.namespaceUid,
    deadlineAt,
  };
}

export async function beginRetainedCleanupRecovery(state, archive, plan, { now = Date.now(), persistIntent }) {
  assert.equal(typeof persistIntent, 'function');
  const current = await inspectRetainedCleanupRecovery(state, archive, { deadlineAt: plan.deadlineAt, now });
  assert.deepEqual(current, plan, 'Recovery identities changed after inspection');
  await persistIntent(plan);
  const application = await state.application.read();
  assert.equal(application.object.metadata.resourceVersion, plan.applicationResourceVersion);
  await state.change((record) => {
    assert.equal(qualificationHash(record), plan.registryHash);
    record.retainedRecovery = {
      ...plan,
      startedAt: new Date(now).toISOString(),
      previousCleanup: record.retainedCleanup,
    };
    record.phase = 'settled';
    record.cleanupVerified = false;
    delete record.retainedCleanup;
  });
  await state.application.change((record) => {
    assert.equal(record.phase, 'quarantined');
    assert.ok(!record.owner);
    record.phase = 'owned';
    record.owner = { operationId: plan.operationId, inputHash: plan.inputHash, registryUid: plan.registryUid };
  }, application.object);
}
