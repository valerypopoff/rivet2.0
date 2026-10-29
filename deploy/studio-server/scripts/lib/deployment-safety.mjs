import { isDeepStrictEqual } from 'node:util';

const contracts = new WeakSet();
const modes = new Set(['rolling', 'maintenance', 'topology', 'direct', 'verification']);
const digest = /^sha256:[a-f0-9]{64}$/;
const text = (value) => typeof value === 'string' && value.length > 0;

/** Reverify only a completed topology's exact retained runtime, never grant a
 * general allowance for old revisions from an unrelated policy or namespace. */
export function retainedTopologyExecution(record, context, policyDigest) {
  const binding = record?.deploymentSafety;
  if (
    record?.phase !== 'complete' ||
    record.topologyProtocol !== 1 ||
    binding?.mode !== 'topology' ||
    binding.scope !== 'production' ||
    binding.release !== context.release ||
    binding.namespace !== context.namespace ||
    binding.namespaceUid !== context.namespaceUid ||
    binding.context !== context.context ||
    binding.manifestDigest !== context.candidateManifestDigest ||
    binding.workflowIdentity?.policyDigest !== policyDigest ||
    binding.workflowIdentity.valuesDigest !== context.valuesDigest ||
    !isDeepStrictEqual(binding.workflowIdentity, record.workflowIdentity)
  )
    return [];
  return structuredClone(record.runtime ?? []);
}

export function assertDeploymentBaseline(expected, installed, namespaceResource) {
  if (installed?.release?.production?.manifestDigest !== expected.installedManifestDigest)
    throw Error('Installed version changed during deployment preparation; obtain a fresh installed-version plan.');
  if (
    expected.namespaceUid &&
    (namespaceResource?.metadata?.uid !== expected.namespaceUid ||
      namespaceResource.metadata.name !== expected.namespace ||
      namespaceResource.metadata.deletionTimestamp)
  )
    throw Error('Deployment namespace identity changed or is terminating; no workload changes are allowed.');
}

export function deploymentRecoveryIdentity(
  journal,
  { resumeToken, policyDigest, valuesDigest, authorizationManifestDigest, adoptionStage },
) {
  const unfinished = Boolean(journal && journal.phase !== 'complete');
  if (!resumeToken && !unfinished) return null;
  if (!resumeToken || !unfinished || journal.token !== resumeToken)
    throw Error('Recover the exact unfinished deployment operation before running application checks or backups.');
  const identity = journal.workflowIdentity;
  if (
    identity?.policyDigest !== policyDigest ||
    identity.valuesDigest !== valuesDigest ||
    identity.authorizationManifestDigest !== authorizationManifestDigest ||
    identity.adoptionStage !== adoptionStage ||
    identity.beforeVerified !== true ||
    !text(identity.operationId) ||
    !digest.test(identity.installedManifestDigest ?? '')
  )
    throw Error('Recovery requires the original deployment policy, values and verified baseline identity.');
  return identity;
}

export function deploymentPreparationBinding(context, policyDigest, stage) {
  return Object.freeze({
    stage,
    policyDigest,
    operationId: context.operationId,
    namespaceUid: context.namespaceUid,
    release: context.release,
    namespace: context.namespace,
    context: context.context,
    valuesDigest: context.valuesDigest,
    installedManifestDigest: context.installedManifestDigest,
    candidateManifestDigest: context.candidateManifestDigest,
    ...(context.authorizationManifestDigest
      ? {
          authorizationManifestDigest: context.authorizationManifestDigest,
          adoptionStage: context.adoptionStage,
        }
      : {}),
  });
}

/** Prepared once by the deployment workflow, consumed by every mutation path.
 * Local/bootstrap scope is explicit; existing production requires verified
 * application/recovery evidence and an immutable installation-policy binding. */
export function createDeploymentSafety({
  mode,
  context,
  policyDigest,
  before,
  backup,
  checkBaseline,
  captureRecovery,
  scope = 'production',
  localIdentity,
}) {
  if (
    !modes.has(mode) ||
    !['production', 'local', 'bootstrap', 'rehearsal'].includes(scope) ||
    typeof checkBaseline !== 'function'
  )
    throw Error('Deployment safety requires an explicit mode, scope and live baseline checker.');
  const installation = context ?? localIdentity;
  if (
    !installation ||
    ![installation.release, installation.namespace, installation.context].every(text) ||
    !text(installation.candidateManifestDigest)
  )
    throw Error('Deployment safety installation identity is incomplete.');
  const production = scope === 'production';
  if (
    context?.authorizationManifestDigest &&
    (!digest.test(context.authorizationManifestDigest) || !['sizing', 'ownership'].includes(context.adoptionStage))
  )
    throw Error('Adoption safety requires an exact authorization manifest and stage.');
  if (!production && context)
    throw Error('A production workflow context cannot be admitted with a non-production safety scope.');
  if (
    production &&
    (!context ||
      !text(context.namespaceUid) ||
      !text(context.operationId) ||
      ![policyDigest, context.valuesDigest, context.installedManifestDigest, context.candidateManifestDigest].every(
        (v) => digest.test(v ?? ''),
      ) ||
      (!context.recovering &&
        (before?.verified !== true ||
          !isDeepStrictEqual(before.binding, deploymentPreparationBinding(context, policyDigest, 'before')))))
  )
    throw Error('Production safety requires the reviewed installation, inputs and verified application baseline.');
  if (
    production &&
    mode !== 'maintenance' &&
    mode !== 'verification' &&
    (backup?.verified !== true ||
      !isDeepStrictEqual(backup.binding, deploymentPreparationBinding(context, policyDigest, 'backup')))
  )
    throw Error('Production deployment requires verified online recovery before mutation.');
  if (mode === 'maintenance' && typeof captureRecovery !== 'function')
    throw Error('Maintenance safety requires an explicit quiesced recovery checkpoint.');

  const workflowIdentity = production
    ? Object.freeze({
        policyDigest,
        valuesDigest: context.valuesDigest,
        operationId: context.operationId,
        installedManifestDigest: context.installedManifestDigest,
        beforeVerified: true,
        ...(context.authorizationManifestDigest
          ? {
              authorizationManifestDigest: context.authorizationManifestDigest,
              adoptionStage: context.adoptionStage,
            }
          : {}),
      })
    : installation.workflowIdentity
      ? Object.freeze(structuredClone(installation.workflowIdentity))
      : undefined;
  const binding = Object.freeze({
    protocol: 1,
    mode,
    scope,
    release: installation.release,
    namespace: installation.namespace,
    context: installation.context,
    namespaceUid: installation.namespaceUid ?? null,
    manifestDigest: installation.candidateManifestDigest,
    ...(workflowIdentity ? { workflowIdentity } : {}),
  });
  let recoveryReady = mode !== 'maintenance';
  const preparedAt = Date.now();
  const assertIdentity = (identity) => {
    if (
      identity.release !== binding.release ||
      identity.namespace !== binding.namespace ||
      identity.manifestDigest !== binding.manifestDigest
    )
      throw Error('Deployment safety does not belong to this release, namespace or candidate.');
  };
  const assertOwned = (record, runner, now) => {
    assertIdentity(record);
    if (
      !isDeepStrictEqual(record.deploymentSafety, binding) ||
      !isDeepStrictEqual(record.workflowIdentity, workflowIdentity) ||
      record.runner !== runner ||
      !(record.leaseExpiresAt > now())
    )
      throw Error('Deployment safety ownership is unconfirmed; no further mutations are allowed.');
  };
  const safety = Object.freeze({
    binding,
    bind(identity) {
      assertIdentity(identity);
      return { ...identity, deploymentSafety: binding, ...(workflowIdentity ? { workflowIdentity } : {}) };
    },
    assertRecovery(record) {
      assertIdentity(record);
      if (
        !isDeepStrictEqual(record.deploymentSafety, binding) ||
        !isDeepStrictEqual(record.workflowIdentity, workflowIdentity)
      )
        throw Error('Recovery requires the original deployment safety contract, policy and inputs.');
    },
    checkBaseline,
    async checkOwnedBaseline(record, runner, now) {
      assertOwned(record, runner, now);
      await checkBaseline();
    },
    async checkpoint(record, runner, now) {
      assertOwned(record, runner, now);
      if (mode !== 'maintenance' || record.phase !== 'quiesced')
        throw Error('Recovery capture requires owned, quiesced maintenance.');
      const receipt = await captureRecovery(record);
      if (production && receipt?.verified !== true) throw Error('Maintenance recovery verification did not complete.');
      recoveryReady = true;
      return receipt;
    },
    assertReadyForTemplates() {
      if (!recoveryReady) throw Error('Verified quiesced recovery must precede template installation.');
    },
    requireSettlement(callback) {
      if (production && typeof callback !== 'function')
        throw Error(`Production ${mode} deployment requires owned release settlement.`);
      return callback ?? (async () => {});
    },
    confirmSettlement(receipt) {
      if (
        production &&
        (receipt?.settled !== true ||
          receipt.release !== binding.release ||
          receipt.namespace !== binding.namespace ||
          !Number.isFinite(Date.parse(receipt.observedAt)) ||
          Date.parse(receipt.observedAt) < preparedAt)
      )
        throw Error('A fresh verified release-settlement receipt is mandatory before operation completion.');
    },
  });
  contracts.add(safety);
  return safety;
}

export function requireDeploymentSafety(safety, mode, identity) {
  if (!safety || !contracts.has(safety) || safety.binding.mode !== mode)
    throw Error(`A prepared ${mode} deployment safety contract is mandatory.`);
  safety.bind(identity); // Reject a valid contract copied from another installation.
  return safety;
}
