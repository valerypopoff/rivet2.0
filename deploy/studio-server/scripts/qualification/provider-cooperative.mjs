import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ready, role, until, sleep } from './provider-gate.mjs';
import { publishBackground, startOwnedBackground, settleOwnedBackground } from './load-fixtures.mjs';

export function assertCooperativeBinding(record, { workload, uid, image, policyDigest, token }) {
  assert.equal(record.protocol, 1);
  assert.equal(record.phase, 'owners');
  assert.equal(record.cooperativeScaling?.protocol, 1);
  assert.equal(record.cooperativeScaling.workload, workload);
  assert.equal(record.cooperativeScaling.uid, uid);
  assert.equal(record.cooperativeScaling.image, image);
  assert.equal(record.cooperativeScaling.policyDigest, policyDigest);
  assert.ok(typeof record.token === 'string' && record.token.length > 0);
  if (token !== undefined) assert.equal(record.token, token);
  assert.equal(record.owner?.withdrawIssued, undefined);
  assert.equal(record.owner?.beginIssued, false);
  assert.ok(record.owner?.uid && record.owner?.incarnation && record.owner?.operationId);
}

/** Real provider-only scenario. Intentional pause is before any retirement
 * command. Preserve the actual journal token and wait for its real lease to
 * expire; never edit the journal, fake the clock or replay an execution POST. */
export async function runCooperativeProvider(
  gate,
  { policy, policyDigest, accepted, readJournal, workers, snapshot, settledTwo },
) {
  assert.equal(gate.singleton, true);
  assert.equal(gate.profile, 'compact');
  assert.equal(gate.controllerEnabled, true);
  await settledTwo();
  const workload = gate.config.release + '-ha-execution';
  const image = gate.config.images.api.repository + '@' + gate.config.images.api.digest;
  const initial = await snapshot();
  assert.equal(initial.replicas, 2);
  const binding = { workload, uid: initial.uid, image, policyDigest };
  const project = await publishBackground(gate, 'slots', 360000, 'cooperative-upgrade');
  const pause = new Error('Deliberate isolated runner pause before first execution withdrawal');
  let active,
    pausedOwner,
    invoked = false;
  gate.executionRollMarker = randomUUID();
  try {
    await gate.roll(gate.config.images, true, {
      beforeRetirement: async (pod) => {
        if (!pod.name.startsWith(workload + '-')) return;
        assert.equal(invoked, false);
        invoked = true;
        const record = await readJournal();
        assertCooperativeBinding(record, binding);
        assert.ok(record.leaseExpiresAt > Date.now());
        assert.equal(record.owner.uid, pod.uid);
        binding.token = record.token;
        pausedOwner = { ...record.owner };
        const before = await snapshot();
        for (const worker of (await workers()).filter(ready))
          await startOwnedBackground(gate, worker, project, 3, accepted);
        const grown = await until(
          'real controller grows capacity while the upgrade owns its live lease',
          async () => {
            const current = await snapshot(),
              now = await readJournal();
            assertCooperativeBinding(now, binding);
            assert.ok(
              now.leaseExpiresAt > Date.now(),
              'active-lease proof cannot be inferred from an expired operation',
            );
            return current.replicas > before.replicas && current.pods.every((p) => p.ready) ? current : null;
          },
          600000,
        );
        active = {
          from: before.replicas,
          to: grown.replicas,
          token: record.token,
          workloadUid: initial.uid,
          ownerUid: pod.uid,
          observedAt: new Date().toISOString(),
        };
        await gate.artifact('cooperative-active-growth.json', JSON.stringify(active));
        throw pause;
      },
    });
    assert.fail('the deliberately paused rollout unexpectedly completed');
  } catch (error) {
    assert.equal(error, pause, 'a real upgrade failure cannot be reclassified as the planned pause');
  }
  assert.ok(invoked && active && pausedOwner);
  await until(
    'original updater lease really expires after the intentional pause',
    async () => {
      const record = await readJournal();
      assertCooperativeBinding(record, binding);
      return record.leaseExpiresAt <= Date.now();
    },
    180000,
  );
  const beforePaused = await snapshot();
  assert.ok(beforePaused.replicas < policy.maxReplicas, 'leave genuine capacity for the paused-upgrade growth proof');
  for (const worker of (await workers()).filter(ready)) await startOwnedBackground(gate, worker, project, 3, accepted);
  const pausedGrowth = await until(
    'real controller adds capacity while the updater is absent',
    async () => {
      const record = await readJournal(),
        current = await snapshot();
      assertCooperativeBinding(record, binding);
      assert.ok(record.leaseExpiresAt <= Date.now());
      return current.replicas > beforePaused.replicas && current.pods.every((p) => p.ready) ? current : null;
    },
    600000,
  );
  const protectedUids = (await workers()).map((p) => p.metadata.uid);
  await settleOwnedBackground(gate, accepted);
  const idleStartedAt = Date.now();
  const observationMs = (policy.stabilizationSeconds + policy.cooldownSeconds) * 1000;
  while (Date.now() - idleStartedAt < observationMs) {
    const record = await readJournal(),
      current = await snapshot();
    assertCooperativeBinding(record, binding);
    assert.equal(current.replicas, pausedGrowth.replicas, 'unfinished upgrade must not permit automatic shrink');
    const present = (await workers()).map((p) => p.metadata.uid);
    assert.deepEqual([...present].sort(), [...protectedUids].sort(), 'paused upgrade owner/capacity changed');
    assert.ok(present.includes(pausedOwner.uid));
    await sleep(5000);
  }
  const paused = {
    from: beforePaused.replicas,
    to: pausedGrowth.replicas,
    token: binding.token,
    ownerUid: pausedOwner.uid,
    scaleDownSuppressedMs: observationMs,
    acceptedWorkRecorded: true,
    observedAt: new Date().toISOString(),
  };
  await gate.artifact('cooperative-paused-growth.json', JSON.stringify(paused));
  const result = await gate.roll(gate.config.images, true, { resumeToken: binding.token });
  assert.equal(result.token, binding.token);
  assert.equal(result.phase, 'complete');
  await settledTwo();
  const developers = (await gate.pods()).filter((p) => ['backend', 'web'].includes(role(p)));
  assert.equal(developers.length, 2);
  assert.ok(developers.every(ready));
  return {
    source: gate.manifest.source.sha,
    active,
    paused,
    resumedSameToken: true,
    finalExecutionReplicas: 2,
    developerReplicasUnchanged: true,
  };
}
