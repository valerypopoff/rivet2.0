import { randomUUID } from 'node:crypto';
import { runDeploymentOperation } from './deployment-operation.mjs';
import { isDeepStrictEqual } from 'node:util';
import { requireDeploymentSafety } from './deployment-safety.mjs';
import { assertHaRetirement } from './ha-rolling-upgrade.mjs';

/** A topology change is NOT a version upgrade. Public owners/images are frozen.
 * The same release CAS journal excludes ordinary rollouts and maintenance.
 * Only developer owners are drained and removed, highest ordinal first. */
export async function runHaControlTopologyTransition({
  identity,
  safety,
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
  requireDeploymentSafety(safety, 'topology', identity);
  verify = safety.requireSettlement(verify);
  identity = safety.bind(identity);
  if (
    identity.topologyProtocol !== 1 ||
    !['replicated', 'singleton', 'singleton-overlap'].includes(identity.from) ||
    !['replicated', 'singleton', 'singleton-overlap'].includes(identity.to) ||
    ((identity.from === 'singleton-overlap' || identity.to === 'singleton-overlap') &&
      ![identity.from, identity.to].includes('singleton')) ||
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
  const record = await readJournal();
  let initial;
  const recovering = Boolean(record && record.phase !== 'complete');
  if (record?.leaseExpiresAt > now()) throw new Error('Another release operation is active.');
  if (record && record.phase !== 'complete') {
    safety.assertRecovery(record);
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
    initial = {
      protocol: 1,
      ...identity,
      inventory,
      token: uuid(),
      phase: 'owners',
      stopped: [],
      owner: null,
    };
  }
  return runDeploymentOperation({
    name: 'Topology operation',
    record,
    initial,
    runner,
    resumeToken,
    safety,
    readJournal,
    saveJournal,
    now,
    setHeartbeat,
    clearHeartbeat,
    onFailure: async (_error, operation) => {
      if (
        !recovering &&
        !operation.record.edgePrepareIssued &&
        !operation.record.owner &&
        !operation.record.stopped.length &&
        !operation.failure
      ) {
        operation.assertLease();
        await operation.complete({ abortedBeforeTopologyChanges: true });
      }
    },
    run: async (operation) => {
      const { checkpoint, assertLease } = operation;
      const until = async (check, message) => {
        const deadline = now() + timeoutMs;
        for (;;) {
          assertLease();
          if (await check()) return;
          if (now() >= deadline) throw new Error(message);
          await wait();
        }
      };

      await safety.checkOwnedBaseline(operation.record, runner, now);
      if (operation.record.phase === 'owners') {
        // Health checks must be independent BEFORE any developer is withdrawn.
        // Record intent first; an uncertain patch is observed, never replayed.
        if (!operation.record.edgePrepared) {
          if (!operation.record.edgePrepareIssued) {
            await checkpoint({ edgePrepareIssued: true });
            assertLease();
            await prepareRuntimeEdge();
          }
          await waitForRuntimeEdge();
          await checkpoint({ edgePrepared: true });
        }
        for (const workload of inventory) {
          if (operation.record.stopped.includes(workload.name)) {
            await waitForNoOwners(workload);
            continue;
          }
          for (let ordinal = workload.replicas - 1; ordinal >= 0; ordinal--) {
            const name = `${workload.name}-${ordinal}`;
            if (operation.record.drained?.some((p) => p.name === name)) continue;
            const pod = await observePod(name);
            if (!pod?.uid) throw new Error('A recorded developer owner disappeared before draining.');
            if (!operation.record.owner) {
              const before = assertHaRetirement(await status(pod));
              if (before.state !== 'serving' || before.operationId)
                throw new Error('Developer owner already retiring.');
              await checkpoint({ owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid() } });
            }
            const owner = operation.record.owner;
            if (owner.name !== name || owner.uid !== pod.uid) throw new Error('Developer owner identity changed.');
            if (!owner.withdrawIssued) {
              await checkpoint({ owner: { ...operation.record.owner, withdrawIssued: true } });
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
            if (!operation.record.owner.beginIssued) {
              await checkpoint({ owner: { ...operation.record.owner, beginIssued: true } });
              assertLease();
              await begin(pod, owner.operationId, owner.incarnation);
            }
            await until(async () => {
              if ((await observePod(name))?.uid !== owner.uid) throw new Error('Owner changed during drain.');
              return assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state === 'drained';
            }, 'Accepted developer/maintenance work is active; no owner was removed.');
            await checkpoint({ drained: [...(operation.record.drained ?? []), { name, uid: pod.uid }], owner: null });
          }
          // All ordinals have drained. Scale once, recording intent first. A lost
          // acknowledgement is reconciled by the adapter's RV/UID-fenced observation.
          await checkpoint({ stopping: workload.name });
          assertLease();
          await scaleToZero(workload, operation.record.drained);
          await waitForNoOwners(workload);
          await checkpoint({ stopped: [...operation.record.stopped, workload.name], stopping: null });
        }
        await waitForVolumeRelease(identity.claimUid);
        await checkpoint({ phase: 'templates' });
        assertLease();
        safety.assertReadyForTemplates();
        await applyTemplates();
        await checkpoint({ phase: 'preflight' }); // templates acknowledged; recovery verifies only
      } else if (operation.record.phase === 'templates') {
        // Never replay Helm/migrations after a lost acknowledgement.
        if (!(await templatesApplied())) throw new Error('Topology template outcome unknown; inspect before recovery.');
        await checkpoint({ phase: 'preflight' });
      }
      if (operation.record.phase !== 'preflight') throw new Error('Invalid topology completion phase.');
      assertLease();
      safety.confirmSettlement(await verify());
      await operation.complete();
      return operation.record;
    },
  });
}
