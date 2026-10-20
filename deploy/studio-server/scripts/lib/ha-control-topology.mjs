import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertHaRetirement } from './ha-rolling-upgrade.mjs';

/** A topology change is NOT a version upgrade. Public owners/images are frozen.
 * The same release CAS journal excludes ordinary rollouts and maintenance.
 * Only developer owners are drained and removed, highest ordinal first. */
export async function runHaControlTopologyTransition({
  identity,
  inventory,
  resumeToken,
  readJournal,
  saveJournal,
  preflight,
  prepareRuntimeEdge = async () => {},
  waitForRuntimeEdge = async () => {},
  observePod,
  status,
  withdraw,
  begin,
  waitForRoutingWithdrawal,
  scaleToZero,
  waitForNoOwners,
  waitForVolumeRelease,
  applyTemplates,
  templatesApplied,
  verify,
  timeoutMs = 900_000,
  now = Date.now,
  wait = () => new Promise((r) => setTimeout(r, 500)),
  uuid = randomUUID,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval,
}) {
  if (
    identity.topologyProtocol !== 1 ||
    !['replicated', 'singleton'].includes(identity.from) ||
    !['replicated', 'singleton'].includes(identity.to) ||
    identity.from === identity.to ||
    !identity.configurationDigest ||
    !identity.claimUid ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new Error('Invalid HA control topology identity.');
  if (
    !Array.isArray(inventory) ||
    inventory.length < 1 ||
    inventory.some(
      (w) =>
        !['backend', 'maintenance'].includes(w.role) ||
        !w.uid ||
        !/^[a-z0-9-]+$/.test(w.name) ||
        !Number.isSafeInteger(w.replicas) ||
        w.replicas < 1 ||
        w.replicas > 8,
    ) ||
    inventory.filter((w) => w.role === 'backend').length !== 1 ||
    inventory.filter((w) => w.role === 'maintenance').length !== (identity.from === 'replicated' ? 1 : 0)
  )
    throw new Error('Invalid developer ownership inventory.');
  const runner = uuid();
  let record = await readJournal();
  if (record?.leaseExpiresAt > now()) throw new Error('Another release operation is active.');
  if (record && record.phase !== 'complete') {
    if (
      record.token !== resumeToken ||
      record.topologyProtocol !== 1 ||
      Object.keys(identity).some((k) => !isDeepStrictEqual(record[k], identity[k])) ||
      !isDeepStrictEqual(record.inventory, inventory)
    )
      throw new Error('Recover the exact recorded topology operation and original configuration.');
  } else {
    if (resumeToken) throw new Error('No unfinished topology operation matches this token.');
    await preflight();
    record = await saveJournal(
      {
        protocol: 1,
        ...identity,
        inventory,
        runner,
        token: uuid(),
        phase: 'owners',
        leaseExpiresAt: now() + 120_000,
        stopped: [],
        owner: null,
      },
      record?.resourceVersion,
    );
  }
  let failure,
    chain = Promise.resolve(),
    stopping = false;
  const checkpoint = (changes) => {
    chain = chain
      .then(async () => {
        if (failure || (record.runner === runner && record.leaseExpiresAt <= now()))
          throw failure ?? new Error('Topology operation lease expired.');
        record = await saveJournal(
          { ...record, ...changes, runner, leaseExpiresAt: now() + 120_000 },
          record.resourceVersion,
        );
      })
      .catch((error) => {
        failure = error;
        throw error;
      });
    return chain;
  };
  const assertLease = () => {
    if (failure || record.runner !== runner || record.leaseExpiresAt <= now())
      throw failure ?? new Error('Topology operation lease is unconfirmed.');
  };
  const until = async (check, message) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      assertLease();
      if (await check()) return;
      if (now() >= deadline) throw new Error(message);
      await wait();
    }
  };
  const heartbeat = setHeartbeat(() => {
    if (!stopping && !failure) void checkpoint({}).catch(() => {});
  }, 30_000);
  heartbeat.unref?.();
  try {
    await checkpoint({});
    if (record.phase === 'owners') {
      // Health checks must be independent BEFORE any developer is withdrawn.
      // Record intent first; an uncertain patch is observed, never replayed.
      if (!record.edgePrepared) {
        if (!record.edgePrepareIssued) {
          await checkpoint({ edgePrepareIssued: true });
          assertLease();
          await prepareRuntimeEdge();
        }
        await waitForRuntimeEdge();
        await checkpoint({ edgePrepared: true });
      }
      for (const workload of inventory) {
        if (record.stopped.includes(workload.name)) {
          await waitForNoOwners(workload);
          continue;
        }
        for (let ordinal = workload.replicas - 1; ordinal >= 0; ordinal--) {
          const name = `${workload.name}-${ordinal}`;
          if (record.drained?.some((p) => p.name === name)) continue;
          const pod = await observePod(name);
          if (!pod?.uid) throw new Error('A recorded developer owner disappeared before draining.');
          if (!record.owner) {
            const before = assertHaRetirement(await status(pod));
            if (before.state !== 'serving' || before.operationId) throw new Error('Developer owner already retiring.');
            await checkpoint({ owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid() } });
          }
          const owner = record.owner;
          if (owner.name !== name || owner.uid !== pod.uid) throw new Error('Developer owner identity changed.');
          if (!owner.withdrawIssued) {
            await checkpoint({ owner: { ...record.owner, withdrawIssued: true } });
            assertLease();
            await withdraw(pod, owner.operationId, owner.incarnation);
          }
          await until(async () => {
            if ((await observePod(name))?.uid !== owner.uid) throw new Error('Owner changed during withdrawal.');
            return ['withdrawing', 'draining', 'drained'].includes(
              assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state,
            );
          }, 'Withdrawal acknowledgement unknown; no owner was removed.');
          await waitForRoutingWithdrawal(pod);
          if (!record.owner.beginIssued) {
            await checkpoint({ owner: { ...record.owner, beginIssued: true } });
            assertLease();
            await begin(pod, owner.operationId, owner.incarnation);
          }
          await until(async () => {
            if ((await observePod(name))?.uid !== owner.uid) throw new Error('Owner changed during drain.');
            return assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state === 'drained';
          }, 'Accepted developer/maintenance work is active; no owner was removed.');
          await checkpoint({ drained: [...(record.drained ?? []), { name, uid: pod.uid }], owner: null });
        }
        // All ordinals have drained. Scale once, recording intent first. A lost
        // acknowledgement is reconciled by the adapter's RV/UID-fenced observation.
        await checkpoint({ stopping: workload.name });
        assertLease();
        await scaleToZero(workload, record.drained);
        await waitForNoOwners(workload);
        await checkpoint({ stopped: [...record.stopped, workload.name], stopping: null });
      }
      await waitForVolumeRelease(identity.claimUid);
      await checkpoint({ phase: 'templates' });
      assertLease();
      await applyTemplates();
      await checkpoint({ phase: 'preflight' }); // templates acknowledged; recovery verifies only
    } else if (record.phase === 'templates') {
      // Never replay Helm/migrations after a lost acknowledgement.
      if (!(await templatesApplied())) throw new Error('Topology template outcome unknown; inspect before recovery.');
      await checkpoint({ phase: 'preflight' });
    }
    if (record.phase !== 'preflight') throw new Error('Invalid topology completion phase.');
    assertLease();
    await verify();
    await checkpoint({ phase: 'complete' });
    return record;
  } finally {
    stopping = true;
    clearHeartbeat(heartbeat);
    await chain.catch(() => {});
    if (!failure && record.runner === runner && record.leaseExpiresAt > now())
      await saveJournal({ ...record, leaseExpiresAt: now() }, record.resourceVersion).catch(() => {});
  }
}
