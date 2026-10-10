import { randomUUID } from 'node:crypto';

const components = new Set(['backend', 'api', 'executor', 'execution', 'evaluation', 'proxy', 'web']);
const phases = new Set(['quiescing', 'quiesced', 'validating', 'resuming', 'complete']);
const resourceName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
function checkedInventory(resources) {
  if (
    !Array.isArray(resources?.workloads) ||
    !Array.isArray(resources?.autoscalers) ||
    resources.workloads.some(
      (item) =>
        !['deployment', 'statefulset'].includes(item.kind) ||
        !resourceName.test(item.name ?? '') ||
        !components.has(item.component) ||
        !Number.isInteger(item.replicas) ||
        item.replicas < 0,
    ) ||
    resources.autoscalers.some((name) => typeof name !== 'string' || !resourceName.test(name))
  )
    throw new Error('Unknown release workload: the cutover cannot prove complete reader ownership.');
  return resources;
}
export const maintenanceValidationValues = {
  workflowSchema: { maintenanceValidation: true },
  replicaCount: { proxy: 0, web: 0, evaluation: 0 },
  autoscaling: { proxy: { enabled: false }, execution: { enabled: false } },
};

export function blocksCutoverStop(pod) {
  // Failed/succeeded old migration hooks cannot read or write anymore. Helm
  // removes them when creating its next hook; waiting for them here deadlocks
  // recovery before that hook can run. Active hooks must still finish.
  return !(
    pod.metadata?.labels?.['app.kubernetes.io/component'] === 'workflow-schema-migration' &&
    ['Succeeded', 'Failed'].includes(pod.status?.phase)
  );
}

export function requiresMaintenanceCutover(manifest, installedValues) {
  if (!installedValues) return false;
  const current = installedValues.release?.production?.database?.managedWorkflowSchemaVersion;
  if (!Number.isInteger(current)) return true;
  return current < manifest.database.managedWorkflowSchema.minimumRollbackCompatibleVersion;
}

export function assertCutoverJournal(journal, { release, namespace }) {
  if (
    journal &&
    (journal.formatVersion !== 1 ||
      journal.release !== release ||
      journal.namespace !== namespace ||
      !phases.has(journal.phase) ||
      typeof journal.token !== 'string' ||
      !journal.token ||
      typeof journal.runner !== 'string' ||
      !journal.runner ||
      !Number.isFinite(journal.leaseExpiresAt) ||
      typeof journal.manifestDigest !== 'string' ||
      !journal.manifestDigest ||
      typeof journal.resourceVersion !== 'string' ||
      !journal.resourceVersion)
  )
    throw new Error('Cutover journal identity or format does not match this release.');
}

/** Even a completed journal is owned until its runner releases the lease. */
export function assertOrdinaryReleaseAllowed(journal, identity, now = Date.now) {
  assertCutoverJournal(journal, identity);
  if (!journal) return;
  if (journal.phase !== 'complete')
    throw new Error(
      `An unfinished cutover owns this release. Recover using --resume-cutover ${journal.token} and its exact manifest.`,
    );
  if (journal.leaseExpiresAt > now())
    throw new Error('Another cutover runner still owns the operation. Wait for its lease to expire.');
}

/** The journal is also a compare-and-swap ownership lease. Expiration never
 * reopens traffic: recovery requires the exact operation token and manifest. */
export async function runManagedReleaseCutover({
  release,
  namespace,
  manifestDigest,
  resumeToken,
  inventory,
  readJournal,
  createJournal,
  replaceJournal,
  scale,
  removeAutoscaler,
  waitForStopped,
  installValidation,
  validate,
  resume,
  now = Date.now,
  uuid = randomUUID,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval,
}) {
  const runner = uuid();
  let journal = await readJournal();
  assertCutoverJournal(journal, { release, namespace });
  if (journal?.leaseExpiresAt > now())
    throw new Error('Another cutover runner still owns the operation. Wait for its lease to expire.');
  if (journal && journal.phase !== 'complete') {
    if (resumeToken !== journal.token || journal.manifestDigest !== manifestDigest)
      throw new Error(
        `An unfinished cutover owns this release. Recover using --resume-cutover ${journal.token} and its exact manifest.`,
      );
  } else {
    if (resumeToken) throw new Error('No unfinished cutover matches the recovery token.');
    const resources = checkedInventory(await inventory());
    const workloads = resources.workloads;
    const next = {
      formatVersion: 1,
      token: uuid(),
      release,
      namespace,
      manifestDigest,
      phase: 'quiescing',
      runner,
      leaseExpiresAt: now() + 120_000,
      workloads,
      autoscalers: resources.autoscalers,
    };
    try {
      journal = journal ? await replaceJournal(next, journal.resourceVersion) : await createJournal(next);
    } catch (error) {
      // Nothing has been stopped yet, but the ownership write may have committed.
      // Never automatically retry a create/replace after losing its response.
      throw new Error(
        `Cutover ownership write is unconfirmed; no workloads were changed. Inspect journal token ${next.token} before recovery.`,
        { cause: error },
      );
    }
  }
  let ownershipConfirmed = journal.runner === runner;
  const persist = async (phase = journal.phase) => {
    // Only explicit recovery may claim an expired predecessor lease. Once this
    // runner owns it, expiration must fence renewal too, not just controller IO.
    if (ownershipConfirmed && journal.leaseExpiresAt <= now())
      throw new Error('Cutover runner lease expired; explicit recovery is required.');
    journal = await replaceJournal(
      { ...journal, phase, runner, leaseExpiresAt: now() + 120_000 },
      journal.resourceVersion,
    );
    ownershipConfirmed = true;
  };
  let renewalFailure;
  let renewing = Promise.resolve();
  let settling = false;
  // Serialize journal replacements; a failed renewal fences subsequent steps.
  const heartbeat = setHeartbeat(() => {
    if (settling || renewalFailure) return;
    renewing = renewing
      .then(() => persist())
      .catch((error) => {
        renewalFailure = error;
      });
  }, 30_000);
  heartbeat.unref?.();
  const stopRenewing = async () => {
    settling = true;
    clearHeartbeat(heartbeat);
    await renewing.catch(() => {});
  };
  const assertLease = () => {
    if (renewalFailure) throw renewalFailure;
    if (journal.leaseExpiresAt <= now()) throw new Error('Cutover runner lease expired; no further mutations allowed.');
  };
  const step = async (phase, operation) => {
    renewing = renewing.then(() => {
      if (renewalFailure) throw renewalFailure;
      return persist(phase);
    });
    await renewing;
    assertLease();
    await operation();
  };
  const closeAdmission = async () => {
    // Re-inventory by release label rather than trusting stale journal names.
    const current = checkedInventory(await inventory());
    for (const item of current.autoscalers) {
      assertLease();
      await removeAutoscaler(item);
    }
    // Close ingress first; normal pod termination then drains accepted work.
    const ordered = [...current.workloads].sort(
      (a, b) => Number(!['proxy', 'web'].includes(a.component)) - Number(!['proxy', 'web'].includes(b.component)),
    );
    for (const item of ordered) {
      assertLease();
      await scale(item, 0);
    }
  };
  try {
    // Recovery always re-quiesces and reruns verify-only validation. It never
    // assumes that a lost Helm acknowledgement means nothing committed.
    await step('quiescing', async () => {
      await closeAdmission();
      await waitForStopped();
    });
    await step('quiesced', async () => {});
    await step('validating', installValidation);
    await step('validating', validate);
    await step('resuming', resume);
    await stopRenewing();
    if (renewalFailure) throw renewalFailure;
    await step('complete', async () => {});
  } catch (error) {
    // Finish any in-flight renewal before inspecting or updating ownership.
    // Otherwise a late CAS can invalidate cleanup's resource version or phase.
    await stopRenewing();
    // No automatic rollback or resume. If final resume partly committed,
    // close admission again before handing control back to the operator.
    try {
      const owner = await readJournal();
      assertCutoverJournal(owner, { release, namespace });
      if (
        renewalFailure ||
        owner?.runner !== runner ||
        owner.token !== journal.token ||
        owner.manifestDigest !== manifestDigest ||
        owner.leaseExpiresAt <= now()
      )
        throw new Error('Cutover ownership is no longer confirmed; no further workload mutations are allowed.');
      journal = owner;
      if (owner.phase === 'complete') {
        // The completion CAS may have committed while its acknowledgement was
        // lost. Closing traffic must also restore durable recovery ownership;
        // otherwise a normal rollout could mistake the now-paused release for
        // a completed cutover and an exact-token recovery would be rejected.
        await persist('resuming');
      }
      await closeAdmission();
    } catch (closingError) {
      throw new AggregateError(
        [error, closingError],
        `Cutover failed and closing admission is unconfirmed. Inspect journal token ${journal.token}.`,
      );
    }
    throw new Error(`Cutover paused; no rollback was attempted. Recover with --resume-cutover ${journal.token}.`, {
      cause: error,
    });
  } finally {
    await stopRenewing();
    // The saved phase remains authoritative after a process restart.
    if (!renewalFailure) {
      try {
        await replaceJournal({ ...journal, leaseExpiresAt: now() }, journal.resourceVersion);
      } catch {
        /* Keep the saved lease/phase; a failed final acknowledgement is not a resume. */
      }
    }
  }
}
