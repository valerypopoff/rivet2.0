import assert from 'node:assert/strict';

const role = (resource) => resource.metadata.labels?.['app.kubernetes.io/component'];
const slot = (resource) => resource.metadata.labels?.['rivet.dev/execution-pool'];
function selectPool(resources, activeName, activeCount, retiringCount) {
  const sets = resources.filter((resource) => resource.kind === 'StatefulSet' && role(resource) === 'execution');
  const active = sets.find((set) => set.metadata.name === activeName);
  assert.ok(active && sets.length === 2);
  const controller = resources.find((resource) => resource.kind === 'Deployment' && role(resource) === 'autoscaler');
  const variable = controller.spec.template.spec.containers
    .find((container) => container.name === 'autoscaler')
    .env.find((entry) => entry.name === 'RIVET_AUTOSCALER_CONFIG');
  const config = JSON.parse(variable.value);
  for (const set of sets) set.spec.replicas = set === active ? activeCount : retiringCount;
  config.workload = active.metadata.name;
  variable.value = JSON.stringify(config);
  const service = resources.find(
    (resource) => resource.kind === 'Service' && resource.metadata.name === config.service,
  );
  assert.ok(service);
  service.metadata.annotations ??= {};
  service.metadata.annotations['rivet.dev/active-execution-workload'] = active.metadata.name;
  for (const resource of resources.filter(
    (resource) => resource.kind === 'Role' && resource.metadata.name === controller.metadata.name,
  ))
    for (const rule of resource.rules ?? []) {
      if (rule.resources?.includes('statefulsets/scale')) rule.resourceNames = [active.metadata.name];
      if (rule.resources?.includes('statefulsets') && rule.resourceNames)
        rule.resourceNames = [
          (rule.verbs.includes('patch') ? active : sets.find((set) => set !== active)).metadata.name,
        ];
      if (rule.resources?.includes('pods') && rule.resourceNames) {
        const target = rule.verbs.includes('patch') ? active : sets.find((set) => set !== active);
        rule.resourceNames = Array.from(
          { length: config.policy.maxReplicas + 1 },
          (_, index) => `${target.metadata.name}-${index}`,
        );
      }
    }
  return { active, config, slot: slot(active) };
}

/** The active slot, like HPA-grown capacity, is owned runtime state. Align only
 * that choice; final manifest comparison still checks all source-owned images,
 * settings, selectors, permissions, policy and templates without exceptions. */
export function alignSettledExecutionPoolResources(resources, installed) {
  const slots = resources.filter((resource) => resource.kind === 'StatefulSet' && slot(resource));
  if (!slots.length) return;
  assert.equal(slots.length, 2);
  const live = installed.filter((resource) => resource.kind === 'StatefulSet' && slot(resource));
  assert.equal(live.length, 2);
  assert.deepEqual(
    new Set(live.map((resource) => resource.metadata.name)),
    new Set(slots.map((resource) => resource.metadata.name)),
  );
  const active = live.filter((resource) => Number.isSafeInteger(resource.spec.replicas) && resource.spec.replicas >= 2);
  assert.equal(active.length, 1, 'Final execution pools must have one active slot');
  assert.equal(live.find((resource) => resource !== active[0]).spec.replicas, 0);
  const selected = selectPool(resources, active[0].metadata.name, active[0].spec.replicas, 0);
  assert.ok(active[0].spec.replicas <= selected.config.policy.maxReplicas);
}
export function prepareExecutionPoolResources({
  resources,
  inventory,
  journal,
  controlPlaneMode,
  allowTransition = true,
}) {
  const sets = resources.filter((resource) => resource.kind === 'StatefulSet' && role(resource) === 'execution');
  if (!sets.some(slot)) return null;
  assert.equal(typeof allowTransition, 'boolean');
  assert.equal(controlPlaneMode, 'singleton');
  assert.equal(sets.length, 2);
  assert.deepEqual(new Set(sets.map(slot)), new Set(['a', 'b']));
  assert.ok(
    inventory
      .filter((resource) => role(resource) === 'execution')
      .every((resource) => sets.some((desired) => desired.metadata.name === resource.metadata.name)),
    'Unexpected execution controller',
  );
  const controller = resources.find((resource) => resource.kind === 'Deployment' && role(resource) === 'autoscaler');
  const variable = controller?.spec.template.spec.containers
    .find((container) => container.name === 'autoscaler')
    ?.env.find((entry) => entry.name === 'RIVET_AUTOSCALER_CONFIG');
  assert.ok(variable, 'Paired execution requires its controller');
  const config = JSON.parse(variable.value);
  assert.deepEqual(new Set(config.poolWorkloads), new Set(sets.map((set) => set.metadata.name)));
  const installed = inventory.filter((resource) => role(resource) === 'execution' && resource.spec.replicas > 0);
  const recovering = journal && journal.phase !== 'complete';
  const saved = recovering ? journal.executionPoolPlan : null;
  if (!recovering) assert.equal(installed.length, 1, 'Execution pools require one settled active predecessor');
  const previous = saved ? inventory.find((resource) => resource.metadata.name === saved.previous.name) : installed[0];
  assert.ok(previous?.metadata.uid);
  const prior = sets.find((set) => set.metadata.name === previous.metadata.name);
  assert.ok(prior, 'Installed execution pool is outside the candidate chart');
  const other = sets.find((set) => set !== prior);
  const peer = inventory.find((set) => set.metadata.name === other.metadata.name);
  if (!recovering) assert.ok(!peer || peer.spec.replicas === 0, 'Inactive execution pool is not empty');
  const image = prior.spec.template.spec.containers.find((container) => container.name === 'api').image;
  const oldImage = previous.spec.template.spec.containers.find((container) => container.name === 'api').image;
  const eligible =
    allowTransition &&
    !recovering &&
    previous.spec.replicas === 2 &&
    config.policy.maxReplicas >= 4 &&
    !previous.spec.template.spec.volumes?.some((volume) => volume.persistentVolumeClaim) &&
    (image !== oldImage || !slot(previous));
  const plan =
    saved ??
    (eligible
      ? {
          protocol: 1,
          previous: { name: previous.metadata.name, uid: previous.metadata.uid, replicas: 2 },
          candidate: { name: other.metadata.name },
          image,
          maxReplicas: config.policy.maxReplicas,
        }
      : null);
  if (plan) {
    assert.equal(allowTransition, true, 'Parallel pool recovery requires its qualified transition');
    assert.equal(plan.protocol, 1);
    assert.equal(plan.previous.name, prior.metadata.name);
    assert.equal(plan.previous.replicas, 2);
    assert.equal(plan.candidate.name, other.metadata.name);
    assert.equal(plan.previous.uid, previous.metadata.uid);
    assert.equal(plan.image, image);
    assert.equal(plan.maxReplicas, config.policy.maxReplicas);
  }
  const active = plan ? other : prior;
  const selected = selectPool(resources, active.metadata.name, Math.max(2, previous.spec.replicas), plan ? 2 : 0);
  return { plan, previous, prior, other, peer, ...selected };
}
