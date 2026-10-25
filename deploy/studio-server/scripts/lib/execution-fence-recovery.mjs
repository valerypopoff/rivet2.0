import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { journalForReleaseOperation } from './release-operation-journal.mjs';
import { classifyStartupFence } from './execution-autoscaler-fence.mjs';

export function fenceRecoveryError(message) {
  return Object.assign(new Error(message), { code: 'rivet_fence_recovery' });
}

export const fenceRepairDigest = (plan) => `sha256:${createHash('sha256').update(JSON.stringify(plan)).digest('hex')}`;
const targetIdentity = (t) => ({
  name: t?.name,
  uid: t?.uid,
  workloadUid: t?.workloadUid,
  incarnation: t?.incarnation,
  operationId: t?.operationId,
});

function currentRepair(record) {
  const repair = record.fenceRepair;
  if (!repair) return null;
  if (
    repair.protocol !== 1 ||
    !repair.target ||
    typeof repair.confirmed !== 'boolean' ||
    typeof repair.planDigest !== 'string' ||
    typeof repair.before !== 'string'
  )
    throw fenceRecoveryError('Recovery intent format is unconfirmed.');
  if (isDeepStrictEqual(repair.target, targetIdentity(record.target))) return repair;
  if (!repair.confirmed) throw fenceRecoveryError('An unfinished recovery owns another retirement target.');
  return null; // A legacy controller preserves additive fields across completed retirements.
}

function validateRecord(record, binding) {
  journalForReleaseOperation(record, 'autoscaling', binding);
  if (
    !record ||
    record.phase !== 'fencing' ||
    record.fence ||
    record.manifestDigest !== binding.manifestDigest ||
    record.policyDigest !== binding.policyDigest ||
    !record.target ||
    Object.values(targetIdentity(record.target)).some((v) => typeof v !== 'string' || !v) ||
    !record.target.name.startsWith(`${binding.workload}-`)
  )
    throw fenceRecoveryError('Only the exact legacy fencing operation can be repaired.');
}

export async function prepareExecutionFenceRepair({ io, binding, now = Date.now }) {
  const record = await io.readJournal();
  validateRecord(record, binding);
  await io.verifyRepairBinding(binding, record.target);
  const prior = currentRepair(record);
  const observed = await io.inspectFence(record.target);
  if (
    observed.template !== record.target.name ||
    (prior
      ? (observed.pod !== prior.before && observed.pod !== record.target.name) ||
        (prior.confirmed && observed.pod !== record.target.name)
      : observed.podKind !== 'inherited')
  )
    throw fenceRecoveryError(
      'Recovery requires the recorded template fence and a nonmatching same-workload pod annotation.',
    );
  const createdAt = now();
  return {
    protocol: 1,
    kind: 'rivet-execution-fence-repair',
    createdAt,
    expiresAt: createdAt + 900000,
    binding: structuredClone(binding),
    token: record.token,
    target: targetIdentity(record.target),
    before: prior?.before ?? observed.pod,
    ...(prior ? { supersedes: prior.planDigest } : {}),
  };
}

/** Operator-only metadata repair. Original release/policy and operation token stay intact. */
export async function applyExecutionFenceRepair({
  io,
  plan,
  confirmation,
  now = Date.now,
  runner = `fence-repair-${randomUUID()}`,
}) {
  const digest = fenceRepairDigest(plan);
  if (
    plan?.protocol !== 1 ||
    plan.kind !== 'rivet-execution-fence-repair' ||
    confirmation !== digest ||
    !Number.isFinite(plan.createdAt) ||
    plan.createdAt > now() ||
    !Number.isFinite(plan.expiresAt) ||
    plan.expiresAt - plan.createdAt !== 900000 ||
    plan.expiresAt <= now()
  )
    throw fenceRecoveryError('A current exact recovery plan and its confirmation digest are required.');
  if (classifyStartupFence(plan.before, plan.target.name, plan.binding.workload) !== 'inherited')
    throw fenceRecoveryError('Recovery plan does not describe an inherited startup fence.');
  const check = async (r, peers = false) => {
    validateRecord(r, plan.binding);
    if (r.token !== plan.token || !isDeepStrictEqual(targetIdentity(r.target), plan.target))
      throw fenceRecoveryError('Recovery operation or target identity changed.');
    await io.verifyRepairBinding(plan.binding, peers ? r.target : undefined);
  };
  let record = await io.readJournal();
  await check(record);
  if (plan.expiresAt <= now()) throw fenceRecoveryError('Recovery plan expired during installation inspection.');
  if (record.leaseExpiresAt > now())
    throw fenceRecoveryError('The original controller still holds a valid lease; wait and inspect.');
  const priorRepair = currentRepair(record);
  if (
    priorRepair
      ? (priorRepair.planDigest !== digest && priorRepair.planDigest !== plan.supersedes) ||
        priorRepair.before !== plan.before
      : plan.supersedes !== undefined
  )
    throw fenceRecoveryError('Another recovery intent owns this operation.');
  let owned, failure;
  try {
    // Journal intent is durable BEFORE the annotation write, including on acknowledgement loss.
    owned = await io.writeJournal(
      {
        ...record,
        runner,
        leaseExpiresAt: now() + 120000,
        fenceRepair: {
          ...priorRepair,
          protocol: 1,
          planDigest: digest,
          target: plan.target,
          before: plan.before,
          confirmed: priorRepair?.confirmed ?? false,
          ...(priorRepair && priorRepair.planDigest !== digest ? { previousPlanDigest: priorRepair.planDigest } : {}),
        },
      },
      record.resourceVersion,
    );
    const authorize = async (peers = false) => {
      const current = await io.readJournal();
      await check(current, peers);
      if (
        plan.expiresAt <= now() ||
        current.resourceVersion !== owned.resourceVersion ||
        current.runner !== runner ||
        current.leaseExpiresAt <= now()
      )
        throw fenceRecoveryError('Recovery lease changed or expired.');
      owned = await io.writeJournal({ ...current, leaseExpiresAt: now() + 120000 }, current.resourceVersion);
    };
    const intent = {
      protocol: 1,
      ...plan.target,
      steps: {
        template: { before: plan.target.name, confirmed: true },
        pod: { before: plan.before, confirmed: owned.fenceRepair.confirmed },
      },
    };
    await io.convergeFence(owned.target, intent, {
      authorize: () => authorize(true),
      confirm: async () => {
        await authorize();
        owned = await io.writeJournal(
          { ...owned, fenceRepair: { ...owned.fenceRepair, confirmed: true } },
          owned.resourceVersion,
        );
      },
    });
    if (!(await io.fenceObserved(owned.target)))
      throw fenceRecoveryError('Recovery fence generation is not observed; inspect before retrying.');
    return {
      protocol: 1,
      planDigest: digest,
      outcome: 'metadata-confirmed',
      target: plan.target.name,
      next: 'Original controller resumes normal withdrawal and accepted-work drain; no scale or deletion issued by repair.',
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Never overwrite a foreign runner or uncertain journal write just to release a lease.
    try {
      if (owned) {
        const current = await io.readJournal();
        if (
          current.resourceVersion === owned.resourceVersion &&
          current.runner === runner &&
          current.token === plan.token
        )
          await io.writeJournal({ ...current, leaseExpiresAt: now() }, current.resourceVersion);
      }
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'Recovery failed and lease release is unconfirmed.');
      throw error;
    }
  }
}
