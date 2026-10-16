import { randomUUID } from 'node:crypto';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ownerRoles = new Set(['backend', 'execution', 'evaluation', 'maintenance']);
export function assertHaRetirement(status, incarnation, operationId) {
  if (
    status?.protocol !== 1 ||
    status.withdrawalProtocol !== 1 ||
    !uuidPattern.test(status.incarnation ?? '') ||
    (incarnation && status.incarnation !== incarnation) ||
    (operationId && status.operationId !== operationId) ||
    !['serving', 'checking', 'withdrawing', 'draining', 'drained'].includes(status.state)
  )
    throw new Error('HA retirement owner/protocol is unconfirmed; replacement is blocked.');
  return status;
}

export function assertHaRolloutPlan(workloads) {
  if (!Array.isArray(workloads) || !workloads.some((w) => w.role === 'backend'))
    throw new Error('Missing HA backends.');
  const names = new Set();
  for (const w of workloads) {
    if (
      !ownerRoles.has(w.role) ||
      names.has(w.name) ||
      !/^[a-z0-9-]{1,63}$/.test(w.name ?? '') ||
      !Number.isInteger(w.replicas) ||
      w.replicas < (w.role === 'backend' ? 2 : 1) ||
      w.replicas > 32 ||
      w.updateStrategy !== 'OnDelete' ||
      !/^.+@sha256:[a-f0-9]{64}$/.test(w.image ?? '')
    )
      throw new Error('HA requires bounded OnDelete owners, immutable images and at least two ready backends.');
    names.add(w.name);
  }
  return workloads;
}

/** An HA rollout changes admission one fenced owner at a time. It never kills
 * work to meet a deadline. The journal records commands BEFORE sending them;
 * recovery observes unknown begins rather than replaying them. */
export async function runHaRollingUpgrade({
  identity,
  workloads,
  resumeToken,
  readJournal,
  saveJournal,
  observePod,
  status,
  withdraw,
  begin,
  removePod,
  scale,
  applyTemplates,
  restoreAutoscalers,
  waitForReady,
  waitForWithdrawal,
  waitForRoutingWithdrawal,
  waitForScaleDown,
  snapshotCapacity,
  timeoutMs = 900_000,
  now = Date.now,
  wait = () => new Promise((resolve) => setTimeout(resolve, 500)),
  uuid = randomUUID,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval,
  isCurrentPod = (pod, workload) => pod.image === workload.image,
  prepareRetirement = async () => {},
}) {
  assertHaRolloutPlan(workloads);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid HA deadline.');
  const runner = uuid();
  let record = await readJournal();
  if (
    record &&
    (record.protocol !== 1 ||
      record.release !== identity.release ||
      record.namespace !== identity.namespace ||
      !uuidPattern.test(record.token ?? '') ||
      !Number.isFinite(record.leaseExpiresAt) ||
      !record.resourceVersion ||
      !['preflight', 'templates', 'owners', 'complete'].includes(record.phase))
  )
    throw new Error('Invalid HA rollout journal.');
  if (record?.leaseExpiresAt > now()) throw new Error('Another HA rollout owns this release.');
  if (record && record.phase !== 'complete') {
    if (resumeToken !== record.token || record.manifestDigest !== identity.manifestDigest)
      throw new Error(`Recover the exact HA release using --resume-ha ${record.token}.`);
    if (identity.configurationDigest && record.configurationDigest !== identity.configurationDigest)
      throw new Error('HA recovery configuration changed or is unconfirmed. Restore the original deployment values before recovery.');
    if (JSON.stringify(record.workloads) !== JSON.stringify(workloads))
      throw new Error('HA recovery inventory changed.');
  } else {
    if (resumeToken) throw new Error('No unfinished HA rollout matches the recovery token.');
    // Verify every original owner BEFORE modifying Helm, autoscalers or admission.
    await snapshotCapacity(workloads);
    for (const w of workloads)
      for (let i = 0; i < w.replicas; i++) {
        const pod = await observePod(`${w.name}-${i}`);
        if (!pod?.uid || !pod.ready) throw new Error('An original HA owner is not ready.');
        const before = assertHaRetirement(await status(pod));
        if (before.state !== 'serving' || before.operationId)
          throw new Error('An original HA owner is already retiring.');
      }
    const next = {
      protocol: 1,
      ...identity,
      token: uuid(),
      runner,
      phase: 'preflight',
      leaseExpiresAt: now() + 120_000,
      workloads,
      completed: [],
      owner: null,
    };
    try {
      record = await saveJournal(next, record?.resourceVersion);
    } catch (error) {
      throw new Error(
        `HA ownership write is unconfirmed; no workloads were changed. Inspect journal token ${next.token} before recovery.`,
        { cause: error },
      );
    }
  }
  let failure;
  let chain = Promise.resolve();
  let stopping = false;
  const persist = async (changes = {}) => {
    if (failure) throw failure;
    if (record.runner === runner && record.leaseExpiresAt <= now()) throw new Error('HA rollout lease expired.');
    record = await saveJournal(
      { ...record, ...changes, runner, leaseExpiresAt: now() + 120_000 },
      record.resourceVersion,
    );
  };
  const checkpoint = (changes) => {
    chain = chain
      .then(() => persist(changes))
      .catch((error) => {
        failure = error;
        throw error;
      });
    return chain;
  };
  const assertLease = () => {
    if (failure) throw failure;
    if (record.runner !== runner || record.leaseExpiresAt <= now()) throw new Error('HA rollout lease is unconfirmed.');
  };
  const heartbeat = setHeartbeat(() => {
    if (!stopping && !failure) void checkpoint({}).catch(() => {});
  }, 30_000);
  heartbeat.unref?.();
  const startRetirement = async (pod) => {
    const owner = record.owner;
    if (owner.beginIssued && !owner.withdrawIssued)
      throw new Error('Legacy retirement journal lacks routing withdrawal proof.');
    if (!owner.withdrawIssued) {
      await prepareRetirement(pod);
      await checkpoint({ owner: { ...record.owner, withdrawIssued: true } });
      assertLease();
      await withdraw(pod, owner.operationId, owner.incarnation);
    }
    const deadline = now() + timeoutMs;
    while (true) {
      assertLease();
      if ((await observePod(pod.name))?.uid !== owner.uid) throw new Error('HA pod changed during routing withdrawal.');
      const current = assertHaRetirement(await status(pod), owner.incarnation, owner.operationId);
      if (['withdrawing', 'draining', 'drained'].includes(current.state)) break;
      if (now() >= deadline) throw new Error('Routing withdrawal was not acknowledged; admission was not fenced.');
      await wait();
    }
    await waitForRoutingWithdrawal(pod);
    if (!record.owner.beginIssued) {
      await checkpoint({ owner: { ...record.owner, beginIssued: true } });
      assertLease();
      await begin(pod, owner.operationId, owner.incarnation);
    }
  };
  try {
    await checkpoint({});
    if (record.phase === 'preflight') {
      await checkpoint({ phase: 'templates' });
      assertLease();
      await applyTemplates(); // Removes autoscalers; never replaces OnDelete owners.
    } else if (record.phase === 'templates') {
      // Helm may have committed without its acknowledgement. Template install is
      // declarative, but migrations are not replayed by recovery.
      throw new Error('HA template acknowledgement is unknown. Verify Helm/schema state before recovery.');
    }
    await checkpoint({ phase: 'owners' });
    for (const workload of workloads) {
      const w = workload;
      if (record.completed.includes(w.name)) continue;
      const surgeName = `${w.name}-${w.replicas}`;
      if (w.role !== 'maintenance' && record.owner?.name !== surgeName) {
        assertLease();
        await scale(w.name, w.replicas + 1, w.replicas);
        await waitForReady(surgeName, w.image);
      }
      for (let i = 0; i < w.replicas; i++) {
        const name = `${w.name}-${i}`;
        let pod = await observePod(name);
        if (!pod) throw new Error(`HA owner ${name} disappeared before retirement.`);
        if ((await isCurrentPod(pod, w)) && (!record.owner || record.owner.name !== name)) {
          await waitForReady(name, w.image);
          continue;
        }
        if (!record.owner) {
          const before = assertHaRetirement(await status(pod));
          if (before.state !== 'serving' || before.operationId) throw new Error('HA owner is already retiring.');
          await checkpoint({
            owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid(), beginIssued: false },
          });
        }
        const owner = record.owner;
        if (owner.name !== name) throw new Error('HA owner recovery order is inconsistent.');
        if (pod.uid !== owner.uid) {
          // Only the exact recorded UID was ever eligible for deletion. A new
          // owner must be current-image and ready, never receive the old command.
          await waitForReady(name, w.image);
          await checkpoint({ owner: null });
          continue;
        }
        await startRetirement(pod);
        const deadline = now() + timeoutMs;
        while (true) {
          assertLease();
          pod = await observePod(name);
          if (pod?.uid !== owner.uid) throw new Error('HA pod changed while its outcome was pending.');
          const current = assertHaRetirement(await status(pod), owner.incarnation, owner.operationId);
          if (current.state === 'drained') break;
          if (now() >= deadline) throw new Error('Accepted work is still active; owner was not deleted.');
          await wait();
        }
        await waitForWithdrawal(pod);
        assertLease();
        // The adapter must use a Kubernetes UID precondition, not kubectl delete --force.
        await removePod(pod);
        await waitForReady(name, w.image);
        await checkpoint({ owner: null });
      }
      if (w.role !== 'maintenance') {
        // The surge may have accepted work. Retire it before scaling it away.
        const name = surgeName;
        if (!record.owner?.scaleDownIssued) {
          const pod = await observePod(name);
          if (!pod) throw new Error('HA surge disappeared before its scale-down was recorded.');
          if (!record.owner) {
            const before = assertHaRetirement(await status(pod));
            if (before.state !== 'serving' || before.operationId) throw new Error('HA surge is already retiring.');
            await checkpoint({
              owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid(), beginIssued: false },
            });
          }
          const owner = record.owner;
          if (owner.name !== name || owner.uid !== pod.uid) throw new Error('HA surge owner changed.');
          await startRetirement(pod);
          const deadline = now() + timeoutMs;
          while (true) {
            assertLease();
            if ((await observePod(name))?.uid !== pod.uid) throw new Error('HA surge identity changed.');
            if (assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state === 'drained') break;
            if (now() >= deadline) throw new Error('Surge work is still active; owner was not scaled down.');
            await wait();
          }
          await waitForWithdrawal(pod);
          await checkpoint({ owner: { ...record.owner, scaleDownIssued: true } });
          assertLease();
          await scale(w.name, w.replicas, w.replicas + 1, owner);
        }
        // A lost scale acknowledgement must not recreate a surge or replay the
        // command against a replacement owner. Observe the recorded removal,
        // including actual pod deletion, before restoring autoscalers.
        await waitForScaleDown(w, record.owner);
      }
      await checkpoint({ owner: null, completed: [...record.completed, w.name] });
    }
    // Journal completion is historical evidence, not a readiness or identity
    // guarantee about an owner that may have changed while another tier drained.
    const verifyCompletedOwners = async () => {
      for (const w of workloads)
        for (let i = 0; i < w.replicas; i++) {
          assertLease();
          const pod = await observePod(`${w.name}-${i}`);
          if (!pod?.ready || !(await isCurrentPod(pod, w)))
            throw new Error('HA completed owner is no longer current and ready; completion is blocked.');
          const current = assertHaRetirement(await status(pod));
          if (current.state !== 'serving' || current.operationId)
            throw new Error('HA completed owner is retiring; completion is blocked.');
        }
    };
    await verifyCompletedOwners();
    assertLease();
    await restoreAutoscalers();
    await verifyCompletedOwners();
    await checkpoint({ phase: 'complete' });
    return record;
  } finally {
    stopping = true;
    clearHeartbeat(heartbeat);
    await chain.catch(() => {});
    if (!failure && record.runner === runner && record.leaseExpiresAt > now()) {
      await saveJournal({ ...record, leaseExpiresAt: now() }, record.resourceVersion).catch(() => {});
    }
  }
}
