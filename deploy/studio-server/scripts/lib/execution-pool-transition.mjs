import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConcurrently } from './read-concurrently.mjs';

/** One journal writer; participant drains run together. Writes have persisted
 * intent and are never replayed after an unknown acknowledgement. The old pool
 * is scaled away only after every accepted operation reports completion. */
export async function runExecutionPoolTransition({
  operation,
  plan,
  io,
  timeoutMs,
  now = Date.now,
  pause = () => new Promise((resolve) => setTimeout(resolve, 500)),
  uuid = randomUUID,
}) {
  assert.equal(plan.protocol, 1);
  const ownerCount = plan.previous.replicas;
  assert.ok(Number.isSafeInteger(ownerCount) && ownerCount >= 2);
  assert.ok(Number.isSafeInteger(plan.maxReplicas) && plan.maxReplicas <= 100);
  assert.ok(2 * ownerCount <= plan.maxReplicas && plan.candidate.name !== plan.previous.name);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const save = async (changes) => {
    operation.assertLease();
    await operation.checkpoint({ executionPool: { ...operation.record.executionPool, ...changes } });
  };
  const wait = async (label, check) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      operation.assertLease();
      assert.ok(now() < deadline, `Execution pool ${label} timed out; owners retained`);
      const result = await check();
      operation.assertLease();
      assert.ok(now() < deadline, `Execution pool ${label} observation exceeded its deadline`);
      if (result) return result;
      await pause();
    }
  };
  let state = operation.record.executionPool;
  if (state) assert.deepEqual(state.plan, plan, 'Recover the exact execution pool transition');
  else {
    const owners = [];
    for (let ordinal = 0; ordinal < plan.previous.replicas; ordinal++) {
      const pod = await io.observe(`${plan.previous.name}-${ordinal}`);
      assert.ok(pod?.uid && pod.ready && !pod.terminating);
      const status = await io.status(pod);
      assert.equal(status.state, 'serving');
      assert.equal(status.operationId, null);
      assert.ok(status.incarnation);
      owners.push({ name: pod.name, uid: pod.uid, incarnation: status.incarnation, operationId: uuid() });
    }
    await save({ protocol: 1, phase: 'preparing', plan, owners });
  }
  const saved = operation.record.executionPool;
  assert.equal(saved.protocol, 1);
  assert.ok(['preparing', 'withdrawing', 'draining', 'removing', 'complete'].includes(saved.phase));
  assert.equal(saved.owners?.length, ownerCount);
  assert.equal(new Set(saved.owners.map((owner) => owner.uid)).size, ownerCount);
  assert.deepEqual(
    new Set(saved.owners.map((owner) => owner.name)),
    new Set(Array.from({ length: ownerCount }, (_, index) => `${plan.previous.name}-${index}`)),
  );
  for (const owner of saved.owners) {
    for (const key of ['uid', 'incarnation', 'operationId']) assert.ok(typeof owner[key] === 'string' && owner[key]);
    if (saved.phase !== 'preparing') assert.equal(owner.probeDone, true);
    if (['draining', 'removing', 'complete'].includes(saved.phase)) assert.equal(owner.withdrawIssued, true);
    if (['removing', 'complete'].includes(saved.phase)) assert.equal(owner.beginIssued, true);
  }
  if (saved.phase !== 'preparing') assert.ok(saved.candidateUid);
  if (saved.phase === 'complete') assert.equal(saved.scaleIssued, true);
  const ownerStatus = async (owner) => {
    const pod = await io.observe(owner.name);
    assert.equal(pod?.uid, owner.uid, 'Original execution owner changed before scale-down');
    const status = await io.status(pod);
    assert.equal(status.incarnation, owner.incarnation);
    if (owner.withdrawIssued)
      assert.equal(status.operationId, owner.operationId, 'Withdrawal acknowledgement is unknown');
    else {
      assert.equal(status.operationId, null);
      assert.equal(status.state, 'serving');
    }
    return { pod, status };
  };
  const editOwner = async (uid, changes) =>
    save({
      owners: operation.record.executionPool.owners.map((owner) =>
        owner.uid === uid ? { ...owner, ...changes } : owner,
      ),
    });
  if (operation.record.executionPool.phase === 'preparing') {
    const candidate = await wait('candidate readiness', () => io.candidate(plan));
    if (operation.record.executionPool.candidateUid)
      assert.equal(candidate.uid, operation.record.executionPool.candidateUid);
    await save({ candidateUid: candidate.uid });
    await io.assertCapacity(operation.record.executionPool);
    for (const owner of operation.record.executionPool.owners) {
      if (owner.probeIssued && !owner.probeDone)
        throw Error('Accepted-work probe acknowledgement is unknown; inspect without replay');
      if (!owner.probeDone) {
        const { pod } = await ownerStatus(owner);
        await editOwner(owner.uid, { probeIssued: true });
        await io.prepare(pod);
        await editOwner(owner.uid, { probeDone: true });
      }
    }
    await save({ phase: 'withdrawing' });
  }
  if (operation.record.executionPool.phase === 'withdrawing') {
    for (const owner of operation.record.executionPool.owners) {
      const { pod } = await ownerStatus(owner);
      if (owner.withdrawIssued) continue;
      await io.assertCapacity(operation.record.executionPool);
      await editOwner(owner.uid, { withdrawIssued: true });
      operation.assertLease();
      await io.withdraw(pod, owner.operationId, owner.incarnation);
    }
    await wait('withdrawal acknowledgement', async () => {
      const statuses = await readConcurrently(
        operation.record.executionPool.owners.map((owner) => async () => (await ownerStatus(owner)).status),
      );
      return statuses.every((status) => ['withdrawing', 'draining', 'drained'].includes(status.state));
    });
    // These are independent read-only propagation observations. Join all started
    // reads before permitting any admission fence, including on failure.
    await readConcurrently(
      operation.record.executionPool.owners.map((owner) => async () => {
        const { pod } = await ownerStatus(owner);
        await io.waitForRoutingWithdrawal(pod);
      }),
    );
    await save({ phase: 'draining' });
  }
  if (operation.record.executionPool.phase === 'draining') {
    for (const owner of operation.record.executionPool.owners) {
      const { pod } = await ownerStatus(owner);
      if (owner.beginIssued) continue;
      await io.prepareFence?.(pod);
      await io.assertCapacity(operation.record.executionPool);
      await editOwner(owner.uid, { beginIssued: true });
      operation.assertLease();
      await io.begin(pod, owner.operationId, owner.incarnation);
    }
    await wait('accepted work completion', async () => {
      const statuses = await readConcurrently(
        operation.record.executionPool.owners.map((owner) => async () => (await ownerStatus(owner)).status),
      );
      for (const status of statuses)
        assert.ok(['draining', 'drained'].includes(status.state), 'Admission fence is unconfirmed');
      return statuses.every((status) => status.state === 'drained');
    });
    await io.assertCapacity(operation.record.executionPool);
    await save({ phase: 'removing' });
  }
  if (operation.record.executionPool.phase === 'removing') {
    const current = await io.previous();
    assert.equal(current.uid, plan.previous.uid);
    if (!operation.record.executionPool.scaleIssued) {
      assert.equal(current.replicas, plan.previous.replicas);
      for (const owner of operation.record.executionPool.owners) {
        const { pod, status } = await ownerStatus(owner);
        assert.equal(status.state, 'drained');
        await io.waitForWithdrawal(pod);
      }
      await io.assertCapacity(operation.record.executionPool);
      await save({ scaleIssued: true });
      operation.assertLease();
      for (const owner of operation.record.executionPool.owners)
        assert.equal((await ownerStatus(owner)).status.state, 'drained');
      // Status updates can advance resourceVersion while drain/recording
      // observations and the intent checkpoint settle. Fence the write against
      // a fresh version of the same controller and unchanged replica count.
      const confirmed = await io.previous();
      assert.equal(confirmed.uid, plan.previous.uid);
      assert.equal(confirmed.replicas, plan.previous.replicas);
      operation.assertLease();
      await io.scalePrevious(confirmed);
    } else assert.equal(current.replicas, 0, 'Pool scale acknowledgement is unknown; inspect without replay');
    await wait('original owner disappearance', async () => {
      const previous = await io.previous();
      assert.equal(previous.uid, plan.previous.uid);
      assert.equal(previous.replicas, 0);
      const pods = await readConcurrently(
        operation.record.executionPool.owners.map((owner) => () => io.observe(owner.name)),
      );
      return pods.every((pod) => pod === null);
    });
    await io.verify(operation.record.executionPool);
    await save({ phase: 'complete' });
  }
  assert.equal(operation.record.executionPool.phase, 'complete');
  await io.verify(operation.record.executionPool);
  return operation.record.executionPool;
}
