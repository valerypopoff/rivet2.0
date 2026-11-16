import assert from 'node:assert/strict';
import { applyExecutionProfile, assertExecutionProfile, executionProfile } from './execution-profile.mjs';
import { autoscalerPolicyDigest, autoscalerPolicyFromConfig } from './execution-autoscaler.mjs';
import { qualificationExecutionBaseline } from './ha-release-evidence.mjs';
import { qualificationHash } from './runtime-qualification-execution.mjs';

/** Before observation, touch only the controller policy and upward replica
 * count. Reapplying the candidate chart here could prematurely update the old
 * application's templates. Each CAS write has its own read-back-only recovery. */
async function prepareRetainedTestCapacity(gate, profile) {
  const { operation, state } = gate;
  await gate.assertProofContext();
  let { record } = await state.read();
  assert.equal(record.testPhases?.prepare?.state, 'intent');
  const values = await gate.verifyRetainedInstallation(gate.currentManifest);
  assertExecutionProfile(values, profile);
  let pool = await gate.retainedExecutionPool(values);
  assert.deepEqual(
    { ...pool.controller.policy, minReplicas: operation.policy.minReplicas },
    operation.policy,
    'Retained controller policy changed beyond its idle floor',
  );
  if (!record.executionProfileTransitions?.prepare) {
    // Idle cleanup can release the application while the controller is still
    // stabilizing. Never change policy or replicas in the middle of that drain.
    // At its idle floor there is no further scale-in to race with preparation.
    const minimum = values.autoscaling.execution.minReplicas;
    assert.ok([1, 2].includes(minimum));
    assert.equal(pool.controller.policy.minReplicas, minimum, 'Retained idle policy differs from its saved values');
    await gate.waitRetainedExecutionProfile({
      uid: pool.uid,
      name: pool.name,
      idle: true,
      exactMinimum: true,
      minimum,
      manifest: gate.currentManifest,
      profile,
      after: Date.now(),
      policyDigest: autoscalerPolicyDigest({ ...operation.policy, minReplicas: minimum }),
    });
    const settled = await gate.retainedExecutionPool(values);
    assert.equal(settled.uid, pool.uid, 'Retained execution owner was replaced during idle settlement');
    pool = settled;
    await state.change((current) => {
      current.executionProfileTransitions ??= {};
      current.executionProfileTransitions.prepare = {
        uid: pool.uid,
        name: pool.name,
        startedAt: Date.now(),
        state: 'intent',
        steps: {},
      };
    });
  }
  const receipt = (await state.read()).record.executionProfileTransitions.prepare;
  assert.equal(receipt.uid, pool.uid, 'Retained execution owner was replaced');
  assert.equal(receipt.name, pool.name);
  for (const [key, kind, name, uid] of [
    ['controller', 'deployment', pool.controller.name, pool.controller.uid],
    ['workers', 'statefulset', pool.name, pool.uid],
  ]) {
    await gate.assertProofContext();
    const object = JSON.parse((await gate.kube(['get', kind, name, '-o', 'json'])).stdout);
    assert.equal(object.metadata.uid, uid);
    assert.ok(object.metadata.resourceVersion && !object.metadata.deletionTimestamp);
    let field = '/spec/replicas',
      before = object.spec.replicas,
      target = Math.max(before, qualificationExecutionBaseline(operation));
    if (key === 'controller') {
      const containers = object.spec.template.spec.containers;
      const container = containers.findIndex((item) => item.name === 'autoscaler');
      assert.ok(container >= 0);
      const env = containers[container].env.findIndex((item) => item.name === 'RIVET_AUTOSCALER_CONFIG');
      assert.ok(env >= 0 && !containers[container].env[env].valueFrom);
      before = containers[container].env[env].value;
      const config = JSON.parse(before);
      assert.equal(config.namespace, gate.config.namespace);
      assert.equal(config.release, gate.config.release);
      assert.equal(config.workload, pool.name);
      assert.equal(config.manifestDigest, values.release.production.manifestDigest);
      assert.equal(config.image, `${values.images.api.repository}@${values.images.api.digest}`);
      assert.deepEqual(
        { ...autoscalerPolicyFromConfig(config), minReplicas: operation.policy.minReplicas },
        operation.policy,
        'Retained controller policy changed beyond its idle floor',
      );
      const desired = { ...config, policy: { ...config.policy, minReplicas: operation.policy.minReplicas } };
      delete desired.stagingSingleExecution;
      target = JSON.stringify(desired);
      field = `/spec/template/spec/containers/${container}/env/${env}/value`;
    } else assert.ok(Number.isSafeInteger(before) && before >= 1 && before <= operation.policy.maxReplicas);
    record = (await state.read()).record;
    const intent = record.executionProfileTransitions.prepare.steps[key];
    if (intent) {
      assert.equal(intent.uid, uid, 'Retained preparation owner was replaced');
      assert.ok(
        key === 'workers' ? before >= intent.target : before === intent.target,
        'Uncertain retained preparation write is not confirmed; do not replay',
      );
      if (key === 'controller') assert.equal(intent.target, target);
    } else {
      await state.change((current) => {
        current.executionProfileTransitions.prepare.steps[key] = {
          uid,
          target,
          state: before === target ? 'observed' : 'intent',
        };
      });
      if (before !== target)
        await gate.kube([
          'patch',
          kind,
          name,
          '--type=json',
          '-p',
          JSON.stringify([
            { op: 'test', path: '/metadata/uid', value: uid },
            { op: 'test', path: '/metadata/resourceVersion', value: object.metadata.resourceVersion },
            { op: 'test', path: field, value: before },
            { op: 'replace', path: field, value: target },
          ]),
        ]);
    }
    await state.change((current) => {
      current.executionProfileTransitions.prepare.steps[key].state = 'acknowledged';
    });
  }
  const policyDigest = autoscalerPolicyDigest(operation.policy);
  await gate.waitRetainedExecutionProfile({
    uid: pool.uid,
    name: pool.name,
    idle: false,
    minimum: operation.policy.minReplicas,
    profile,
    policyDigest,
    after: receipt.startedAt,
  });
  await state.change((current) => {
    current.executionProfileTransitions.prepare.state = 'settled';
  });
}

/** Change only the retained application's idle/test floor, under its existing
 * operation owner. Helm never directly reduces replicas: the autoscaler drains
 * accepted work. An uncertain Helm write is observed, never replayed. */
export async function transitionRetainedExecutionProfile(gate, { idle }) {
  const operation = gate.operation;
  if (!operation.stagingExecutionProfile) return;
  const profile = executionProfile(operation.stagingExecutionProfile, { staging: true });
  if (!idle) return prepareRetainedTestCapacity(gate, profile);
  const state = gate.state;
  await gate.assertProofContext();
  let { record } = await state.read();
  assert.ok(record.closed && record.acceptedWorkSettled && record.phase === 'settled');
  let intent = record.executionProfileTransitions?.idle;
  const values = await gate.verifyRetainedInstallation(operation.candidate);
  assertExecutionProfile(values, profile);
  assert.equal(values.autoscaling.executionController?.enabled, true);
  assert.notEqual(values.autoscaling.executionController.suspended, true);
  const pool = await gate.retainedExecutionPool(values);
  const minimum = profile.minReplicas;
  if (!intent) {
    const target = applyExecutionProfile(values, profile);
    target.ha.rolloutResourceVersions = pool.versions;
    target.replicaCount = { ...target.replicaCount, ...pool.frontends };
    target.ha.stagingSingleExecution = minimum === 1;
    target.autoscaling.execution.minReplicas = minimum;
    target.replicaCount.execution = pool.replicas;
    target.workflowSchema = { ...target.workflowSchema, migrationJob: { enabled: false } };
    intent = {
      uid: pool.uid,
      name: pool.name,
      valuesDigest: qualificationHash(target),
      minimum,
      startedAt: Date.now(),
      state: 'intent',
    };
    await state.change((current) => {
      current.executionProfileTransitions ??= {};
      assert.ok(!current.executionProfileTransitions.idle);
      current.executionProfileTransitions.idle = intent;
    });
    // No application images/settings/template are changed by this transition.
    await gate.apply(target, 'retained-execution-idle.json');
    await state.change((current) => {
      current.executionProfileTransitions.idle.state = 'acknowledged';
    });
  } else {
    assert.equal(pool.uid, intent.uid, 'Retained execution owner was replaced');
    assert.equal(pool.name, intent.name);
    assert.equal(
      qualificationHash(values),
      intent.valuesDigest,
      'Uncertain retained profile write is not confirmed; do not replay',
    );
    assert.equal(intent.minimum, minimum);
  }
  // A successful command acknowledgement is not proof that its exact values
  // became the current deployed Helm revision. Check before waiting on a
  // controller that may otherwise still be running the previous policy.
  const deployed = await gate.verifyRetainedInstallation(operation.candidate);
  assert.equal(qualificationHash(deployed), intent.valuesDigest, 'Retained profile write is not confirmed');
  const policyDigest = autoscalerPolicyDigest({ ...operation.policy, minReplicas: minimum });
  await gate.waitRetainedExecutionProfile({
    uid: intent.uid,
    name: intent.name,
    idle,
    minimum,
    policyDigest,
    profile,
    after: intent.startedAt,
  });
  // Controller scaling does not edit Helm's values. Read back an acknowledged
  // write too, so an intervening operator change cannot acquire an idle receipt.
  const confirmed = await gate.verifyRetainedInstallation(operation.candidate);
  assert.equal(qualificationHash(confirmed), intent.valuesDigest, 'Retained profile values changed during settlement');
  await state.change((current) => {
    current.executionProfileTransitions.idle = { ...intent, state: 'settled', policyDigest };
  });
}
