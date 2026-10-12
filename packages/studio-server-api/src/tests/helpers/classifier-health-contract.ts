import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RivetStudioLLMProfileHealthStore } from '../../llm-profile-health/store.js';

/** Run against actual SQLite connections and PostgreSQL pools, not SQL-string mocks. */
export async function verifyClassifierHealthContract(stores: readonly RivetStudioLLMProfileHealthStore[]) {
  const projectId = `health-contract-${randomUUID()}` as never;
  const identity = {
    key: `classifier-profile:${randomUUID()}`,
    family: 'classifier' as const,
    projectId,
    profileNodeId: 'profile' as never,
    provider: 'liquid',
    model: 'd1',
    configurationFingerprint: 'sha256:fixture',
  };
  const llm = { ...identity, key: `llm-profile:${randomUUID()}`, family: 'llm' as const };
  const policy = { failureThreshold: 1, failureWindowMs: 60_000, openDurationMs: 1000, halfOpenLeaseMs: 10_000 };
  const store = stores[0]!;
  const correlationId = randomUUID();
  const recordingId = randomUUID();
  try {
    await store.begin({ identity: llm, policy });
    const permits = await Promise.all(
      Array.from({ length: 8 }, (_, i) => stores[i % stores.length]!.begin({ identity, policy })),
    );
    assert.ok(permits.every((permit) => permit.disposition === 'allow'));
    const suspended = await store.finish({
      identity,
      policy,
      permitId: permits[0]!.permitId!,
      outcome: 'unhealthy',
      executionCorrelationId: correlationId,
    });
    assert.equal(suspended.state, 'open');
    await store.recordRecordingOutcome({ correlationId, recordingId, availability: 'available' });
    const admin = await store.listAdmin({ projectId, family: 'classifier' });
    assert.equal(admin.length, 1);
    assert.equal(admin[0]!.contributingRuns[0]!.recordingId, recordingId);
    assert.equal(admin[0]!.contributingRuns[0]!.triggeredSuspension, true);
    assert.equal(await store.resetProjectKey(projectId, llm.key, 'classifier'), false);
    // PostgreSQL owns its clock; the Docker host or a remote executor may have
    // a different wall clock. Wait the store-reported duration, not a local
    // comparison against its absolute timestamp.
    await delay(Math.max(0, suspended.openUntil! - suspended.updatedAt) + 20);
    const recovery = await Promise.all(
      Array.from({ length: 8 }, (_, i) => stores[i % stores.length]!.begin({ identity, policy })),
    );
    const allowed = recovery.filter((permit) => permit.disposition === 'allow');
    assert.equal(allowed.length, 1, 'Only one replica owns recovery');
    const renewed = await store.renew!({ identity, permitId: allowed[0]!.permitId!, leaseDurationMs: 20_000 });
    assert.equal(renewed.state, 'half-open');
    await store.finish({ identity, policy, permitId: allowed[0]!.permitId!, outcome: 'healthy' });
    for (const permit of permits.slice(1))
      await store.finish({ identity, policy, permitId: permit.permitId!, outcome: 'unhealthy' });
    assert.equal(
      (await store.list({ projectId, family: 'classifier' }))[0]!.failureCount,
      0,
      'Old failures cannot reopen recovered state',
    );
    const late = await store.begin({ identity, policy });
    await store.reset({ projectId, family: 'classifier' });
    await store.finish({ identity, policy, permitId: late.permitId!, outcome: 'unhealthy' });
    assert.equal((await store.list({ projectId, family: 'classifier' })).length, 0);
    assert.equal((await store.list({ projectId, family: 'llm' })).length, 1);
  } finally {
    await store.reset({ projectId });
  }
}
