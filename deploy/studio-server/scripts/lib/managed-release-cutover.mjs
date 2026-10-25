import { randomUUID } from 'node:crypto';
import { runDeploymentOperation } from './deployment-operation.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';

const components = new Set([
  'backend',
  'maintenance',
  'api',
  'executor',
  'execution',
  'evaluation',
  'proxy',
  'web',
  'autoscaler',
]);
const phases = new Set(['quiescing', 'quiesced', 'validating', 'resuming', 'complete']);
const resourceName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const planDigest = /^sha256:[a-f0-9]{64}$/;
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
  ha: { enabled: false, controlPlane: { mode: 'replicated' } },
  workflowSchema: { maintenanceValidation: true },
  // HA adoption validates a fenced singleton before restoring the full HA
  // profile. The GKE HA-only guard cannot apply to that temporary singleton;
  // the ordinary lint/render and resumed installation retain the real flag.
  availability: { gkeGateway: false },
  replicaCount: { proxy: 0, web: 0, evaluation: 0 },
  autoscaling: {
    executionController: { enabled: false },
    proxy: { enabled: false },
    web: { enabled: false },
    backend: { enabled: false },
    execution: { enabled: false },
  },
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
      (journal.operationPlanDigest !== undefined && !planDigest.test(journal.operationPlanDigest)) ||
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
  operationPlanDigest,
  admissionExpiresAt,
  safety,
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
  settle,
  stopValidationBeforeResume = false,
  now = Date.now,
  uuid = randomUUID,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval,
}) {
  requireDeploymentSafety(safety, 'maintenance', { release, namespace, manifestDigest });
  settle = safety.requireSettlement(settle);
  const safetyIdentity = safety.bind({ release, namespace, manifestDigest });
  const workflowIdentity = safetyIdentity.workflowIdentity;
  if (
    operationPlanDigest !== undefined &&
    (typeof operationPlanDigest !== 'string' || !planDigest.test(operationPlanDigest))
  )
    throw new Error('Cutover operation plan digest must be a SHA-256 digest.');
  if (admissionExpiresAt !== undefined && (!Number.isFinite(admissionExpiresAt) || admissionExpiresAt <= 0))
    throw new Error('Cutover admission deadline must be a positive timestamp.');
  const runner = uuid();
  const journal = await readJournal();
  let initial;
  assertCutoverJournal(journal, { release, namespace });
  const recovering = Boolean(journal && journal.phase !== 'complete');
  if (journal?.leaseExpiresAt > now())
    throw new Error('Another cutover runner still owns the operation. Wait for its lease to expire.');
  if (journal && journal.phase !== 'complete') {
    safety.assertRecovery(journal);
    if (
      resumeToken !== journal.token ||
      journal.manifestDigest !== manifestDigest ||
      journal.operationPlanDigest !== operationPlanDigest
    )
      throw new Error(
        `An unfinished cutover owns this release. Recover using --resume-cutover ${journal.token}, its exact manifest and operation plan.`,
      );
  } else {
    if (resumeToken) throw new Error('No unfinished cutover matches the recovery token.');
    const resources = checkedInventory(await inventory());
    // Offline rendering and live inventory may outlast the approval window.
    // Check at ownership acquisition, not just at the earlier plan preflight.
    // An exact unfinished operation above remains recoverable after expiry.
    if (admissionExpiresAt !== undefined && now() >= admissionExpiresAt)
      throw new Error('Cutover admission deadline expired; no workloads were changed.');
    const workloads = resources.workloads;
    initial = {
      formatVersion: 1,
      token: uuid(),
      release,
      namespace,
      manifestDigest,
      deploymentSafety: safetyIdentity.deploymentSafety,
      ...(operationPlanDigest === undefined ? {} : { operationPlanDigest }),
      ...(workflowIdentity ? { workflowIdentity } : {}),
      phase: 'quiescing',
      workloads,
      autoscalers: resources.autoscalers,
    };
  }

  const closeAdmission = async (operation) => {
    // Re-inventory by release label rather than trusting stale journal names.
    const current = checkedInventory(await inventory());
    for (const item of current.autoscalers) {
      operation.assertLease();
      await removeAutoscaler(item);
    }
    // Close ingress first; normal pod termination then drains accepted work.
    const ordered = [...current.workloads].sort(
      (a, b) => Number(!['proxy', 'web'].includes(a.component)) - Number(!['proxy', 'web'].includes(b.component)),
    );
    for (const item of ordered) {
      operation.assertLease();
      await scale(item, 0);
    }
  };

  let quiescenceAttempted = false;
  return runDeploymentOperation({
    name: 'Cutover',
    record: journal,
    initial,
    runner,
    resumeToken,
    safety,
    readJournal,
    saveJournal: (next, version) => (version ? replaceJournal(next, version) : createJournal(next)),
    now,
    setHeartbeat,
    clearHeartbeat,
    onFailure: async (error, operation) => {
      // Finish any in-flight renewal before inspecting or updating ownership.
      // Otherwise a late CAS can invalidate cleanup's resource version or phase.
      // No automatic rollback or resume. If final resume partly committed,
      // close admission again before handing control back to the operator.
      try {
        const owner = await operation.reloadOwned();
        assertCutoverJournal(owner, { release, namespace });
        if (owner.operationPlanDigest !== operationPlanDigest)
          throw new Error('Cutover ownership is no longer confirmed; no further workload mutations are allowed.');
        if (!quiescenceAttempted) {
          // A stale baseline is not a reason to stop another release. Only a
          // fresh, untouched attempt can release its journal as an aborted no-op;
          // recovery retains its unfinished history for explicit inspection.
          if (!recovering) {
            if (owner.phase !== 'quiescing') throw new Error('Untouched cutover phase changed.');
            await operation.complete({ abortedBeforeQuiescence: true });
          }
        } else {
          if (owner.phase === 'complete') {
            // The completion CAS may have committed while its acknowledgement was
            // lost. Closing traffic must also restore durable recovery ownership;
            // otherwise a normal rollout could mistake the now-paused release for
            // a completed cutover and an exact-token recovery would be rejected.
            await operation.checkpoint({ phase: 'resuming' });
          }
          await closeAdmission(operation);
        }
      } catch (closingError) {
        throw new AggregateError(
          [error, closingError],
          quiescenceAttempted
            ? `Cutover failed and closing admission is unconfirmed. Inspect journal token ${operation.record.token}.`
            : `Cutover failed and recovery ownership is unconfirmed. Inspect journal token ${operation.record.token}; no blind admission cleanup follows.`,
        );
      }
      const message = !quiescenceAttempted
        ? recovering
          ? `Cutover recovery baseline is unconfirmed; no workload mutations were attempted. Inspect journal token ${operation.record.token}.`
          : 'Cutover aborted before workload changes; obtain a fresh installed-version plan.'
        : `Cutover paused; no rollback was attempted. Recover with --resume-cutover ${operation.record.token}.`;
      throw new Error(message, {
        cause: error,
      });
    },
    run: async (operation) => {
      const { assertLease, step } = operation;
      const context = () => ({
        release,
        namespace,
        token: operation.record.token,
        runner: operation.record.runner,
        manifestDigest,
        ...(operationPlanDigest === undefined ? {} : { operationPlanDigest }),
        phase: operation.record.phase,
        leaseExpiresAt: operation.record.leaseExpiresAt,
        resourceVersion: operation.record.resourceVersion,
      });

      // Recovery always re-quiesces and reruns verify-only validation. It never
      // assumes that a lost Helm acknowledgement means nothing committed.
      await step('quiescing', async () => {
        await safety.checkOwnedBaseline(operation.record, runner, now);
        quiescenceAttempted = true;
        await closeAdmission(operation);
        await waitForStopped();
      });
      await step('quiesced', () => safety.checkpoint({ ...operation.record, ...context() }, runner, now));
      await step('validating', async () => {
        safety.assertReadyForTemplates();
        await installValidation();
      });
      await step('validating', validate);
      await step('resuming', async () => {
        if (stopValidationBeforeResume) {
          await closeAdmission(operation);
          await waitForStopped();
        }
        assertLease();
        await resume();
      });
      await step('resuming', async () => safety.confirmSettlement(await settle(context())));
      await operation.complete();
    },
  });
}
