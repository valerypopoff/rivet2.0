import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeploymentSafety,
  requireDeploymentSafety,
  deploymentPreparationBinding,
  retainedTopologyExecution,
  deploymentRecoveryIdentity,
} from './lib/deployment-safety.mjs';
import { runHaRollingUpgrade } from './lib/ha-rolling-upgrade.mjs';
import { runManagedReleaseCutover } from './lib/managed-release-cutover.mjs';
import { runHaControlTopologyTransition } from './lib/ha-control-topology.mjs';
import { runHaKubernetesRollout } from './lib/ha-kubernetes-rollout.mjs';
import { runHaKubernetesControlTopology } from './lib/ha-kubernetes-control-topology.mjs';
import { executeDeploymentWorkflow } from './lib/deployment-workflow.mjs';

const digest = (char) => `sha256:${char.repeat(64)}`;
const context = {
  release: 'rivet',
  namespace: 'fixture',
  context: 'fixture',
  namespaceUid: 'namespace-uid',
  operationId: 'operation',
  valuesDigest: digest('a'),
  installedManifestDigest: digest('b'),
  candidateManifestDigest: digest('c'),
};
const options = (mode) => ({
  mode,
  context,
  policyDigest: digest('d'),
  before: { verified: true, binding: deploymentPreparationBinding(context, digest('d'), 'before') },
  backup: { verified: true, binding: deploymentPreparationBinding(context, digest('d'), 'backup') },
  checkBaseline: async () => {},
});
const identity = {
  release: context.release,
  namespace: context.namespace,
  manifestDigest: context.candidateManifestDigest,
};

test('adoption preparation and recovery bind the exact candidate certificate and stage', () => {
  const ctx = { ...context, authorizationManifestDigest: digest('e'), adoptionStage: 'sizing' };
  const base = {
    ...options('rolling'),
    context: ctx,
    before: { verified: true, binding: deploymentPreparationBinding(ctx, digest('d'), 'before') },
    backup: { verified: true, binding: deploymentPreparationBinding(ctx, digest('d'), 'backup') },
  };
  const safety = createDeploymentSafety(base);
  const record = { ...safety.bind(identity), token: 'exact-token', phase: 'paused' };
  const recovery = {
    resumeToken: 'exact-token',
    policyDigest: digest('d'),
    valuesDigest: ctx.valuesDigest,
    authorizationManifestDigest: ctx.authorizationManifestDigest,
    adoptionStage: 'sizing',
  };
  assert.equal(deploymentRecoveryIdentity(record, recovery).adoptionStage, 'sizing');
  for (const patch of [
    { authorizationManifestDigest: undefined },
    { authorizationManifestDigest: digest('f') },
    { adoptionStage: 'ownership' },
  ])
    assert.throws(() => deploymentRecoveryIdentity(record, { ...recovery, ...patch }), /original deployment policy/);
  assert.throws(
    () => createDeploymentSafety({ ...base, context: { ...ctx, adoptionStage: undefined } }),
    /Adoption safety/,
  );
});

test('every rollout strategy and Kubernetes adapter rejects a missing contract before reading or mutating', async () => {
  for (const run of [
    runHaRollingUpgrade,
    runManagedReleaseCutover,
    runHaControlTopologyTransition,
    runHaKubernetesRollout,
    runHaKubernetesControlTopology,
  ]) {
    let touched = false;
    await assert.rejects(
      run({
        ...identity,
        identity,
        readJournal: async () => {
          touched = true;
        },
        kube: async () => {
          touched = true;
        },
      }),
      /safety contract is mandatory/,
    );
    assert.equal(touched, false);
  }
});

test('one contract validates production preparation and cannot be replaced with a structurally similar object', () => {
  for (const patch of [
    { checkBaseline: undefined },
    { before: undefined },
    { backup: { verified: false } },
    { context: { ...context, namespaceUid: '' } },
    { policyDigest: undefined },
  ])
    assert.throws(
      () => createDeploymentSafety({ ...options('rolling'), ...patch }),
      /safety requires|Production.*requires/,
    );
  const safety = createDeploymentSafety(options('rolling'));
  assert.equal(requireDeploymentSafety(safety, 'rolling', identity), safety);
  assert.throws(() => requireDeploymentSafety({ ...safety }, 'rolling', identity), /mandatory/);
  assert.throws(() => requireDeploymentSafety(safety, 'maintenance', identity), /mandatory/);
  assert.throws(() => createDeploymentSafety({ ...options('rolling'), scope: 'local' }), /non-production safety scope/);
  assert.throws(
    () => requireDeploymentSafety(safety, 'rolling', { ...identity, namespace: 'other' }),
    /does not belong/,
  );
});

test('production strategies reject missing settlement before any cluster access', async () => {
  for (const [run, mode] of [
    [runHaRollingUpgrade, 'rolling'],
    [runManagedReleaseCutover, 'maintenance'],
    [runHaControlTopologyTransition, 'topology'],
    [runHaKubernetesRollout, 'rolling'],
    [runHaKubernetesControlTopology, 'topology'],
  ]) {
    let touched = false;
    const access = async () => {
      touched = true;
      throw Error('unexpected cluster access');
    };
    await assert.rejects(
      run({
        ...identity,
        identity,
        safety: createDeploymentSafety({ ...options(mode), captureRecovery: async () => ({ verified: true }) }),
        readJournal: access,
        inventory: access,
        kube: access,
      }),
      /requires owned release settlement/,
    );
    assert.equal(touched, false);
  }
});

test('the production workflow cannot omit contract preparation before invoking any adapter or mutation', async () => {
  let touched = false;
  await assert.rejects(
    executeDeploymentWorkflow({
      context,
      stage: async () => {
        touched = true;
      },
      run: async () => {
        touched = true;
      },
    }),
    /safety-contract preparation step/,
  );
  assert.equal(touched, false);
});

test('the shared recovery and ownership checks bind all production strategies to the same policy and inputs', async () => {
  for (const mode of ['rolling', 'maintenance', 'topology']) {
    let checked = false;
    const safety = createDeploymentSafety({
      ...options(mode),
      checkBaseline: async () => {
        checked = true;
      },
      captureRecovery: async () => ({ verified: true }),
    });
    const record = { ...safety.bind(identity), runner: 'owner', leaseExpiresAt: 2000 };
    assert.doesNotThrow(() => safety.assertRecovery(record));
    const changedContext = { ...context, valuesDigest: digest('e') };
    const changed = createDeploymentSafety({
      ...options(mode),
      context: changedContext,
      before: { verified: true, binding: deploymentPreparationBinding(changedContext, digest('d'), 'before') },
      backup: { verified: true, binding: deploymentPreparationBinding(changedContext, digest('d'), 'backup') },
      captureRecovery: async () => ({ verified: true }),
    });
    assert.throws(() => changed.assertRecovery(record), /original deployment safety/);
    await assert.rejects(
      safety.checkOwnedBaseline(record, 'foreign', () => 1000),
      /ownership is unconfirmed/,
    );
    await assert.rejects(
      safety.checkOwnedBaseline(record, 'owner', () => 2000),
      /ownership is unconfirmed/,
    );
    assert.equal(checked, false);
    await safety.checkOwnedBaseline(record, 'owner', () => 1000);
    assert.equal(checked, true);
  }
});

test('verified preparation from another operation or stage cannot admit a deployment', () => {
  for (const stage of ['before', 'backup']) {
    const original = options('rolling');
    const receipt = {
      verified: true,
      binding: deploymentPreparationBinding({ ...context, operationId: 'other' }, digest('d'), stage),
    };
    assert.throws(() => createDeploymentSafety({ ...original, [stage]: receipt }), /Production.*requires/);
    assert.throws(
      () => createDeploymentSafety({ ...original, [stage]: original[stage === 'before' ? 'backup' : 'before'] }),
      /Production.*requires/,
    );
  }
});

test('maintenance cannot install templates before an owned, verified quiesced checkpoint', async () => {
  let captures = 0;
  const safety = createDeploymentSafety({
    ...options('maintenance'),
    captureRecovery: async () => {
      captures++;
      return { verified: true };
    },
  });
  const record = { ...safety.bind(identity), runner: 'owner', leaseExpiresAt: 2000, phase: 'quiescing' };
  assert.throws(safety.assertReadyForTemplates, /quiesced recovery must precede/);
  await assert.rejects(
    safety.checkpoint(record, 'owner', () => 1000),
    /owned, quiesced/,
  );
  assert.equal(captures, 0);
  await safety.checkpoint({ ...record, phase: 'quiesced' }, 'owner', () => 1000);
  assert.doesNotThrow(safety.assertReadyForTemplates);
  assert.equal(captures, 1);
});

test('an unverified quiesced capture never unlocks maintenance template installation', async () => {
  const safety = createDeploymentSafety({
    ...options('maintenance'),
    captureRecovery: async () => ({ verified: false }),
  });
  const record = { ...safety.bind(identity), runner: 'owner', leaseExpiresAt: 2000, phase: 'quiesced' };
  await assert.rejects(
    safety.checkpoint(record, 'owner', () => 1000),
    /verification did not complete/,
  );
  assert.throws(safety.assertReadyForTemplates, /quiesced recovery must precede/);
});

test('production topology requires owned settlement and re-verification retains only the exact completed binding', async () => {
  const safety = createDeploymentSafety(options('topology'));
  await assert.rejects(
    runHaKubernetesControlTopology({
      ...identity,
      safety,
      kube: async () => assert.fail('missing settlement must fail before cluster access'),
    }),
    /requires owned release settlement/,
  );
  const runtime = [{ name: 'execution', uid: 'owner', replicas: 2, revision: 'source', pods: ['one', 'two'] }];
  const record = { ...safety.bind(identity), phase: 'complete', topologyProtocol: 1, runtime };
  assert.deepEqual(retainedTopologyExecution(record, context, digest('d')), runtime);
  for (const changed of [
    { ...context, namespaceUid: 'other' },
    { ...context, candidateManifestDigest: digest('f') },
    { ...context, valuesDigest: digest('f') },
  ])
    assert.deepEqual(retainedTopologyExecution(record, changed, digest('d')), []);
  assert.deepEqual(retainedTopologyExecution({ ...record, phase: 'preflight' }, context, digest('d')), []);
  assert.deepEqual(retainedTopologyExecution(record, context, digest('f')), []);
});

test('production completion requires a fresh settlement receipt, not an optional no-op hook', () => {
  const safety = createDeploymentSafety(options('rolling'));
  for (const receipt of [
    undefined,
    { settled: true },
    { settled: true, release: 'other', namespace: context.namespace, observedAt: new Date().toISOString() },
    { settled: true, release: context.release, namespace: context.namespace, observedAt: '2000-01-01T00:00:00Z' },
  ])
    assert.throws(() => safety.confirmSettlement(receipt), /settlement receipt is mandatory/);
  assert.doesNotThrow(() =>
    safety.confirmSettlement({
      settled: true,
      release: context.release,
      namespace: context.namespace,
      observedAt: new Date().toISOString(),
    }),
  );
});
