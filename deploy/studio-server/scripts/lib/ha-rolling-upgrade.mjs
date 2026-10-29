import { randomUUID } from 'node:crypto';
import { runDeploymentOperation } from './deployment-operation.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';
import { haPreparationSettled } from './release-operation-journal.mjs';

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
  checkHeadroom = async () => {},
  prepareReplacements = async () => {},
  settle,
  handoverHousekeeping,
  verifyPoolPreparationTemplates,
}) {
  requireDeploymentSafety(safety, 'rolling', identity);
  settle = safety.requireSettlement(settle);
  identity = safety.bind(identity);
  const controlPlaneMode = identity.controlPlaneMode ?? 'replicated';
  if (controlPlaneMode === 'singleton-overlap' && typeof handoverHousekeeping !== 'function')
    throw Error('Overlapping backends require the housekeeping handover contract.');
  assertHaRolloutPlan(workloads, controlPlaneMode);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid HA deadline.');
  const runner = uuid();
  const record = await readJournal();
  let initial;
  const recovering = !!record && record.phase !== 'complete';
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
    safety.assertRecovery(record);
    if (JSON.stringify(record.workloads) !== JSON.stringify(workloads))
      throw new Error('HA recovery inventory changed.');
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
    now,
    setHeartbeat,
    clearHeartbeat,
    onFailure: async (_error, operation) => {
      // Preflight has not issued a template command. Never abandon later phases.
      if (operation.record.phase === 'preflight' && !operation.failure && haPreparationSettled(operation.record)) {
        operation.assertLease();
        await operation.complete({ abortedBeforeTemplates: true });
      }
    },
    run: async (operation) => {
      const { checkpoint, assertLease } = operation;
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
        await waitForRoutingWithdrawal(pod);
        if (!operation.record.owner.beginIssued) {
          // Peers can fail while endpoint removal propagates. Reconfirm surviving
          // owners at the admission fence even when no autoscaler supplies metrics.
          await checkRetirementCapacity(pod, workload);
          await checkHeadroom({ stage: 'retirement', departing: pod, workload });
          await checkpoint({ owner: { ...operation.record.owner, beginIssued: true } });
          assertLease();
          await begin(pod, owner.operationId, owner.incarnation);
        }
      };

      if (operation.record.phase === 'preflight') {
        await safety.checkOwnedBaseline(operation.record, runner, now);
        await prepareReplacements(operation);
        await safety.checkOwnedBaseline(operation.record, runner, now);
        await checkHeadroom({ stage: 'preflight' });
        await checkpoint({ phase: 'templates' });
        assertLease();
        safety.assertReadyForTemplates();
        await applyTemplates(); // Applies the owned scaling policy; never replaces OnDelete owners.
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
      for (const workload of workloads) {
        const w = workload;
        const elastic = w.role === 'execution' && identity.cooperativeScaling?.workload === w.name;
        if (operation.record.completed.includes(w.name)) continue;
        const surgeName = `${w.name}-${w.replicas}`;
        const serial = w.role === 'maintenance' || (controlPlaneMode === 'singleton' && w.role === 'backend');
        // A fresh rollout may leave a whole workload unchanged. Check the desired
        // revision as well as the image, and confirm each serving incarnation,
        // before avoiding a surge that would itself need a full retirement.
        // Recovery retains the old path: a surge may already exist even when its
        // scale acknowledgement or first owner checkpoint was lost.
        if (!serial && !recovering && !operation.record.owner) {
          let unchanged = true;
          for (let i = 0; i < w.replicas; i++) {
            assertLease();
            const pod = await observePod(`${w.name}-${i}`);
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
            await checkpoint({ completed: [...operation.record.completed, w.name] });
            continue;
          }
        }
        if (!serial && operation.record.owner?.name !== surgeName) {
          assertLease();
          const target = elastic ? Math.min(w.replicas + 1, identity.cooperativeScaling.maxReplicas) : w.replicas + 1;
          await scale(w.name, target, w.replicas);
          if (target > w.replicas) await waitForReady(surgeName, w.image);
        }
        for (let i = 0; i < w.replicas; i++) {
          const name = `${w.name}-${i}`;
          let pod = await observePod(name);
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
            while (true) {
              assertLease();
              if ((await observePod(name))?.uid !== pod.uid) throw new Error('HA surge identity changed.');
              if (assertHaRetirement(await status(pod), owner.incarnation, owner.operationId).state === 'drained')
                break;
              if (now() >= deadline) throw new Error('Surge work is still active; owner was not scaled down.');
              await wait();
            }
            await waitForWithdrawal(pod);
            await checkpoint({ owner: { ...operation.record.owner, scaleDownIssued: true } });
            assertLease();
            await scale(w.name, w.replicas, w.replicas + 1, owner);
          }
          // A lost scale acknowledgement must not recreate a surge or replay the
          // command against a replacement owner. Observe the recorded removal,
          // including actual pod deletion, before restoring autoscalers.
          await waitForScaleDown(w, operation.record.owner);
        }
        await checkpoint({ owner: null, completed: [...operation.record.completed, w.name] });
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
      await restoreAutoscalers();
      await verifyCompletedOwners();
      safety.confirmSettlement(await settle());
      assertLease();
      await verifyCompletedOwners();
      await operation.complete();
      return operation.record;
    },
  });
}
