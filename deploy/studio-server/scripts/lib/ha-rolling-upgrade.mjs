import { randomUUID } from 'node:crypto';
import { runDeploymentOperation } from './deployment-operation.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';
import { haPreparationSettled, haJournalForRecovery } from './release-operation-journal.mjs';
import { proxyContinuitySettled } from './proxy-continuity-transition.mjs';

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

export function assertHaRolloutPlan(workloads, controlPlaneMode = 'replicated') {
  if (!['replicated', 'singleton', 'singleton-overlap'].includes(controlPlaneMode))
    throw new Error('Invalid HA control-plane mode.');
  if (
    !Array.isArray(workloads) ||
    workloads.some((w) => !w || typeof w !== 'object') ||
    !workloads.some((w) => w.role === 'backend')
  )
    throw new Error('Missing HA backends.');
  if (
    ['singleton', 'singleton-overlap'].includes(controlPlaneMode) &&
    (workloads.filter((w) => w.role === 'backend').length !== 1 ||
      workloads.find((w) => w.role === 'backend')?.replicas !== 1 ||
      workloads.some((w) => w.role === 'maintenance') ||
      !workloads.some((w) => w.role === 'execution' && w.replicas >= 2))
  )
    throw new Error('Singleton HA requires one embedded backend and at least two execution owners.');
  const names = new Set();
  for (const w of workloads) {
    if (
      !ownerRoles.has(w.role) ||
      names.has(w.name) ||
      !/^[a-z0-9-]{1,63}$/.test(w.name ?? '') ||
      !Number.isInteger(w.replicas) ||
      w.replicas < (w.role === 'execution' || (w.role === 'backend' && controlPlaneMode === 'replicated') ? 2 : 1) ||
      w.replicas > (w.role === 'execution' ? 100 : 32) ||
      w.updateStrategy !== 'OnDelete' ||
      !/^.+@sha256:[a-f0-9]{64}$/.test(w.image ?? '')
    )
      throw new Error(
        'HA requires bounded OnDelete owners, immutable images and at least two owners in each replicated serving tier.',
      );
    names.add(w.name);
  }
  return workloads;
}

/** An HA rollout changes admission one fenced owner at a time. It never kills
 * work to meet a deadline. The journal records commands BEFORE sending them;
 * recovery observes unknown begins rather than replaying them. */
export async function runHaRollingUpgrade({
  identity,
  safety,
  workloads,
  resumeToken,
  readJournal,
  saveJournal,
  afterCheckpoint,
  observePod,
  readReplicas,
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
  checkHeadroom = async () => {},
  settle,
  handoverHousekeeping,
  verifyPoolPreparationTemplates,
  proxyContinuity,
  measure = async (_name, action) => action(),
}) {
  requireDeploymentSafety(safety, 'rolling', identity);
  settle = safety.requireSettlement(settle);
  identity = safety.bind(identity);
  const controlPlaneMode = identity.controlPlaneMode ?? 'replicated';
  if (controlPlaneMode === 'singleton-overlap' && typeof handoverHousekeeping !== 'function')
    throw Error('Overlapping backends require the housekeeping handover contract.');
  assertHaRolloutPlan(workloads, controlPlaneMode);
  const elasticWorkload = workloads.find((w) => w.name === identity.cooperativeScaling?.workload);
  if (
    elasticWorkload &&
    (elasticWorkload.role !== 'execution' ||
      typeof readReplicas !== 'function' ||
      !Number.isSafeInteger(identity.cooperativeScaling.maxReplicas) ||
      identity.cooperativeScaling.maxReplicas < Math.max(3, elasticWorkload.replicas) ||
      identity.cooperativeScaling.maxReplicas > 100)
  )
    throw Error('Cooperative HA scaling requires a live replica reader and capacity for three owners.');
  const ownerCount = async (workload) => {
    if (workload !== elasticWorkload) return workload.replicas;
    const count = await readReplicas(workload);
    if (!Number.isSafeInteger(count) || count < workload.replicas || count > identity.cooperativeScaling.maxReplicas)
      throw Error('Cooperative HA replica count is outside the journaled baseline/ceiling; serving owners retained.');
    return count;
  };
  // Re-read once per batch, including at the boundary, rather than issuing a
  // StatefulSet GET for every ordinal. Growth is bounded by the approved ceiling.
  async function* ownerNames(workload) {
    let next = 0;
    while (true) {
      const count = await ownerCount(workload);
      if (next >= count) return;
      while (next < count) yield `${workload.name}-${next++}`;
    }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid HA deadline.');
  const runner = uuid();
  let record = await readJournal();
  let initial;
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
  record = haJournalForRecovery(record);
  const recovering = !!record && record.phase !== 'complete';
  if (record && record.phase !== 'complete') {
    if ((record.controlPlaneMode ?? 'replicated') !== controlPlaneMode)
      throw new Error('HA recovery control-plane mode changed.');
    if (resumeToken !== record.token || record.manifestDigest !== identity.manifestDigest)
      throw new Error(`Recover the exact HA release using --resume-ha ${record.token}.`);
    if (identity.configurationDigest && record.configurationDigest !== identity.configurationDigest)
      throw new Error(
        'HA recovery configuration changed or is unconfirmed. Restore the original deployment values before recovery.',
      );
    if (JSON.stringify(record.housekeepingDisk) !== JSON.stringify(identity.housekeepingDisk))
      throw Error('HA recovery maintenance claim identity changed.');
    if (JSON.stringify(record.ownerPoolTransition) !== JSON.stringify(identity.ownerPoolTransition))
      throw Error('HA recovery pool preparation authority changed.');
    if (JSON.stringify(record.poolPreparationControllers) !== JSON.stringify(identity.poolPreparationControllers))
      throw Error('HA recovery pool preparation controllers changed.');
    if (JSON.stringify(record.proxyContinuityIdentity) !== JSON.stringify(identity.proxyContinuityIdentity))
      throw Error('HA recovery ingress continuity configuration changed.');
    safety.assertRecovery(record);
    if (JSON.stringify(record.workloads) !== JSON.stringify(workloads))
      throw new Error('HA recovery inventory changed.');
    if (!haPreparationSettled(record))
      throw new Error(
        'Legacy rollout warmup Jobs have unresolved cleanup; inspect the original operation before recovery.',
      );
  } else {
    if (resumeToken) throw new Error('No unfinished HA rollout matches the recovery token.');
    // Verify every original owner BEFORE modifying Helm, autoscalers or admission.
    await snapshotCapacity(workloads);
    await checkHeadroom({ stage: 'preflight' });
    for (const w of workloads)
      for (let i = 0; i < w.replicas; i++) {
        const pod = await observePod(`${w.name}-${i}`);
        if (!pod?.uid || !pod.ready) throw new Error('An original HA owner is not ready.');
        const before = assertHaRetirement(await status(pod));
        if (before.state !== 'serving' || before.operationId)
          throw new Error('An original HA owner is already retiring.');
        if (
          w.role === 'backend' &&
          controlPlaneMode === 'singleton-overlap' &&
          (before.housekeeping?.protocol !== 1 ||
            before.housekeeping.state !== 'owner' ||
            before.housekeeping.podUid !== pod.uid)
        )
          throw Error('The original backend has no confirmed housekeeping ownership capability.');
      }
    initial = {
      protocol: 1,
      ...identity,
      token: uuid(),
      phase: 'preflight',
      workloads,
      completed: [],
      owner: null,
    };
  }
  return runDeploymentOperation({
    name: 'HA rollout',
    record,
    initial,
    runner,
    resumeToken,
    safety,
    readJournal,
    saveJournal,
    afterCheckpoint,
    now,
    setHeartbeat,
    clearHeartbeat,
    onFailure: async (_error, operation) => {
      // Preflight has not issued a template command. Never abandon later phases.
      if (
        operation.record.phase === 'preflight' &&
        !operation.failure &&
        haPreparationSettled(operation.record) &&
        proxyContinuitySettled(operation.record)
      ) {
        operation.assertLease();
        await operation.complete({ abortedBeforeTemplates: true });
      }
    },
    run: async (operation) => {
      const { checkpoint, assertLease } = operation;
      const availableOwner = async (name) => {
        const deadline = now() + timeoutMs;
        while (true) {
          assertLease();
          const pod = await observePod(name);
          if (pod?.ready) return pod;
          if (now() >= deadline)
            throw Error(`Timed out waiting for serving capacity ${name}; original owners retained.`);
          await wait();
        }
      };
      const checkRetirementCapacity = async (pod, workload) => {
        if (workload.role !== 'execution' && !(workload.role === 'backend' && controlPlaneMode !== 'singleton')) return;
        let survivors = 0;
        const maximumOrdinal =
          identity.cooperativeScaling?.workload === workload.name
            ? identity.cooperativeScaling.maxReplicas - 1
            : workload.replicas;
        const required = workload.role === 'backend' && controlPlaneMode === 'singleton-overlap' ? 1 : 2;
        for (let i = 0; i <= maximumOrdinal && survivors < required; i++) {
          assertLease();
          const name = `${workload.name}-${i}`;
          if (name === pod.name) continue;
          const peer = await observePod(name);
          if (!peer?.ready) continue;
          const state = assertHaRetirement(await status(peer));
          if (state.state !== 'serving' || state.operationId) continue;
          const confirmed = await observePod(name);
          if (confirmed?.uid === peer.uid && confirmed.ready) survivors++;
        }
        if (survivors < required)
          throw new Error(
            'HA replacement capacity requires two other ready, serving owners before routing withdrawal or admission fencing; resume after peers recover.',
          );
      };
      const startRetirement = async (pod, workload) => {
        await proxyContinuity?.verify(operation);
        const owner = operation.record.owner;
        if (workload.role === 'backend' && controlPlaneMode === 'singleton-overlap' && !owner.withdrawIssued) {
          const target = await observePod(`${workload.name}-${pod.name.endsWith('-0') ? 1 : 0}`);
          if (!target?.ready) throw Error('Replacement developer backend is unavailable; old backend retained.');
          await handoverHousekeeping({ source: pod, target, operation });
        }
        if (owner.beginIssued && !owner.withdrawIssued)
          throw new Error('Legacy retirement journal lacks routing withdrawal proof.');
        if (!owner.withdrawIssued) {
          await prepareRetirement(pod);
          await checkRetirementCapacity(pod, workload);
          await checkHeadroom({ stage: 'retirement', departing: pod, workload });
          await checkpoint({ owner: { ...operation.record.owner, withdrawIssued: true } });
          assertLease();
          await withdraw(pod, owner.operationId, owner.incarnation);
        }
        const deadline = now() + timeoutMs;
        while (true) {
          assertLease();
          if ((await observePod(pod.name))?.uid !== owner.uid)
            throw new Error('HA pod changed during routing withdrawal.');
          const current = assertHaRetirement(await status(pod), owner.incarnation, owner.operationId);
          if (['withdrawing', 'draining', 'drained'].includes(current.state)) break;
          if (now() >= deadline) throw new Error('Routing withdrawal was not acknowledged; admission was not fenced.');
          await wait();
        }
        await measure(`routing:${pod.name}`, () => waitForRoutingWithdrawal(pod));
        if (!operation.record.owner.beginIssued) {
          // Peers can fail while endpoint removal propagates. Reconfirm surviving
          // owners at the admission fence even when no autoscaler supplies metrics.
          await checkRetirementCapacity(pod, workload);
          await checkHeadroom({ stage: 'retirement', departing: pod, workload });
          await proxyContinuity?.verify(operation);
          await checkpoint({ owner: { ...operation.record.owner, beginIssued: true } });
          assertLease();
          await begin(pod, owner.operationId, owner.incarnation);
        }
      };

      if (operation.record.phase === 'preflight') {
        await safety.checkOwnedBaseline(operation.record, runner, now);
        await measure('handoff:bridge', () => proxyContinuity?.prepare(operation));
        await safety.checkOwnedBaseline(operation.record, runner, now);
        await checkHeadroom({ stage: 'preflight' });
        await checkpoint({ phase: 'templates' });
        assertLease();
        safety.assertReadyForTemplates();
        await measure('templates', () => applyTemplates(operation)); // Never replaces OnDelete owners.
      } else if (operation.record.phase === 'templates') {
        // Helm may have committed without its acknowledgement. Template install is
        // declarative, but migrations are not replayed by recovery.
        if (
          !identity.ownerPoolTransition ||
          typeof verifyPoolPreparationTemplates !== 'function' ||
          !(await verifyPoolPreparationTemplates())
        )
          throw new Error('HA template acknowledgement is unknown. Verify Helm/schema state before recovery.');
      }
      await checkpoint({ phase: 'owners' });
      await proxyContinuity?.verify(operation);
      for (const workload of workloads) {
        const w = workload;
        const elastic = w.role === 'execution' && identity.cooperativeScaling?.workload === w.name;
        if (operation.record.completed.includes(w.name) && !elastic) continue;
        const surgeName = `${w.name}-${w.replicas}`;
        const serial = w.role === 'maintenance' || (controlPlaneMode === 'singleton' && w.role === 'backend');
        // A fresh rollout may leave a whole workload unchanged. Check the desired
        // revision as well as the image, and confirm each serving incarnation,
        // before avoiding a surge that would itself need a full retirement.
        // Recovery retains the old path: a surge may already exist even when its
        // scale acknowledgement or first owner checkpoint was lost.
        if (!serial && (!recovering || elastic) && !operation.record.owner) {
          let unchanged = true;
          for await (const name of ownerNames(w)) {
            assertLease();
            const pod = await observePod(name);
            if (!pod?.ready || !(await isCurrentPod(pod, w))) {
              unchanged = false;
              break;
            }
            const current = assertHaRetirement(await status(pod));
            const confirmed = await observePod(pod.name);
            if (current.state !== 'serving' || current.operationId || confirmed?.uid !== pod.uid || !confirmed.ready) {
              unchanged = false;
              break;
            }
          }
          if (unchanged) {
            if (!operation.record.completed.includes(w.name))
              await checkpoint({ completed: [...operation.record.completed, w.name] });
            continue;
          }
        }
        if (!serial && operation.record.owner?.name !== surgeName) {
          assertLease();
          const target = elastic ? Math.min(w.replicas + 1, identity.cooperativeScaling.maxReplicas) : w.replicas + 1;
          await scale(w.name, target, w.replicas);
          if (elastic && target > w.replicas) {
            // Autoscaling may already have filled this ordinal from the old
            // OnDelete template. It supplies capacity; reconcile it below rather
            // than waiting for an image/revision change the controller cannot do.
            const peer = await availableOwner(surgeName);
            const current = assertHaRetirement(await status(peer));
            if (current.state !== 'serving' || current.operationId)
              throw Error(`HA capacity owner ${surgeName} is already retiring; resume its recorded operation.`);
          } else if (target > w.replicas) await waitForReady(surgeName, w.image);
        }
        for await (const name of ownerNames(w)) {
          let pod = await observePod(name);
          if (!pod && operation.record.owner?.name === name) {
            // The recorded UID may already be deleted after a lost API ack.
            // Wait for its candidate replacement; never replay that deletion.
            await measure(`ready:${name}`, () => waitForReady(name, w.image));
            await checkpoint({ owner: null });
            continue;
          }
          if (elastic && operation.record.owner?.name !== name && !pod?.ready) pod = await availableOwner(name);
          if (!pod) throw new Error(`HA owner ${name} disappeared before retirement.`);
          if ((await isCurrentPod(pod, w)) && (!operation.record.owner || operation.record.owner.name !== name)) {
            await waitForReady(name, w.image);
            continue;
          }
          if (!operation.record.owner) {
            const before = assertHaRetirement(await status(pod));
            if (before.state !== 'serving' || before.operationId) throw new Error('HA owner is already retiring.');
            await checkpoint({
              owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid(), beginIssued: false },
            });
          }
          const owner = operation.record.owner;
          if (owner.name !== name) throw new Error('HA owner recovery order is inconsistent.');
          if (pod.uid !== owner.uid) {
            // Only the exact recorded UID was ever eligible for deletion. A new
            // owner must be current-image and ready, never receive the old command.
            await waitForReady(name, w.image);
            await checkpoint({ owner: null });
            continue;
          }
          await startRetirement(pod, w);
          const deadline = now() + timeoutMs;
          await measure(`work:${name}`, async () => {
            while (true) {
              assertLease();
              pod = await observePod(name);
              if (pod?.uid !== owner.uid) throw new Error('HA pod changed while its outcome was pending.');
              const current = assertHaRetirement(await status(pod), owner.incarnation, owner.operationId);
              if (current.state === 'drained') break;
              if (now() >= deadline) throw new Error('Accepted work is still active; owner was not deleted.');
              await wait();
            }
          });
          await waitForWithdrawal(pod);
          assertLease();
          // The adapter must use a Kubernetes UID precondition, not kubectl delete --force.
          await removePod(pod);
          await measure(`ready:${name}`, () => waitForReady(name, w.image));
          await checkpoint({ owner: null });
        }
        if (!serial && !elastic) {
          // The surge may have accepted work. Retire it before scaling it away.
          const name = surgeName;
          if (!operation.record.owner?.scaleDownIssued) {
            const pod = await observePod(name);
            if (!pod) throw new Error('HA surge disappeared before its scale-down was recorded.');
            if (!operation.record.owner) {
              const before = assertHaRetirement(await status(pod));
              if (before.state !== 'serving' || before.operationId) throw new Error('HA surge is already retiring.');
              await checkpoint({
                owner: { name, uid: pod.uid, incarnation: before.incarnation, operationId: uuid(), beginIssued: false },
              });
            }
            const owner = operation.record.owner;
            if (owner.name !== name || owner.uid !== pod.uid) throw new Error('HA surge owner changed.');
            await startRetirement(pod, w);
            const deadline = now() + timeoutMs;
            await measure(`work:${name}`, async () => {
              while (true) {
                assertLease();
                if ((await observePod(name))?.uid !== pod.uid) throw new Error('HA surge identity changed.');
                if (assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state === 'drained')
                  break;
                if (now() >= deadline) throw new Error('Surge work is still active; owner was not scaled down.');
                await wait();
              }
            });
            await waitForWithdrawal(pod);
            await checkpoint({ owner: { ...operation.record.owner, scaleDownIssued: true } });
            assertLease();
            await scale(w.name, w.replicas, w.replicas + 1, owner);
          }
          // A lost scale acknowledgement must not recreate a surge or replay the
          // command against a replacement owner. Observe the recorded removal,
          // including actual pod deletion, before restoring autoscalers.
          await measure(`ready:${surgeName}`, () => waitForScaleDown(w, operation.record.owner));
        }
        await checkpoint({ owner: null, completed: [...new Set([...operation.record.completed, w.name])] });
      }
      // Journal completion is historical evidence, not a readiness or identity
      // guarantee about an owner that may have changed while another tier drained.
      const verifyCompletedOwners = async () => {
        for (const w of workloads)
          for await (const name of ownerNames(w)) {
            assertLease();
            const pod = await observePod(name);
            if (!pod?.ready || !(await isCurrentPod(pod, w)))
              throw new Error('HA completed owner is no longer current and ready; completion is blocked.');
            const current = assertHaRetirement(await status(pod));
            if (current.state !== 'serving' || current.operationId)
              throw new Error('HA completed owner is retiring; completion is blocked.');
            if (
              w.role === 'backend' &&
              controlPlaneMode === 'singleton-overlap' &&
              (current.housekeeping?.protocol !== 1 ||
                current.housekeeping.state !== 'owner' ||
                current.housekeeping.podUid !== pod.uid)
            )
              throw Error('Final backend housekeeping ownership is unconfirmed.');
            const confirmed = await observePod(pod.name);
            if (confirmed?.uid !== pod.uid || !confirmed.ready || !(await isCurrentPod(confirmed, w)))
              throw new Error('HA completed owner changed during verification; completion is blocked.');
          }
      };
      await verifyCompletedOwners();
      assertLease();
      await measure('handoff:return', () => proxyContinuity?.beforeRestoreAutoscalers?.(operation));
      await restoreAutoscalers(operation);
      await measure('handoff:final-routing', () => proxyContinuity?.afterRestoreAutoscalers?.(operation));
      await verifyCompletedOwners();
      safety.confirmSettlement(await measure('settlement', () => settle()));
      await measure('handoff:cleanup', () => proxyContinuity?.finish(operation));
      if (proxyContinuity) safety.confirmSettlement(await measure('settlement:after-bridge', () => settle()));
      assertLease();
      await verifyCompletedOwners();
      await operation.complete();
      return operation.record;
    },
  });
}
