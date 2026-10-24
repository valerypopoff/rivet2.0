import { createHash, randomUUID } from 'node:crypto';
import { journalForReleaseOperation } from './release-operation-journal.mjs';

export function autoscalerPolicy(input) {
  const policy = {
    minReplicas: 2,
    maxReplicas: 10,
    targetSlotsPercent: 60,
    targetCpuPercent: 75,
    stabilizationSeconds: 300,
    cooldownSeconds: 60,
    withdrawalSeconds: 60,
    pollSeconds: 15,
    metricsMaxAgeSeconds: 90,
    ...input,
  };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid autoscaler policy: ${key}.`);
  }
  if (
    policy.minReplicas < 2 ||
    policy.maxReplicas < policy.minReplicas ||
    policy.maxReplicas > 100 ||
    policy.targetSlotsPercent > 90 ||
    policy.targetCpuPercent > 90 ||
    policy.stabilizationSeconds < 2 * policy.pollSeconds ||
    policy.withdrawalSeconds < 1
  )
    throw new Error('Autoscaler bounds or stabilization are unsafe.');
  return policy;
}

export const autoscalerPolicyDigest = (policy) =>
  createHash('sha256')
    .update(JSON.stringify(autoscalerPolicy(policy)))
    .digest('hex');

/** Includes occupied slots on a withdrawing owner: accepted work is still load.
 * Missing owners/metrics never produce a low-demand recommendation. */
export function recommendExecutionReplicas(snapshot, policy) {
  if (
    !Number.isSafeInteger(snapshot.replicas) ||
    snapshot.replicas < policy.minReplicas ||
    snapshot.replicas > policy.maxReplicas ||
    snapshot.pods.length !== snapshot.replicas
  )
    throw new Error('Execution inventory is incomplete or outside approved bounds.');
  let slots = 0,
    cpu = 0,
    limits = new Set();
  const names = new Set(),
    uids = new Set(),
    ordinals = new Set();
  for (const pod of snapshot.pods) {
    if (
      names.has(pod.name) ||
      uids.has(pod.uid) ||
      !Number.isSafeInteger(pod.ordinal) ||
      pod.ordinal < 0 ||
      pod.ordinal >= snapshot.replicas ||
      ordinals.has(pod.ordinal) ||
      !pod.uid ||
      !pod.incarnation ||
      pod.terminating ||
      !pod.sampleFresh ||
      !Number.isFinite(pod.active) ||
      pod.active < 0 ||
      !Number.isSafeInteger(pod.limit) ||
      pod.limit < 1 ||
      !Number.isFinite(pod.cpuRatio) ||
      pod.cpuRatio < 0 ||
      !['serving', 'withdrawing', 'checking', 'draining', 'drained'].includes(pod.state) ||
      (pod.state === 'serving' && (!pod.ready || pod.operationId))
    )
      throw new Error('Execution demand or process identity is unconfirmed.');
    names.add(pod.name);
    uids.add(pod.uid);
    ordinals.add(pod.ordinal);
    limits.add(pod.limit);
    slots += pod.active;
    cpu += pod.cpuRatio;
  }
  if (limits.size !== 1) throw new Error('Execution admission limits differ; wait for the owned deployment.');
  return Math.min(
    policy.maxReplicas,
    Math.max(
      policy.minReplicas,
      Math.ceil(slots / (([...limits][0] * policy.targetSlotsPercent) / 100)),
      Math.ceil(cpu / (policy.targetCpuPercent / 100)),
    ),
  );
}

const routingObservationEpochs = new WeakMap();

/** During an HA roll only monotonic growth is shared. The deployer never
 * removes an execution ordinal or reduces its replica count in this mode. */
async function scaleUpDuringRollout({
  io,
  record,
  release,
  namespace,
  manifestDigest,
  workload,
  image,
  policy,
  shouldStop,
  now,
}) {
  journalForReleaseOperation(record, 'ha', { release, namespace }, now);
  const binding = record.cooperativeScaling;
  if (
    record.phase === 'preflight' &&
    record.leaseExpiresAt <= now() &&
    !record.owner &&
    record.completed?.length === 0 &&
    record.previousManifestDigest === manifestDigest &&
    binding?.previousImage === image &&
    binding.workload === workload &&
    record.workloads?.some((w) => w.name === workload && w.uid === binding.uid && w.role === 'execution')
  ) {
    const snapshot = await io.snapshot({ demand: false });
    if (snapshot.uid !== binding.uid || snapshot.startupFence || shouldStop())
      throw Error('Abandoned HA preflight baseline is unconfirmed.');
    // Preflight is durably before every template/retirement command. CAS-close
    // only that expired, untouched attempt so the installed controller can
    // resume its ordinary policy on the next tick, without metrics or replay.
    await io.writeJournal(
      {
        ...record,
        phase: 'complete',
        abortedBeforeTemplates: true,
        runner: `preflight-recovery-${record.runner}`,
        leaseExpiresAt: now(),
      },
      record.resourceVersion,
    );
    return { state: 'rollout-preflight-released' };
  }
  if (
    binding?.protocol !== 1 ||
    binding.workload !== workload ||
    binding.image !== image ||
    binding.policyDigest !== autoscalerPolicyDigest(policy) ||
    record.manifestDigest !== manifestDigest ||
    binding.maxReplicas !== policy.maxReplicas ||
    !binding.uid ||
    !record.workloads?.some((w) => w.name === workload && w.uid === binding.uid && w.role === 'execution')
  )
    throw new Error('HA scale-up requires the exact rollout workload, image and policy.');
  const snapshot = await io.snapshot();
  if (
    snapshot.uid !== binding.uid ||
    !snapshot.resourceVersion ||
    snapshot.startupFence ||
    snapshot.pods.some((pod) => pod.operationId && pod.operationId !== record.owner?.operationId)
  )
    throw new Error('HA scale-up owner or retirement is unconfirmed.');
  const demand = recommendExecutionReplicas(snapshot, policy);
  const retiring = record.owner?.name?.startsWith(`${binding.workload}-`) === true;
  const desired = Math.min(policy.maxReplicas, demand + (retiring ? 1 : 0));
  if (desired <= snapshot.replicas) return { state: 'rollout-observing', desired, scaleDownPaused: true };
  const confirmed = await io.readJournal();
  if (
    shouldStop() ||
    confirmed?.resourceVersion !== record.resourceVersion ||
    confirmed.token !== record.token ||
    confirmed.protocol !== 1 ||
    confirmed.phase === 'complete'
  )
    throw new Error('HA scale-up ownership changed; obtain a fresh observation.');
  // UID/current-replica/resourceVersion preconditions in IO prevent concurrent
  // growth from overwriting another successful increase. Lost replies are
  // resolved by the next fresh snapshot; no withdrawal or deletion is issued.
  await io.scale(snapshot.uid, snapshot.replicas, desired, snapshot.resourceVersion);
  return { state: 'rollout-scaled-up', replicas: desired, scaleDownPaused: true };
}

/** One bounded reconciliation, no background mutations or automatic retries.
 * The shared deployment journal is also our lease. An unfinished retirement
 * remains owned across controller restarts and blocks competing release tools.
 * API failures after a write are observed on a later tick, never replayed. */
export async function reconcileExecutionAutoscaling(options) {
  try {
    return await reconcileExecutionAutoscalingTick(options);
  } catch (error) {
    // A journal GET/CAS failure may prevent persisting the reset below. Keep a
    // process-local epoch too, so a short outage never revives old route proof.
    if (options.io && typeof options.io === 'object') routingObservationEpochs.set(options.io, randomUUID());
    throw error;
  }
}

async function reconcileExecutionAutoscalingTick({
  io,
  release,
  namespace,
  manifestDigest,
  policy: input,
  runner,
  workload,
  image,
  now = Date.now,
  uuid = randomUUID,
  shouldStop = () => false,
}) {
  if (![release, namespace, manifestDigest, runner].every((value) => typeof value === 'string' && value.length > 0))
    throw new Error('Autoscaler release identity is incomplete.');
  const policy = autoscalerPolicy(input),
    policyDigest = autoscalerPolicyDigest(policy);
  const observed = await io.readJournal();
  if (observed?.protocol === 1 && observed.phase !== 'complete' && observed.cooperativeScaling)
    return scaleUpDuringRollout({
      io,
      record: observed,
      release,
      namespace,
      manifestDigest,
      workload,
      image,
      policy,
      shouldStop,
      now,
    });
  const prior = journalForReleaseOperation(observed, 'autoscaling', { release, namespace }, now);
  if (prior?.leaseExpiresAt > now() && prior.runner !== runner) return { state: 'leased' };
  if (
    prior &&
    prior.phase !== 'complete' &&
    (prior.manifestDigest !== manifestDigest || prior.policyDigest !== policyDigest)
  )
    throw new Error('An unfinished autoscaling operation requires its original image and policy.');
  if (prior && prior.phase !== 'complete' && !prior.target && prior.phase !== 'scaling')
    throw new Error('Autoscaling operation identity is incomplete.');
  if (
    prior?.target &&
    (!prior.target.name ||
      !prior.target.uid ||
      !prior.target.incarnation ||
      !prior.target.workloadUid ||
      !prior.target.operationId ||
      !Number.isFinite(prior.target.withdrawnAt))
  )
    throw new Error('Autoscaling retirement identity is incomplete.');
  let record = prior ?? {
    autoscalingProtocol: 1,
    release,
    namespace,
    phase: 'complete',
    token: uuid(),
    manifestDigest,
    policyDigest,
    lastScaleAt: 0,
    lowSince: null,
    lastSampleAt: null,
  };
  if (record.phase === 'complete' && (record.manifestDigest !== manifestDigest || record.policyDigest !== policyDigest))
    record = { ...record, lowSince: null, lastSampleAt: null };
  const previousRoutingAbsence = record.phase === 'withdrawing' ? record.target.routingAbsence : null;
  record = await io.writeJournal(
    {
      ...record,
      manifestDigest,
      policyDigest,
      runner,
      leaseExpiresAt: now() + 120000,
      // Clear proof before any observation can fail. Only a successful route
      // sample below restores it; restarts and interrupted ticks start afresh.
      ...(record.phase === 'withdrawing' ? { target: { ...record.target, routingAbsence: null } } : {}),
    },
    observed?.resourceVersion,
  );
  const save = async (changes) => {
    if (shouldStop()) throw new Error('Autoscaler is stopping; mutations fenced.');
    if (record.leaseExpiresAt <= now()) throw new Error('Autoscaler lease expired; mutations fenced.');
    record = await io.writeJournal(
      { ...record, ...changes, runner, leaseExpiresAt: now() + 120000 },
      record.resourceVersion,
    );
  };
  const fenced = async () => {
    if (shouldStop()) throw new Error('Autoscaler is stopping; mutations fenced.');
    const owner = await io.readJournal();
    if (
      owner?.token !== record.token ||
      owner.runner !== runner ||
      owner.resourceVersion !== record.resourceVersion ||
      owner.leaseExpiresAt <= now()
    )
      throw new Error('Autoscaler ownership changed; mutations fenced.');
    // The peer/status reads preceding an action can consume most of a lease.
    // CAS-renew after confirming ownership so the bounded mutating request
    // starts with a full window, never the last milliseconds of an old lease.
    await save({});
  };
  const scale = async (snapshot, replicas, nextPhase) => {
    await save({ phase: 'scaling', scale: { uid: snapshot.uid, from: snapshot.replicas, to: replicas, nextPhase } });
    await fenced();
    await io.scale(snapshot.uid, snapshot.replicas, replicas);
    // A lost acknowledgement leaves the durable intent for observation only.
    await save({ phase: nextPhase, scale: null, lastScaleAt: now(), lowSince: null });
  };
  let completedObservation = false;
  try {
    // Completion of an already-issued removal is not a load decision. In
    // particular, a Metrics API outage must not strand an otherwise settled
    // retirement or prevent the shared deployment journal from being released.
    const recovering = ['scaling', 'removing', 'unfencing'].includes(record.phase);
    const snapshot = await io.snapshot({
      demand: !recovering,
      replacement: record.phase === 'removing' && record.removal.replace ? record.target.name : null,
    });
    if (record.phase === 'complete' && snapshot.startupFence)
      throw new Error('An unowned execution startup fence requires inspection.');
    if (record.phase === 'scaling') {
      if (snapshot.uid !== record.scale.uid || snapshot.replicas !== record.scale.to)
        throw new Error('Scale intent is unconfirmed; inspect it rather than replaying the write.');
      await save({ phase: record.scale.nextPhase, scale: null, lastScaleAt: now(), lowSince: null });
      return { state: 'scale-observed' }; // Next tick obtains demand before another capacity decision.
    }
    if (record.phase === 'unfencing') {
      if (await io.isFenced(record.target))
        throw new Error('Startup-unfence intent is unconfirmed; inspect without replaying.');
      await save({ phase: 'complete', target: null, removal: null, lastScaleAt: now(), lowSince: null });
      return { state: 'settled' };
    }
    if (record.phase === 'removing') {
      if (snapshot.uid !== record.removal.workloadUid || snapshot.replicas !== record.removal.replicas)
        throw new Error('Execution workload changed during removal.');
      const old = snapshot.pods.find((p) => p.uid === record.target.uid);
      const replacement = snapshot.pods.find((p) => p.name === record.target.name);
      if (!record.removal.replace && replacement && replacement.uid !== record.target.uid)
        throw new Error('Retired execution ordinal was recreated; removal is unconfirmed.');
      if (old || (record.removal.replace && (!replacement?.ready || replacement.state !== 'serving')))
        return { state: 'waiting-for-removal' };
      await save({ phase: 'unfencing' });
      await fenced();
      await io.clearFence(record.target);
      return { state: 'unfencing' };
    }
    const desired = recommendExecutionReplicas(snapshot, policy);
    completedObservation = true;
    if (snapshot.uid !== (record.target?.workloadUid ?? snapshot.uid))
      throw new Error('Execution StatefulSet was replaced during retirement.');
    const retiring = record.phase !== 'complete';
    const target = retiring ? snapshot.pods.find((p) => p.name === record.target.name) : null;
    if (retiring && (!target || target.uid !== record.target.uid || target.incarnation !== record.target.incarnation))
      throw new Error('Retiring owner changed; no further mutations allowed.');
    if (snapshot.pods.some((p) => p.operationId && p.operationId !== record.target?.operationId))
      throw new Error('Another retirement owns an execution process.');
    // Add a replacement slot during retirement, bounded by the same approved cap.
    const wanted = Math.min(policy.maxReplicas, desired + (retiring ? 1 : 0));
    if (wanted > snapshot.replicas) {
      await scale(snapshot, wanted, record.phase);
      return { state: 'scaled-up', replicas: wanted };
    }
    if (!retiring) {
      const low = desired < snapshot.replicas;
      const continuous = record.lastSampleAt !== null && now() - record.lastSampleAt <= policy.pollSeconds * 2500;
      const lowSince = low ? (continuous ? record.lowSince ?? now() : now()) : null;
      await save({ lowSince, lastSampleAt: now() });
      if (
        !low ||
        now() - lowSince < policy.stabilizationSeconds * 1000 ||
        now() - record.lastScaleAt < policy.cooldownSeconds * 1000
      )
        return { state: 'observing', desired };
      const tail = snapshot.pods.find((p) => p.ordinal === snapshot.replicas - 1);
      const peers = snapshot.pods.filter(
        (p) => p.uid !== tail?.uid && p.ready && p.state === 'serving' && !p.operationId,
      );
      if (!tail || peers.length < 2) throw new Error('Two serving peers are required before withdrawing an owner.');
      await save({
        phase: 'fencing',
        target: {
          name: tail.name,
          uid: tail.uid,
          incarnation: tail.incarnation,
          workloadUid: snapshot.uid,
          operationId: uuid(),
          withdrawnAt: now(),
        },
        lowSince: null,
      });
      await io.confirmPeers(record.target, snapshot.pods);
      await fenced();
      await io.fence(record.target);
      return { state: 'fencing' };
    }
    if (record.phase === 'fencing') {
      if (!(await io.isFenced(record.target)))
        throw new Error('Startup-fence intent is unconfirmed; inspect without replaying.');
      if (!(await io.fenceObserved(record.target))) return { state: 'waiting-for-startup-fence' };
      await io.confirmPeers(record.target, snapshot.pods);
      await save({ phase: 'withdrawing', target: { ...record.target, withdrawnAt: now() } });
      await fenced();
      await io.retire(record.target, 'withdraw');
      return { state: 'withdrawing' };
    }
    if (target.operationId !== record.target.operationId)
      throw new Error('Retirement intent is unconfirmed; do not replay an uncertain command.');
    if (record.phase === 'withdrawing') {
      if (target.state === 'checking') return { state: 'checking-withdrawal' };
      if (target.state !== 'withdrawing') throw new Error('Unexpected withdrawal state.');
      if (await io.routed(record.target)) return { state: 'waiting-for-routing' };
      const observedAt = now();
      const epoch = routingObservationEpochs.get(io) ?? null;
      const continuous =
        previousRoutingAbsence?.runner === runner &&
        previousRoutingAbsence.epoch === epoch &&
        Number.isFinite(previousRoutingAbsence.since) &&
        Number.isFinite(previousRoutingAbsence.observedAt) &&
        previousRoutingAbsence.since <= previousRoutingAbsence.observedAt &&
        previousRoutingAbsence.observedAt <= observedAt &&
        observedAt - previousRoutingAbsence.observedAt <= policy.pollSeconds * 2500;
      const routingAbsence = {
        runner,
        epoch,
        since: continuous ? previousRoutingAbsence.since : observedAt,
        observedAt,
      };
      const observedTarget = { ...record.target, routingAbsence };
      if (observedAt - routingAbsence.since < policy.withdrawalSeconds * 1000) {
        await save({ target: observedTarget });
        return { state: 'waiting-for-routing' };
      }
      await save({ phase: 'draining', target: observedTarget });
      await fenced();
      await io.retire(record.target, 'begin');
      return { state: 'draining' };
    }
    if (record.phase !== 'draining' || !['checking', 'draining', 'drained'].includes(target.state))
      throw new Error('Drain intent is unconfirmed; inspect without replaying.');
    if (target.state !== 'drained') return { state: 'waiting-for-work' };
    // A load spike may have added higher ordinals. Never remove those to reach
    // the old tail: replace only the exact drained UID, preserving capacity.
    const replace = target.ordinal !== snapshot.replicas - 1 || desired >= snapshot.replicas;
    if (snapshot.pods.filter((p) => p.uid !== target.uid && p.ready && p.state === 'serving').length < 2)
      throw new Error('Serving capacity changed; drained owner will not be removed.');
    await save({
      phase: 'removing',
      removal: { replace, workloadUid: snapshot.uid, replicas: snapshot.replicas - (replace ? 0 : 1) },
    });
    await io.confirmPeers(record.target, snapshot.pods);
    await fenced();
    if (replace) {
      // After drain, clearing the startup fence is safe only for UID-precondition
      // deletion; a newly created owner can never be deleted by this command.
      await io.clearFence(record.target);
      await fenced();
      await io.remove(record.target);
    } else {
      if (!(await io.fenceObserved(record.target))) throw new Error('Startup fencing changed before scale-down.');
      await io.confirmDrained(record.target);
      await fenced();
      await io.scale(snapshot.uid, snapshot.replicas, snapshot.replicas - 1);
    }
    return { state: replace ? 'replacing-drained-owner' : 'scaled-down' };
  } finally {
    // Do not overwrite another runner after an uncertain journal write. Failed
    // observations reset the low-load window, so missing samples never shrink.
    const owner = await io.readJournal();
    if (owner?.resourceVersion === record.resourceVersion && owner.runner === runner && owner.token === record.token) {
      await io.writeJournal(
        {
          ...record,
          leaseExpiresAt: now(),
          ...(!completedObservation && record.phase === 'complete' ? { lowSince: null, lastSampleAt: null } : {}),
        },
        record.resourceVersion,
      );
    }
  }
}
